import type { ObservationWindow } from "./answer.js";
import type { Status, TermSeason } from "./course.js";
import type { CourseId, ListingId } from "./ids.js";

// The temporal contract (architecture.md §5.3, §8.1) — what `course_history` returns:
// the §5.3.5 per-term rollup and field-level change log, ALWAYS paired with the
// observation window (§5.3.4) so §10.6 can bound any recurrence claim.
//
// Like `Card`, these are plain server-built rows read from Postgres — never decoded from
// model output (ADR-008). Every fact here (which terms it ran, what it cost, when a
// section filled up) is a database fact. The model's only role in a history answer is
// ROUTING (identifying that the question is temporal and which course it is about); the
// prose is composed deterministically from this structure (history/format-history.ts), so
// a recurrence pattern can never be hallucinated from insufficient observation.

/** One term this course was observed in (§5.3.5 query 1&2). `stillListed` is true when at
 * least one section of this term is still live (`disappeared_at IS NULL`). Fees are the
 * min/max total across that term's sections. */
export type TermRun = {
  readonly term: string; // "Fall 2026", or the raw term string when the season is unknown
  readonly season: TermSeason | null;
  readonly year: number | null;
  readonly rank: number; // term_rank — the chronological sort key (§5.3)
  readonly sections: number; // how many sections ran that term
  readonly minFeeCents: number | null;
  readonly maxFeeCents: number | null;
  readonly statuses: ReadonlyArray<Status>;
  readonly stillListed: boolean;
};

/** One watched-field change (§5.3.2 / §5.3.5 query 3) — a status flip, fee change, or date
 * move, with the time it was observed. The narrow log, not row versions. */
export type ChangeEvent = {
  readonly listingId: ListingId;
  readonly field: string; // status | total_fee_cents | starts_on | ends_on | instructor | registration_deadline
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly observedAt: string; // ISO timestamp
};

/** The `course_history` payload (§8.1): the per-term rollup + change log for ONE course,
 * PLUS the observation window and the per-course evidence count. Two honesty facts travel
 * together (§10.6): `window` bounds recurrence claims GLOBALLY ("I've only been watching
 * since July 2026"); `termsSeen` is the PER-COURSE evidence ("I've seen it once") — a
 * course first observed this term is still `termsSeen = 1` even after the system has
 * watched the catalog for years, and that is exactly the claim §10.6 refuses. */
export type CourseHistory = {
  readonly courseId: CourseId;
  readonly courseTitle: string;
  readonly terms: ReadonlyArray<TermRun>; // chronological, oldest → newest
  readonly changes: ReadonlyArray<ChangeEvent>; // most-recent first
  /** Distinct DATED terms (season + year both known) this course appears in — the
   * evidence a recurrence claim is measured against (§10.6). Undated listings don't count. */
  readonly termsSeen: number;
  readonly window: ObservationWindow;
};
