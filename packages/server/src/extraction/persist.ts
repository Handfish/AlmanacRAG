import type { ExtractedCourse } from "@catalog/domain/extraction";
import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import {
  type CourseInsert,
  type DeriveContext,
  deriveRows,
  type FeeInsert,
  type InstructorInsert,
  type ListingInsert,
  type RelationInsert,
  type StoredPageFields,
} from "./derive.js";

// The Phase-2 write path (architecture.md §9, §5.2/§5.3). Hand-written sql-tag
// functions in the db/repos style (source-page.ts), composed into one transactional
// orchestration. Every extract attempt writes a TYPED `extraction` row — success or
// failure — so a bad page is a `schema_error` provenance record, never a silent gap.

// ── model registry (§5.4) ────────────────────────────────────────────────────
export const ensureModel = (name: string, kind: "llm" | "embedding" | "reranker" = "llm") =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    // DO UPDATE (a no-op touch of `name`) rather than DO NOTHING so RETURNING always
    // yields the row whether it was inserted or already present.
    const rows = yield* sql<{ id: number; }>`
      INSERT INTO model (name, kind) VALUES (${name}, ${kind})
      ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `;
    return rows[0]!.id;
  });

// ── extraction provenance (§5.5) ─────────────────────────────────────────────
export type ExtractionStatus = "ok" | "schema_error" | "refused" | "timeout";

export interface ExtractionMeta {
  readonly sourcePageId: string;
  readonly crawlRunId: number | null;
  readonly modelId: number;
  readonly promptVersion: string;
  readonly status: ExtractionStatus;
  readonly rawJson: unknown;
  readonly error: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export const insertExtraction = (meta: ExtractionMeta) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const rawJson = meta.rawJson == null ? null : JSON.stringify(meta.rawJson);
    const rows = yield* sql<{ id: string; }>`
      INSERT INTO extraction
        (source_page_id, crawl_run_id, model_id, prompt_version, status,
         raw_json, error, input_tokens, output_tokens)
      VALUES
        (${meta.sourcePageId}, ${meta.crawlRunId}, ${meta.modelId}, ${meta.promptVersion},
         ${meta.status}, ${rawJson}::jsonb, ${meta.error}, ${meta.inputTokens}, ${meta.outputTokens})
      RETURNING id::text AS id
    `;
    return rows[0]!.id;
  });

// ── course (§5.2.2) — keyed on group_url (couID), title_normalized fallback ────
const upsertCourse = (course: CourseInsert) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const existing = course.groupUrl !== null
      ? yield* sql<{ id: string; }>`
          SELECT id::text AS id FROM course WHERE group_url = ${course.groupUrl}`
      : yield* sql<{ id: string; }>`
          SELECT id::text AS id FROM course
          WHERE group_url IS NULL AND title_normalized = ${course.titleNormalized}`;

    const cols = {
      external_course_id: course.externalCourseId,
      course_title: course.courseTitle,
      title_normalized: course.titleNormalized,
      track: course.track,
      contact_hours: course.contactHours,
      subject: course.subject,
      program: course.program,
      description: course.description,
      audience: course.audience,
      prerequisite_text: course.prerequisiteText,
      registration_keyword: course.registrationKeyword,
    };

    const prior = existing[0];
    if (prior !== undefined) {
      yield* sql`
        UPDATE course SET ${sql.update(cols)}, last_seen_at = now() WHERE id = ${prior.id}`;
      return prior.id;
    }
    const inserted = yield* sql<{ id: string; }>`
      INSERT INTO course ${sql.insert({ group_url: course.groupUrl, ...cols })}
      RETURNING id::text AS id`;
    return inserted[0]!.id;
  });

// ── listing (§5.2.3) — keyed on source_page_id (one section per page) ─────────
/** The watched-field snapshot read BEFORE an upsert, for the §5.3.2 change log. */
interface Watched {
  readonly status: string;
  readonly totalFeeCents: number | null;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly registrationDeadline: string | null;
}

