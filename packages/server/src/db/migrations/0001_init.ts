import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

// Phase-0 spine migration. Proves the PgMigrator runner + SqlAdmin DDL path end
// to end. `app_meta` is a tiny forward-compatible key/value table (schema-version
// tracking); Phase 1 (migration set 1, plan §7) adds the real provenance schema:
// CREATE EXTENSION vector, the `cecc_course_index_course_listing` ALTERs,
// `page_snapshot`, `crawl_run`, `system_epoch`.
export default Effect.gen(function*() {
  const sql = yield* SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS app_meta (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  yield* sql`
    INSERT INTO app_meta (key, value)
    VALUES ('schema_phase', '0')
    ON CONFLICT (key) DO NOTHING
  `;
});
