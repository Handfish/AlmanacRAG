import * as Schema from "effect/Schema";

// Domain vocabulary (architecture.md §5.2) — the closed value sets the extractor
// decodes into and the filter (§8 / §4.2) queries over. Grounded in the REAL
// ce-catalog corpus (995 pages), not the legacy scraper's ALT10 sample
// (docs/real-data-findings-1.md). The entity row classes (Unit/Course/Listing/…)
// land with migration 0003 once §5.2 is reconciled to the real data.
//
// These enums are the front line against model hallucination (§9): the extractor
// may only emit an expected variant, and anything outside the set fails decode and
// is logged as a typed `schema_error` (§5.5) rather than poisoning a column.

/**
 * Listing availability. The site prints four real strings, mapped to this closed
 * enum deterministically in `derive` (§9.2, "enumerate from the data"):
 *   Registration Available → open · Course Full → full ·
 *   Waiting List Available → waitlist · Registration Not Available → closed.
 * A value outside the known map decodes to `unknown` + an alert, never a silent default.
 */
export const Status = Schema.Literals(["open", "full", "waitlist", "closed", "unknown"]);
export type Status = typeof Status.Type;

/**
 * How a course is delivered. Derived from the (messy) Format field cross-checked
 * against the description — "Format: Distance Education: Online Scheduled" is silent
 * on sync vs async; the description settles it (§5.2.3, §9.2).
 */
export const DeliveryMode = Schema.Literals([
  "in_person",
  "online_sync",
  "online_async",
  "hybrid",
  "unknown",
]);
export type DeliveryMode = typeof DeliveryMode.Type;

/**
 * Campus. Real Location values are free-form ("100 Rock, Room 3031 … Piscataway ,
 * NJ 08854"); derived by keyword map, with out-of-state → Other and an online
 * location → Online (§9.2 entangled campus/format).
 */
export const Campus = Schema.Literals([
  "New Brunswick",
  "Newark",
  "Camden",
  "Online",
  "Other",
  "unknown",
]);
export type Campus = typeof Campus.Type;

/**
 * Term season. NOT read from `session` (a year / year-range / suffix in the real
 * data, e.g. "2025-26", "2024-EBP"); derived from the start month of the `dates`
 * field (Jun–Aug → Summer, …). See docs/real-data-findings-1.md.
 */
export const TermSeason = Schema.Literals(["Winter", "Spring", "Summer", "Fall"]);
export type TermSeason = typeof TermSeason.Type;

/**
 * Where a course→course relation was found (§5.2.5): the Prerequisites field, or
 * the description prose — the field routinely omits relations the prose states.
 */
export const RelationSource = Schema.Literals(["prereq_field", "description"]);
export type RelationSource = typeof RelationSource.Type;

/** Strength of a course→course relation (§5.2.5). */
export const RelationKind = Schema.Literals([
  "required",
  "recommended",
  "corequisite",
  "concurrent",
]);
export type RelationKind = typeof RelationKind.Type;