const getWatched = (sourcePageId: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const rows = yield* sql<Watched>`
      SELECT status,
             total_fee_cents                    AS total_fee_cents,
             to_char(starts_on, 'YYYY-MM-DD')    AS starts_on,
             to_char(ends_on, 'YYYY-MM-DD')      AS ends_on,
             to_char(registration_deadline, 'YYYY-MM-DD') AS registration_deadline
      FROM listing WHERE source_page_id = ${sourcePageId}`;
    return rows[0] ?? null;
  });

const upsertListing = (
  listing: ListingInsert,
  ids: { sourcePageId: string; courseId: string; extractionId: string; },
) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const cols = {
      extraction_id: ids.extractionId,
      course_id: ids.courseId,
      external_section_id: listing.externalSectionId,
      session_label: listing.sessionLabel,
      term: listing.term,
      term_year: listing.termYear,
      term_season: listing.termSeason,
      starts_on: listing.startsOn,
      ends_on: listing.endsOn,
      schedule_text: listing.scheduleText,
      is_evening: listing.isEvening,
      registration_deadline: listing.registrationDeadline,
      registration_deadline_rule: listing.registrationDeadlineRule,
      format_text: listing.formatText,
      format_category: listing.formatCategory,
      format_platform: listing.formatPlatform,
      delivery_mode: listing.deliveryMode,
      location_text: listing.locationText,
      location_site: listing.locationSite,
      location_room: listing.locationRoom,
      campus: listing.campus,
      status: listing.status,
      is_new: listing.isNew,
      total_fee_cents: listing.totalFeeCents,
      detail_url: listing.detailUrl,
      registration_url: listing.registrationUrl,
    };
    const rows = yield* sql<{ id: string; }>`
      INSERT INTO listing ${sql.insert({ source_page_id: ids.sourcePageId, ...cols })}
      ON CONFLICT (source_page_id) DO UPDATE SET
        ${sql.update(cols)}, last_seen_at = clock_timestamp(), disappeared_at = NULL
      RETURNING id::text AS id`;
    return rows[0]!.id;
  });

// ── §5.3.2 change log — write a row per changed WATCHED field, before the update ──
const WATCHED_FIELDS = [
  "status",
  "total_fee_cents",
  "starts_on",
  "ends_on",
  "registration_deadline",
] as const;

const writeListingChanges = (listingId: string, before: Watched, after: ListingInsert) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const pairs: ReadonlyArray<readonly [string, string | null, string | null]> = [
      ["status", before.status, after.status],
      [
        "total_fee_cents",
        before.totalFeeCents === null ? null : String(before.totalFeeCents),
        after.totalFeeCents === null ? null : String(after.totalFeeCents),
      ],
      ["starts_on", before.startsOn, after.startsOn],
      ["ends_on", before.endsOn, after.endsOn],
      ["registration_deadline", before.registrationDeadline, after.registrationDeadline],
    ];
    for (const [field, oldValue, newValue] of pairs) {
      if (!WATCHED_FIELDS.includes(field as (typeof WATCHED_FIELDS)[number])) continue;
      if (oldValue === newValue) continue;
      yield* sql`
        INSERT INTO listing_change (listing_id, field, old_value, new_value)
        VALUES (${listingId}, ${field}, ${oldValue}, ${newValue})`;
    }
  });

// ── children (§5.2.4/§5.2.5) — replace-in-place (delete + insert) ─────────────
const replaceFees = (listingId: string, fees: ReadonlyArray<FeeInsert>) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    yield* sql`DELETE FROM listing_fee WHERE listing_id = ${listingId}`;
    for (const fee of fees) {
      yield* sql`
        INSERT INTO listing_fee (listing_id, ord, label, amount_cents, is_total)
        VALUES (${listingId}, ${fee.ord}, ${fee.label}, ${fee.amountCents}, ${fee.isTotal})`;
    }
  });

