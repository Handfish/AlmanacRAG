import type { Answer } from "@catalog/domain/answer";
import type { Card } from "@catalog/domain/answer";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { canonicalFilter } from "../../eval/filter-compare.js";

// The chat transcript + single-active-run guard (§5.5, §10). Persists the conversation
// as `card_ids` (never card contents — replay re-hydrates live, §5.5) and enforces one
// in-flight answer per session with a DB-level conditional UPDATE (plan §10). Ids are
// bigints; the whole `{…}` array binds as one parameter (codebase convention).

const pgIntArray = (ids: ReadonlyArray<string>): string =>
  `{${ids.filter((id) => /^\d+$/.test(id)).join(",")}}`;

/** Ensure the session row exists (idempotent). Called before acquiring the lock. */
export const ensureSession = (sessionId: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    yield* sql`
      INSERT INTO chat_session (id) VALUES (${sessionId})
      ON CONFLICT (id) DO NOTHING
    `;
  });

/**
 * Try to acquire the single-active-run lock for a session (plan §10 / effect-ai-chat
 * `chat-repo.ts:98`). The conditional `UPDATE … WHERE active_run_id IS NULL RETURNING id`
 * succeeds for exactly one concurrent caller; `Option.isSome` is "I hold the lock". A
 * second concurrent request for the same session gets `None` and must back off.
 */
export const acquireRun = (sessionId: string, runToken: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ id: string; }>`
      UPDATE chat_session
      SET active_run_id = ${runToken}, last_active_at = now()
      WHERE id = ${sessionId} AND active_run_id IS NULL
      RETURNING id::text AS id
    `;
    return rows.length > 0 ? Option.some(sessionId) : Option.none<string>();
  });

/** Release the lock — only if this caller still holds it (guards against clobbering a
 * lock a crash-recovery reclaimed). Safe to call in a release finalizer. */
export const releaseRun = (sessionId: string, runToken: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    yield* sql`
      UPDATE chat_session SET active_run_id = NULL
      WHERE id = ${sessionId} AND active_run_id = ${runToken}
    `;
  });

/** Persist a user turn. */
export const insertUserMessage = (sessionId: string, prose: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ id: string; }>`
      INSERT INTO chat_message (session_id, role, prose)
      VALUES (${sessionId}, 'user', ${prose})
      RETURNING id::text AS id
    `;
    return rows[0]!.id;
  });

/** Persist an assistant turn as `card_ids` + echoed filter + refusal flag + trace id —
 * NOT the hydrated card contents (§5.5). Returns the new message id. */
export const insertAssistantMessage = (
  sessionId: string,
  answer: Answer,
  cards: ReadonlyArray<Card>,
  refused: boolean,
  traceId: string | null,
) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const cardIds = cards.map((c) => c.listingId as string);
    const filterJson = canonicalFilter(answer.filter) || null;
    const rows = yield* sql<{ id: string; }>`
      INSERT INTO chat_message (session_id, role, prose, card_ids, filter, refused, trace_id)
      VALUES (
        ${sessionId}, 'assistant', ${answer.prose},
        ${pgIntArray(cardIds)}::bigint[], ${filterJson}::jsonb, ${refused}, ${traceId}
      )
      RETURNING id::text AS id
    `;
    return rows[0]!.id;
  });

/** Record thumbs up/down on a message (§5.5). `promoted_to_eval_item` is set separately
 * by `promoteFeedbackToEval` when a thumbs-down arrives (the Phase-6 promotion loop). */
export const insertFeedback = (messageId: string, rating: 1 | -1, note: string | null) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    yield* sql`
      INSERT INTO feedback (message_id, rating, note)
      VALUES (${messageId}, ${rating}, ${note})
      ON CONFLICT (message_id) DO UPDATE SET rating = EXCLUDED.rating, note = EXCLUDED.note
    `;
  });

// ── feedback → eval promotion (§5.5) ──────────────────────────────────────────────
// "A thumbs-down becomes a golden-set item becomes a regression test" (§5.5). A negative
// rating on an ASSISTANT turn promotes the USER's preceding question into `eval_item` as
// a CANDIDATE — reviewed_by/reviewed_at stay NULL, which is the convention that keeps it
// OUT of the graded golden set (the runner and the seed both scope to `reviewed_at IS NOT
// NULL`, so a raw candidate can never move the §11.4 gate). A human curates it — labels
// `expected_filter`/`expected_ids`, sets `reviewed_at` — to admit it. `shape` is inferred
// from what the turn actually did (refused → unanswerable; a filter → filtered; else
// lookup); the reviewer corrects it. `feedback.promoted_to_eval_item` closes the loop and
// makes promotion idempotent (a second thumbs-down on the same message is a no-op).

interface PromotableMessage {
  readonly question: string;
  readonly refused: boolean;
  readonly hasFilter: boolean;
}

/** The user question a thumbs-down refers to, plus the assistant turn's own signals. The
 * question is the newest `user` message BEFORE this assistant message in the session. */
const loadPromotable = (messageId: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ question: string; refused: boolean; hasFilter: boolean; }>`
      SELECT u.prose AS question, a.refused, (a.filter IS NOT NULL) AS has_filter
      FROM chat_message a
      JOIN chat_message u
        ON u.session_id = a.session_id AND u.role = 'user' AND u.id < a.id
      WHERE a.id = ${messageId} AND a.role = 'assistant'
      ORDER BY u.id DESC
      LIMIT 1
    `;
    const r = rows[0];
    return r === undefined
      ? Option.none<PromotableMessage>()
      : Option.some<PromotableMessage>({
        question: r.question,
        refused: r.refused,
        hasFilter: r.hasFilter,
      });
  });

const inferShape = (m: PromotableMessage): string =>
  m.refused ? "unanswerable" : m.hasFilter ? "filtered" : "lookup";

/**
 * Promote a thumbs-down message's question to a candidate `eval_item` (§5.5) and record
 * the promotion on the `feedback` row. Idempotent and safe to call unconditionally after
 * a negative rating: returns the eval_item id if a new (or existing) candidate is linked,
 * `None` if the message has no answerable question to promote. A `note` becomes the item's
 * `rubric` (what the reviewer should check). Never touches the graded golden set.
 */
export const promoteFeedbackToEval = (messageId: string, note: string | null) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const promotable = yield* loadPromotable(messageId);
    if (Option.isNone(promotable)) return Option.none<string>();
    const m = promotable.value;

    // Insert (or find) the candidate item by its natural key (question). reviewed_* NULL
    // ⇒ candidate: excluded from the runner and from the seed's reconcile sweep.
    const inserted = yield* sql<{ id: string; }>`
      INSERT INTO eval_item (question, shape, rubric)
      VALUES (${m.question}, ${inferShape(m)}, ${note})
      ON CONFLICT (question) DO NOTHING
      RETURNING id::text AS id
    `;
    const itemId = inserted[0]?.id
      ?? (yield* sql<{ id: string; }>`
        SELECT id::text AS id FROM eval_item WHERE question = ${m.question}`)[0]?.id;
    if (itemId === undefined) return Option.none<string>();

    yield* sql`
      UPDATE feedback SET promoted_to_eval_item = ${itemId}
      WHERE message_id = ${messageId}
    `;
    return Option.some(itemId);
  });
