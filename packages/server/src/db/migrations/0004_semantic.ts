import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

// ── Migration set 3 (Phase 3 / §16 M3) — the semantic layer (architecture.md §5.4) ──
// The retrieval substrate. Chunks hang off `course` ONLY: listings carry no free text
// worth embedding — every fact on them is a typed column and belongs to
// `filter_listings` (§5.4). At ~180 words a description is already chunk-sized, so
// `ord` starts at 0 and exists for the day that stops being true (§17.4).
//
// `chunk_embedding` is deliberately UNINDEXED (ADR-004): at ~732 courses the whole
// vector set is a couple of MB and an exact sequential scan beats HNSW at 100% recall
// with no build step, no `ef_search` tuning, no overfiltering. `model_id` is in the
// PK so multiple embedding models coexist per chunk — A/B is `WHERE model_id = N`,
// not a destructive reindex (§5.4, §11.5). `halfvec` is unsized on purpose so models
// of different dimensionality (768 / 1536 / 3072) share the column.
export default Effect.gen(function*() {
  const sql = yield* SqlClient;

  // ── chunk (§5.4). One row per course (ord=0). `tsv` is a STORED generated column
  // over context_prefix + text so the BM25 half of the hybrid query (§7.2) needs no
  // application-side upkeep; the gin index makes `@@` fast. `context_prefix` is the
  // §7.3 situating sentence, prepended for BOTH the embedding and the tsv.
  yield* sql`
    CREATE TABLE IF NOT EXISTS chunk (
      id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      course_id      bigint NOT NULL REFERENCES course(id) ON DELETE CASCADE,
      ord            smallint NOT NULL DEFAULT 0,
      context_prefix text,
      text           text NOT NULL,
      token_count    smallint NOT NULL,
      tsv tsvector GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(context_prefix, '') || ' ' || text)
      ) STORED,
      UNIQUE (course_id, ord)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS chunk_tsv_idx ON chunk USING gin (tsv)`;

  // ── chunk_embedding (§5.4). No vector index — ADR-004. The vector half of §7.2
  // casts the query to `halfvec` and scans exactly. Cosine distance (`<=>`).
  yield* sql`
    CREATE TABLE IF NOT EXISTS chunk_embedding (
      chunk_id  bigint NOT NULL REFERENCES chunk(id) ON DELETE CASCADE,
      model_id  smallint NOT NULL REFERENCES model(id),
      embedding halfvec NOT NULL,
      PRIMARY KEY (chunk_id, model_id)
    )
  `;

  yield* sql`
    UPDATE app_meta SET value = '3', updated_at = now() WHERE key = 'schema_phase'
  `;
});
