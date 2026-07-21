import * as Schema from "effect/Schema";
import { Campus, DeliveryMode, RelationKind, RelationSource } from "./course.js";

// The single extraction contract (architecture.md §9, corrected for the real data —
// docs/real-data-findings-1.md). ONE schema, not per-family: the A/B/C families were
// a legacy-scraper artifact (`course_data` is empty on all 995 real pages); the real
// corpus is one template — a required core plus an optional tail — captured in
// `page_fields`.
//
// This is the `generateObject` target. The model's output is CONSTRAINED to this
// shape and DECODED through Schema before anything reaches the DB (§9). A value
// outside a closed enum, or a field that will not parse, becomes a typed
// `schema_error` row (§5.5) — never a silent null. Two deliberate choices keep
// hallucinations from biting:
//
//   1. Closed enums (`deliveryMode`, `campus`, relation `source`/`kind`) — the model
//      may only emit an expected variant; anything else fails decode and is logged.
//   2. RAW verbatim capture for every field that has a deterministic derivation
//      (`statusRaw`, `datesText`, `timesText`, `formatText`, fee `amount`,
//      `sessionLabel`). The typed value — Status enum, starts_on/term, fee cents,
//      is_evening — is computed by tested `derive` code from the raw string. The
//      model transcribes; it does not adjudicate. `externalCourseId` is likewise
//      VERIFIED downstream, not trusted — real codes are messy (PP-2216,
//      RootsRockRoll-, Leadership, 520024) and are not an oracle (§9.3).
//
// Every field is a REQUIRED key (`Schema.NullOr`, never `optional`): the model emits
// an explicit `null` when a fact is absent, so "the model omitted it" and "the fact
// is absent" are never conflated.

const NullString = Schema.NullOr(Schema.String);

/** One fee line. The "Total Fees" line is itself a row, flagged by `isTotal` (§9.2). */
export const ExtractedFee = Schema.Struct({
  label: Schema.String, // verbatim, incl. pricing-tier prose ("Tuition - for non-member…")
  amount: Schema.String, // verbatim "$ 415"; derive → amount_cents
  isTotal: Schema.Boolean,
});
export type ExtractedFee = typeof ExtractedFee.Type;

/**
 * One instructor. The real Instructor field concatenates "Last, First" pairs
 * ("Ahn, Haemee Hu, Fiona" = two people) and leaks non-names ("Asynchronous, Self
 * Paced"); the model splits into people and drops non-names. NULL where the source
 * prints a sentinel ("N/A", "-").
 */
export const ExtractedInstructor = Schema.Struct({
  lastName: NullString,
  firstName: NullString,
});
export type ExtractedInstructor = typeof ExtractedInstructor.Type;

/**
 * One course→course relation (§5.2.5). Mined from BOTH the Prerequisites field and
 * the description prose — the field says "None" on a page whose description states a
 * real concurrency. `rawText` is kept verbatim; resolution to a course id is
 * best-effort in `derive`, and the FK is left NULL when unresolvable.
 */
export const ExtractedRelation = Schema.Struct({
  rawText: Schema.String,
  source: RelationSource,
  kind: Schema.NullOr(RelationKind),
});
export type ExtractedRelation = typeof ExtractedRelation.Type;

export const ExtractedCourse = Schema.Struct({
  // ── Course (slow-churn: title / description / prerequisites) ──
  courseTitle: Schema.String,
  externalCourseId: NullString, // verbatim code; VERIFIED, not trusted (§9.3)
  track: NullString, // parsed out of the title (§5.2.2)
  contactHours: Schema.NullOr(Schema.Number), // parsed out of the title ("45 - Hour")
  subject: NullString, // parsed out of the title
  program: NullString,
  description: NullString,
  audience: NullString,
  prerequisiteText: NullString, // verbatim; usually "None" — and often wrong (§9.2)
  registrationKeyword: NullString,
  relations: Schema.Array(ExtractedRelation),

  // ── Listing (fast-churn: term / dates / status / instructor / format / fees) ──
  externalSectionId: NullString,
  sessionLabel: NullString, // raw "2025-26" — a cohort label, NOT a term (findings)
  datesText: NullString, // raw "MM/DD/YYYY - MM/DD/YYYY"; derive → starts_on/ends_on/term
  scheduleText: NullString,
  timesText: NullString, // raw times; derive → is_evening (start hour ≥ 17:00)
  isEvening: Schema.NullOr(Schema.Boolean), // NULL when there is no clock time (async, §9.2)
  registrationDeadlineText: NullString, // verbatim footnote rule; derive → a date
  formatText: NullString, // verbatim Format field
  deliveryMode: DeliveryMode, // enum — cross-checked against formatText in derive
  locationText: NullString, // verbatim Location field
  campus: Campus, // enum — derived from the free-form location
  statusRaw: Schema.String, // verbatim status; derive → Status enum (+ alert on unknown)
  isNew: Schema.Boolean, // "NEW OFFERING" badge
  fees: Schema.Array(ExtractedFee),
  instructors: Schema.Array(ExtractedInstructor),
});
export type ExtractedCourse = typeof ExtractedCourse.Type;
