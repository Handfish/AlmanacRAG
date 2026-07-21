import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

// ── Migration set 2 (Phase 2 / §16 M2) — the typed layer ─────────────────────
// The tables the Anthropic extractor writes into (§5.2, §5.5). Everything here is
// derived from `raw_markdown` + the deterministic `page_fields` (Phase 1) and
// decoded through Effect Schema before it lands, so a value outside a closed enum
// is a typed `extraction.status = 'schema_error'` row, never a silent null.
//
// Corrected against the REAL 995-page corpus (docs/real-data-findings-1.md), which
// diverges from §5.2's ALT10 close-read:
//   • No template families — `course_data` is empty on all 995; the extractor is one
//     schema over one template. `course.template_family` / `extraction.family` DROPPED.
//   • Course identity is the "More offerings like this" grouping (couID / `group_url`,
//     §5.2.6): 732 distinct across 995 sections. `course.group_url` is the natural key;
//     `external_course_id` is a messy, verified attribute (NOT unique).
//   • `unit_id` is NULLABLE — `cecc_unit` is null everywhere and refund/cancellation
//     policies are per-page, not per-unit.
//   • Term is derived from the `dates` field's start month, not from `session`
//     (a year / year-range / cohort suffix in the real data).
//   • `listing_fee` PK is (listing_id, ord) — real fee labels are not unique per page.
export default Effect.gen(function*() {
  const sql = yield* SqlClient;

  // ── unit (§5.2.1). Kept, but sparse: `cecc_unit` is null across the real corpus,
  // so most courses carry a NULL unit_id until units are inferred (by clustering
  // distinct policy/contact tuples) in a later pass. Answers "what's the refund
  // policy / who do I contact?" once populated.
  yield* sql`
    CREATE TABLE IF NOT EXISTS unit (
      id                        smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name                      text NOT NULL UNIQUE,
      school                    text,
      contact_email             text,
      refund_policy             text,
      cancellation_policy       text,
      registration_instructions text
    )
  `;

  // ── model (§5.4). The semantic-layer registry; Phase 2 uses only the extraction
  // LLM row (kind='llm'), ensured at runtime by the persistence layer (the model
  // name is EXTRACTION_MODEL config, not a fixed seed). Phase 3 adds embedding rows.
  yield* sql`
    CREATE TABLE IF NOT EXISTS model (
      id         smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      name       text NOT NULL UNIQUE,
      kind       text NOT NULL CHECK (kind IN ('embedding','llm','reranker')),
      dimensions smallint
    )
  `;

  // ── course (§5.2.2). Keyed on `group_url` (the couID grouping — authoritative
  // course identity, §5.2.6). `external_course_id` is a verified attribute, not a
  // key (real values are messy: PP-2216, RootsRockRoll-, Leadership, 520024).
  // track/contact_hours/subject are parsed out of the title (§9.2 facts-in-title).
  yield* sql`
    CREATE TABLE IF NOT EXISTS course (
      id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      unit_id                smallint REFERENCES unit(id),
      group_url              text UNIQUE,
      external_course_id     text,
      course_title           text NOT NULL,
      title_normalized       text NOT NULL,
      track                  text,
      contact_hours          numeric(5,1),
      subject                text,
      program                text,
      description            text,
      audience               text,
      prerequisite_text      text,
      registration_keyword   text,
      refund_policy_override text,
      first_seen_at          timestamptz NOT NULL DEFAULT now(),
      last_seen_at           timestamptz NOT NULL DEFAULT now()
    )
  `;
  // Fallback identity for the rare course with no couID grouping (§5.2.2).
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS course_fallback_key
      ON course (title_normalized) WHERE group_url IS NULL
  `;

  // ── extraction (§5.5). One provenance row per extract attempt — the guarantee
  // that a parse failure is TYPED (status='schema_error'), not a silent null.
  // Dropped `segment`/`family`: one LLM call yields the whole ExtractedCourse.
  yield* sql`
    CREATE TABLE IF NOT EXISTS extraction (
      id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      source_page_id uuid NOT NULL
        REFERENCES cecc_course_index_course_listing(id) ON DELETE CASCADE,
      crawl_run_id   bigint REFERENCES crawl_run(id),
      model_id       smallint NOT NULL REFERENCES model(id),
      prompt_version text NOT NULL,
      status         text NOT NULL CHECK (status IN ('ok','schema_error','refused','timeout')),
      raw_json       jsonb,
      error          text,
      input_tokens   integer,
      output_tokens  integer,
      created_at     timestamptz NOT NULL DEFAULT now()
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS extraction_page_idx
      ON extraction (source_page_id, created_at DESC)
  `;

  // ── listing (§5.2.3). One row per crawled page (source_page_id is the natural
  // key — one section per page). term_* are DERIVED from `dates` (real `session`
  // has no season); term_rank sorts terms chronologically (§5.3). Retention trio
  // mirrors §5.3.1.
  yield* sql`
    CREATE TABLE IF NOT EXISTS listing (
      id                         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      source_page_id             uuid NOT NULL UNIQUE
        REFERENCES cecc_course_index_course_listing(id),
      extraction_id              bigint NOT NULL REFERENCES extraction(id),
      course_id                  bigint NOT NULL REFERENCES course(id) ON DELETE CASCADE,
      external_section_id        text,
      session_label              text,
      term                       text,
      term_year                  smallint,
      term_season                text CHECK (term_season IN ('Winter','Spring','Summer','Fall')),
      term_rank                  integer GENERATED ALWAYS AS (
                                   coalesce(term_year, 0) * 10 + CASE term_season
                                     WHEN 'Winter' THEN 1 WHEN 'Spring' THEN 2
                                     WHEN 'Summer' THEN 3 WHEN 'Fall' THEN 4 ELSE 0 END
                                 ) STORED,
      starts_on                  date,
      ends_on                    date,
      schedule_text              text,
      is_evening                 boolean,
      registration_deadline      date,
      registration_deadline_rule text,
      format_text                text,
      format_category            text,
      format_platform            text,
      delivery_mode              text CHECK (delivery_mode IN
                                   ('in_person','online_sync','online_async','hybrid','unknown')),
      location_text              text,
      location_site              text,
      location_room              text,
      campus                     text CHECK (campus IN
                                   ('New Brunswick','Newark','Camden','Online','Other','unknown')),
      status                     text NOT NULL CHECK (status IN
                                   ('open','full','waitlist','closed','unknown')),
      is_new                     boolean NOT NULL DEFAULT false,
      total_fee_cents            integer,
      detail_url                 text NOT NULL,
      registration_url           text,
      first_seen_at              timestamptz NOT NULL DEFAULT now(),
      last_seen_at               timestamptz NOT NULL DEFAULT now(),
      disappeared_at             timestamptz
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS listing_live_idx ON listing (course_id) WHERE disappeared_at IS NULL
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS listing_hist_idx ON listing (course_id, term_rank)`;

  // ── listing_fee (§5.2.4). Every fee line, `is_total` flagging the "Total Fees"
  // row. PK on ord, not label — real labels collide within a page and carry
  // pricing-tier prose ("Tuition - for non-member. MEMBER is $50…").
  yield* sql`
    CREATE TABLE IF NOT EXISTS listing_fee (
      listing_id   bigint NOT NULL REFERENCES listing(id) ON DELETE CASCADE,
      ord          smallint NOT NULL,
      label        text NOT NULL,
      amount_cents integer NOT NULL,
      is_total     boolean NOT NULL DEFAULT false,
      PRIMARY KEY (listing_id, ord)
    )
  `;

  // ── listing_instructor (§5.2.4). The real Instructor field concatenates
  // "Last, First" pairs and leaks non-names; the extractor splits into people.
  yield* sql`
    CREATE TABLE IF NOT EXISTS listing_instructor (
      listing_id bigint NOT NULL REFERENCES listing(id) ON DELETE CASCADE,
      ord        smallint NOT NULL,
      last_name  text,
      first_name text,
      PRIMARY KEY (listing_id, ord)
    )
  `;

  // ── course_relation (§5.2.5). Mined from BOTH the Prerequisites field and the
  // description prose (68 real prereqs across the corpus; most rows are "None").
  // FK left NULL when unresolvable — publish the resolution rate, don't force it.
  yield* sql`
    CREATE TABLE IF NOT EXISTS course_relation (
      course_id   bigint NOT NULL REFERENCES course(id) ON DELETE CASCADE,
      raw_text    text NOT NULL,
      source      text NOT NULL CHECK (source IN ('prereq_field','description')),
      requires_id bigint REFERENCES course(id),
      kind        text CHECK (kind IN ('required','recommended','corequisite','concurrent')),
      PRIMARY KEY (course_id, raw_text)
    )
  `;

  // ── listing_change (§5.3.2). A field-level change log (not SCD-2). The extractor
  // writes a row when a re-extract yields a different value on a WATCHED field.
  yield* sql`
    CREATE TABLE IF NOT EXISTS listing_change (
      id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      listing_id  bigint NOT NULL REFERENCES listing(id) ON DELETE CASCADE,
      observed_at timestamptz NOT NULL DEFAULT now(),
      field       text NOT NULL,
      old_value   text,
      new_value   text
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS listing_change_idx
      ON listing_change (listing_id, field, observed_at DESC)
  `;

  yield* sql`
    UPDATE app_meta SET value = '2', updated_at = now() WHERE key = 'schema_phase'
  `;
});
