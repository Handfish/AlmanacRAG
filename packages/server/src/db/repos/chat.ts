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

/** Record thumbs up/down on a message (§5.5). `promoted_to_eval_item` is set later by
 * the Phase-6 feedback→eval promotion. */
export const insertFeedback = (messageId: string, rating: 1 | -1, note: string | null) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    yield* sql`
      INSERT INTO feedback (message_id, rating, note)
      VALUES (${messageId}, ${rating}, ${note})
      ON CONFLICT (message_id) DO UPDATE SET rating = EXCLUDED.rating, note = EXCLUDED.note
    `;
  });
