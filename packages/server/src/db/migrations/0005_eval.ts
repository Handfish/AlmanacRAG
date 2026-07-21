import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

// ── Migration set 4 (Phase 4 / §16 M4) — the eval harness (architecture.md §5.5, §11) ──
// "Building the harness fourth rather than last is itself the engineering signal"
// (ADR-009: eval before the chat UI). Three tables:
//
//   • eval_item   — the golden set (§11.1). 150–200 items, stratified by SHAPE and by
//     field-presence band, with directly-labelable ground truth: `expected_filter`
//     (the §11.2 headline `filter_exact` target) and `expected_ids` (the retrieval
//     target for nDCG@10 / recall@10 / MRR). An item with empty `expected_ids` AND
//     null `expected_filter` is one whose correct answer is a REFUSAL (§10.6) — the
//     `unanswerable` slice and the "I don't know yet" tail of `temporal` (§11.1).
//   • eval_run    — one row per harness invocation. `config` is jsonb so any two runs
//     diff (the §11.5 ablation knobs, plus `today` and `terms_observed` so an old run
//     stays interpretable as the observation window grows, §11.1).
//   • eval_result — per (run, item) scores. `filter_exact` is the headline; the
//     retrieval trio and the refusal/latency/cost columns are the rest of §11.2.
//     `prose_faithful` stays NULL until Phase 5 wires the LlmJudge over real prose.
//
// `expected_ids` / `retrieved_ids` are COURSE ids (bigint[]): retrieval is scored on
// the course ranking (search_catalog fuses to course_id; a filter's listings collapse
// to their distinct courses), and 10-of-868 keeps recall@10/nDCG@10 meaningful (§11.2).
export default Effect.gen(function*() {
  const sql = yield* SqlClient;

  // ── eval_item (§5.5, §11.1) — the golden set. UNIQUE(question) makes the seed
  // idempotent (re-seeding upserts the ground truth as the corpus drifts). `shape` is
  // the CHECK-guarded stratification; `expected_filter` is the encoded ListingFilter
  // wire form (dates as ISO strings) so `filter_exact` compares canonical JSON.
  yield* sql`
    CREATE TABLE IF NOT EXISTS eval_item (
      id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      question        text NOT NULL UNIQUE,
      shape           text NOT NULL CHECK (shape IN
                        ('lookup','filtered','availability','comparative',
                         'eligibility','temporal','unanswerable')),
      band            text,
      expected_filter jsonb,
      expected_ids    bigint[] NOT NULL DEFAULT '{}',
      rubric          text,
      reviewed_by     text,
      reviewed_at     timestamptz
    )
  `;

  // ── eval_run (§5.5, §11.3) — one row per pass. git_sha + config make it a diffable
  // build artifact; the CI gate (§11.4) reads the latest finished run.
  yield* sql`
    CREATE TABLE IF NOT EXISTS eval_run (
      id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      git_sha     text NOT NULL,
      config      jsonb NOT NULL,
      started_at  timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz
    )
  `;

  // ── eval_result (§5.5, §11.2) — the scores. Retrieval metrics are NULL when the
  // item has no relevant set (a refusal item), so an aggregate isn't polluted by an
  // undefined nDCG. `refused` is the router's §10.6 signal; `expected_refuse` is
  // derived, not stored (an item is a refusal iff it has no expected ids and no filter).
  yield* sql`
    CREATE TABLE IF NOT EXISTS eval_result (
      run_id         bigint NOT NULL REFERENCES eval_run(id) ON DELETE CASCADE,
      item_id        bigint NOT NULL REFERENCES eval_item(id),
      actual_filter  jsonb,
      filter_exact   boolean,
      retrieved_ids  bigint[] NOT NULL DEFAULT '{}',
      ndcg_10        real,
      recall_at_10   real,
      mrr            real,
      prose_faithful boolean,
      refused        boolean,
      latency_ms     integer,
      cost_micros    integer,
      PRIMARY KEY (run_id, item_id)
    )
  `;

  yield* sql`
    UPDATE app_meta SET value = '4', updated_at = now() WHERE key = 'schema_phase'
  `;
});
