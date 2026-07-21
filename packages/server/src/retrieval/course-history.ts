import type { Status, TermSeason } from "@catalog/domain/course";
import type { ChangeEvent, CourseHistory, TermRun } from "@catalog/domain/history";
import type { CourseId, ListingId } from "@catalog/domain/ids";
import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { readObservationWindow } from "./hydrate.js";

// `course_history` in SQL (architecture.md §5.3.5, §8.1, Phase 7). The temporal read: a
// per-term rollup and the field-level change log for one course, over ALL of its listings
// — including ones that have `disappeared_at` set (the retention point of §5.3, "don't
// delete"). The live-vs-history distinction is `stillListed` per term, never a WHERE that
// hides the past. Paired with the observation window so the answer can bound recurrence
// claims (§10.6). Facts only — no generation.

interface TermRow {
  readonly term: string | null;
  readonly termSeason: TermSeason | null;
  readonly termYear: number | null;
  readonly rank: number;
  readonly sections: number;
  readonly minFeeCents: number | null;
  readonly maxFeeCents: number | null;
  readonly statuses: ReadonlyArray<Status>;
  readonly stillListed: boolean;
}

interface ChangeRow {
  readonly listingId: string;
  readonly field: string;
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly observedAt: string;
}

const seasonLabel = (season: TermSeason | null, year: number | null): string | null =>
  season !== null && year !== null ? `${season} ${year}` : null;

/**
 * The full `course_history` for one course id, or `null` if the course does not exist.
 *
 * - `terms` (§5.3.5 q1&2): one row per observed term, oldest→newest by `term_rank`. Counts
 *   sections, min/max total fee, the set of statuses seen, and whether any section of that
 *   term is still live. Groups over EVERY listing, disappeared or not — that is what makes
 *   "has it gotten more expensive?" answerable across terms that fell off the site.
 * - `changes` (§5.3.5 q3): the watched-field change log for the course's listings.
 * - `termsSeen`: distinct DATED terms (season+year both present) — the per-course evidence
 *   §10.6 measures a recurrence claim against. An undated term is real data but is not
 *   evidence of a recurring schedule, so it does not increment the count.
 */
export const courseHistory = (courseId: CourseId) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const id = courseId as string;

    const courseRows = yield* sql<{ courseTitle: string; }>`
      SELECT course_title FROM course WHERE id = ${id}`;
    const course = courseRows[0];
    if (course === undefined) return null;

    // Per-term rollup over ALL listings (live + disappeared). `term_rank` is functionally
    // determined by (season, year), so grouping by all three is safe and keeps the sort key.
    const termRows = yield* sql<TermRow>`
      SELECT
        l.term                                         AS term,
        l.term_season                                  AS term_season,
        l.term_year                                    AS term_year,
        l.term_rank                                    AS rank,
        count(*)::int                                  AS sections,
        min(l.total_fee_cents)                         AS min_fee_cents,
        max(l.total_fee_cents)                         AS max_fee_cents,
        array_agg(DISTINCT l.status)                   AS statuses,
        bool_or(l.disappeared_at IS NULL)              AS still_listed
      FROM listing l
      WHERE l.course_id = ${id}
      GROUP BY l.term, l.term_season, l.term_year, l.term_rank
      ORDER BY l.term_rank, l.term`;

    const terms = termRows.map((r): TermRun => ({
      term: seasonLabel(r.termSeason, r.termYear) ?? r.term ?? "undated",
      season: r.termSeason,
      year: r.termYear,
      rank: r.rank,
      sections: r.sections,
      minFeeCents: r.minFeeCents,
      maxFeeCents: r.maxFeeCents,
      statuses: r.statuses,
      stillListed: r.stillListed,
    }));

    const termsSeen = termRows.filter((r) => r.termSeason !== null && r.termYear !== null).length;

    const changeRows = yield* sql<ChangeRow>`
      SELECT
        lc.listing_id::text AS listing_id,
        lc.field            AS field,
        lc.old_value        AS old_value,
        lc.new_value        AS new_value,
        to_char(lc.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS observed_at
      FROM listing_change lc
      JOIN listing l ON l.id = lc.listing_id
      WHERE l.course_id = ${id}
      ORDER BY lc.observed_at DESC
      LIMIT 100`;

    const changes = changeRows.map((r): ChangeEvent => ({
      listingId: r.listingId as ListingId,
      field: r.field,
      oldValue: r.oldValue,
      newValue: r.newValue,
      observedAt: r.observedAt,
    }));

    const window = yield* readObservationWindow();

    return {
      courseId,
      courseTitle: course.courseTitle,
      terms,
      changes,
      termsSeen,
      window,
    } satisfies CourseHistory;
  });

/**
 * Recompute `system_epoch.terms_observed` from the live data: the count of distinct DATED
 * terms across ALL listings (§5.3.4 — "Phase 7 counts distinct observed terms"). A no-op
 * when the epoch row is absent. Called by the synthetic-history loader so a multi-term
 * scratch DB reports a truthful window; the real crawl can call it likewise once history
 * accrues. Returns the count written.
 */
export const refreshTermsObserved = Effect.gen(function*() {
  const sql = yield* SqlClient;
  const rows = yield* sql<{ n: number; }>`
    SELECT count(DISTINCT (term_season, term_year))::int AS n
    FROM listing
    WHERE term_season IS NOT NULL AND term_year IS NOT NULL`;
  const n = rows[0]?.n ?? 0;
  yield* sql`UPDATE system_epoch SET terms_observed = ${n} WHERE id = 1`;
  return n;
});
