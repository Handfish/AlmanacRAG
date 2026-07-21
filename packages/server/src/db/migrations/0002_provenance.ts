import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

// ── Migration set 1 (Phase 1 / §16 M1) ───────────────────────────────────────
// The irreversible one. This is where the clock starts (§5.3). It:
//   1. installs pgvector (extensions live in the first migration — plan §5.4/§7;
//      Phase 1 stores no vectors, but DDL is centralized on SqlAdmin here),
//   2. adopts-and-extends the provenance table `cecc_course_index_course_listing`
//      (§5.1) — the base shape is created IF NOT EXISTS so a greenfield DB works,
//      then the additive columns land as ADD COLUMN IF NOT EXISTS so the same
//      migration also runs against the production crawler DB untouched,
//   3. adds the blocking-gap columns — `raw_markdown` (+ `raw_html`), segmented
//      `course_hash`/`listing_hash`, conditional-GET meta, and the retention
//      trio `first_seen_at`/`last_seen_at`/`disappeared_at` (§2.2, §5.1, §5.3.1),
//   4. captures the "More offerings like this" target as `group_url` (§5.2.6 /
//      §6.1.2) — grouping ground truth, followed at crawl time,
//   5. creates `page_snapshot` (§5.3.3), `crawl_run` (§6.2), `system_epoch`
//      (§5.3.4).
//
// Hashes are `bytea` per §5.1; the ingest repos write them via `decode($, 'hex')`
// and read them back via `encode(col, 'hex')`.
export default Effect.gen(function*() {
  const sql = yield* SqlClient;

  // 1 ── pgvector. Phase 3 adds halfvec columns (ADR-004); the extension is
  // installed now so all DDL stays on this SqlAdmin path.
  yield* sql`CREATE EXTENSION IF NOT EXISTS vector`;

  // 2 ── the provenance table. `IF NOT EXISTS` = adopt the production table when
  // present, create it when greenfield. Columns mirror the crawler's Drizzle
  // schema field-for-field (§5.1); the greenfield default `gen_random_uuid()`
  // only affects rows we insert — production ids are app-supplied and untouched.
  yield* sql`
    CREATE TABLE IF NOT EXISTS cecc_course_index_course_listing (
      id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      url                     text UNIQUE,
      content_hash            text,
      last_hash_comparison_at timestamptz,
      updated_at              timestamptz,
      created_at              timestamptz DEFAULT now(),
      school                  text,
      cecc_unit               text,
      program                 text,
      root_url                text,
      course_title            text,
      description             text,
      course_data             jsonb DEFAULT '{}'::jsonb
    )
  `;

  // 3 + 4 ── the additive columns (§5.1 ALTERs, retention §5.3.1, grouping §5.2.6).
  //
  // `page_fields` is a Phase-1 extra beyond the §5.1 list: a DETERMINISTIC (no-AI)
  // mirror of the detail page's label/value table — status, section id, session,
  // dates, instructor, location, prerequisites, audience, fees — captured as
  // queryable jsonb so retrieval/analytics can use it before M2's typed
  // extraction lands. Faithful, not normalized; `course_data` (the legacy
  // crawler's partial capture) is left untouched so §2.1's family analysis and
  // the §17 Q2 check still read the original signal.
  yield* sql`
    ALTER TABLE cecc_course_index_course_listing
      ADD COLUMN IF NOT EXISTS raw_markdown       text,
      ADD COLUMN IF NOT EXISTS raw_html           text,
      ADD COLUMN IF NOT EXISTS page_fields        jsonb,
      ADD COLUMN IF NOT EXISTS course_hash        bytea,
      ADD COLUMN IF NOT EXISTS listing_hash       bytea,
      ADD COLUMN IF NOT EXISTS http_status        smallint,
      ADD COLUMN IF NOT EXISTS etag               text,
      ADD COLUMN IF NOT EXISTS http_last_modified timestamptz,
      ADD COLUMN IF NOT EXISTS group_url          text,
      ADD COLUMN IF NOT EXISTS first_seen_at      timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS last_seen_at       timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS disappeared_at     timestamptz
  `;

  // Live-page filter (the page-level analogue of §5.3.1's listing_live_idx) and a
  // sweep-support index on the observation timestamp.
  yield* sql`
    CREATE INDEX IF NOT EXISTS source_page_live_idx
      ON cecc_course_index_course_listing (last_seen_at)
      WHERE disappeared_at IS NULL
  `;

  // 5 ── page_snapshot (§5.3.3). Keyed on the content hash, so an unchanged page
  // writes nothing; only distinct content is ever stored. Re-extraction (M2) can
  // replay last year's pages from here — the past cannot be re-crawled.
  yield* sql`
    CREATE TABLE IF NOT EXISTS page_snapshot (
      source_page_id uuid NOT NULL
        REFERENCES cecc_course_index_course_listing(id) ON DELETE CASCADE,
      content_hash   bytea NOT NULL,
      raw_markdown   text NOT NULL,
      first_seen_at  timestamptz NOT NULL DEFAULT now(),
      last_seen_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (source_page_id, content_hash)
    )
  `;

  // 5 ── crawl_run (§6.2). The sweep gate reads pages_seen + status from here; a
  // crash mid-crawl leaves a 'running' row and resume is a query over which URLs
  // this run has not yet observed (ADR-I6 table-driven resume, decision D6).
  yield* sql`
    CREATE TABLE IF NOT EXISTS crawl_run (
      id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      started_at  timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      pages_seen  integer,
      status      text NOT NULL CHECK (status IN ('running','ok','failed','aborted')),
      swept       boolean NOT NULL DEFAULT false
    )
  `;

  // 5 ── system_epoch (§5.3.4). One row. Records when observation began so §10.6
  // can refuse temporal claims the window can't support. terms_observed stays 0
  // until Phase 7 counts distinct observed terms.
  yield* sql`
    CREATE TABLE IF NOT EXISTS system_epoch (
      id              smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      observing_since timestamptz NOT NULL,
      terms_observed  smallint NOT NULL DEFAULT 0
    )
  `;

  yield* sql`
    UPDATE app_meta SET value = '1', updated_at = now() WHERE key = 'schema_phase'
  `;
});
