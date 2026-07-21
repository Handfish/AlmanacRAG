import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

// ── Migration set 5 (Phase 5 / §16 M5) — the chat surface (architecture.md §5.5, §10) ──
// Three tables:
//
//   • chat_session — one row per conversation, holding the SINGLE-ACTIVE-RUN lock
//     (plan §10, effect-ai-chat's DB-enforced guard): a conditional
//     `UPDATE … SET active_run_id = $token WHERE active_run_id IS NULL RETURNING id`
//     lets exactly one request answer at a time per session; a crash is recovered by
//     clearing a stale token. Not in §5.5's list, but §5.5's `chat_message.session_id`
//     needs a home and the guard needs a lock column.
//   • chat_message — the transcript (§5.5). Stores `card_ids` (listing ids), NOT card
//     CONTENTS: replaying a three-week-old conversation re-hydrates live status and
//     fees, so the §1 guarantee applies retroactively (§5.5). `filter` is the echoed
//     chips; `trace_id` ties a message to its span (§12).
//   • feedback — a thumbs up/down per message, with `promoted_to_eval_item` closing the
//     loop (§5.5): a thumbs-down becomes a golden-set item becomes a regression test.
export default Effect.gen(function*() {
  const sql = yield* SqlClient;

  // ── chat_session (plan §10) — the single-active-run lock. `active_run_id` is a
  // per-request token; NULL means idle. UNIQUE nothing else — the session id is
  // client-supplied (a uuid), created on first use.
  yield* sql`
    CREATE TABLE IF NOT EXISTS chat_session (
      id             uuid PRIMARY KEY,
      active_run_id  text,
      created_at     timestamptz NOT NULL DEFAULT now(),
      last_active_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  // ── chat_message (§5.5). `card_ids` are listing ids (re-hydrated on replay, never
  // frozen); `filter` is the echoed ListingFilter wire form; `role` is 'user' | 'assistant'.
  yield* sql`
    CREATE TABLE IF NOT EXISTS chat_message (
      id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      session_id uuid NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
      role       text NOT NULL CHECK (role IN ('user','assistant')),
      prose      text,
      card_ids   bigint[] NOT NULL DEFAULT '{}',
      filter     jsonb,
      refused    boolean NOT NULL DEFAULT false,
      trace_id   text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS chat_message_session_idx
      ON chat_message (session_id, created_at)
  `;

  // ── feedback (§5.5). One rating per message; `promoted_to_eval_item` is the
  // feedback→eval promotion (§5.5), populated by the Phase-6 surface.
  yield* sql`
    CREATE TABLE IF NOT EXISTS feedback (
      message_id            bigint PRIMARY KEY REFERENCES chat_message(id) ON DELETE CASCADE,
      rating                smallint NOT NULL CHECK (rating IN (-1, 1)),
      note                  text,
      promoted_to_eval_item bigint REFERENCES eval_item(id),
      created_at            timestamptz NOT NULL DEFAULT now()
    )
  `;

  yield* sql`
    UPDATE app_meta SET value = '5', updated_at = now() WHERE key = 'schema_phase'
  `;
});