const replaceInstructors = (listingId: string, instructors: ReadonlyArray<InstructorInsert>) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    yield* sql`DELETE FROM listing_instructor WHERE listing_id = ${listingId}`;
    for (const person of instructors) {
      yield* sql`
        INSERT INTO listing_instructor (listing_id, ord, last_name, first_name)
        VALUES (${listingId}, ${person.ord}, ${person.lastName}, ${person.firstName})`;
    }
  });

const replaceRelations = (courseId: string, relations: ReadonlyArray<RelationInsert>) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    yield* sql`DELETE FROM course_relation WHERE course_id = ${courseId} AND requires_id IS NULL`;
    for (const relation of relations) {
      // Resolution to requires_id is a later pass; store the raw edge now (FK NULL).
      yield* sql`
        INSERT INTO course_relation (course_id, raw_text, source, kind)
        VALUES (${courseId}, ${relation.rawText}, ${relation.source}, ${relation.kind})
        ON CONFLICT (course_id, raw_text) DO UPDATE SET
          source = EXCLUDED.source, kind = EXCLUDED.kind`;
    }
  });

// ── orchestration ─────────────────────────────────────────────────────────────
export interface PersistInput {
  readonly sourcePageId: string;
  readonly crawlRunId: number | null;
  readonly modelName: string;
  readonly promptVersion: string;
  readonly extracted: ExtractedCourse;
  readonly pageFields: StoredPageFields;
  readonly ctx: DeriveContext;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

export interface PersistResult {
  readonly courseId: string;
  readonly listingId: string;
  readonly extractionId: string;
  readonly alerts: ReadonlyArray<string>;
}

/**
 * Persist one successful extraction: derive rows, write the `ok` extraction row,
 * upsert course + listing + children, and log watched-field deltas — all in ONE
 * transaction so a partial failure leaves nothing half-written.
 */
export const persistExtraction = (input: PersistInput) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    return yield* sql.withTransaction(Effect.gen(function*() {
      const modelId = yield* ensureModel(input.modelName);
      const rows = deriveRows(input.extracted, input.pageFields, input.ctx);

      const extractionId = yield* insertExtraction({
        sourcePageId: input.sourcePageId,
        crawlRunId: input.crawlRunId,
        modelId,
        promptVersion: input.promptVersion,
        status: "ok",
        rawJson: input.extracted,
        error: null,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
      });

      const courseId = yield* upsertCourse(rows.course);
      const before = yield* getWatched(input.sourcePageId);
      const listingId = yield* upsertListing(rows.listing, {
        sourcePageId: input.sourcePageId,
        courseId,
        extractionId,
      });
      if (before !== null) yield* writeListingChanges(listingId, before, rows.listing);

      yield* replaceFees(listingId, rows.fees);
      yield* replaceInstructors(listingId, rows.instructors);
      yield* replaceRelations(courseId, rows.relations);

      return { courseId, listingId, extractionId, alerts: rows.alerts } satisfies PersistResult;
    }));
  });

/**
 * Record a FAILED extraction (§9): the model refused, timed out, or produced output
 * that would not decode. A typed provenance row, never a silent null in the typed
 * tables — the page simply has no `listing` until a later run succeeds.
 */
export const recordExtractionFailure = (input: {
  readonly sourcePageId: string;
  readonly crawlRunId: number | null;
  readonly modelName: string;
  readonly promptVersion: string;
  readonly status: Exclude<ExtractionStatus, "ok">;
  readonly error: string;
  readonly rawJson?: unknown;
}) =>
  Effect.gen(function*() {
    const modelId = yield* ensureModel(input.modelName);
    return yield* insertExtraction({
      sourcePageId: input.sourcePageId,
      crawlRunId: input.crawlRunId,
      modelId,
      promptVersion: input.promptVersion,
      status: input.status,
      rawJson: input.rawJson ?? null,
      error: input.error,
      inputTokens: null,
      outputTokens: null,
    });
  });
