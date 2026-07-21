import type { Card, CardFee, ObservationWindow } from "@catalog/domain/answer";
import type { CourseId, ListingId } from "@catalog/domain/ids";
import type { FilteredListing } from "@catalog/domain/ports/knowledge-base";
import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

// The §1 guarantee, in SQL (§10.4). `hydrate` resolves each `listingId` to a full
// `Card` by reading the LIVE `listing` + `listing_fee` + `course` rows — status and
// fees at render, never frozen. `listingsForCourses` turns `search` course hits into
// candidate listings for the answer agent. Both are plain projections (no generation,
// no model input); the answer agent supplies the model-authored `why` afterward.

// Fees come back as an aggregated json array (one round trip, no N+1).
interface CardRow {
  readonly listingId: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly externalCourseId: string | null;
  readonly track: string | null;
  readonly contactHours: number | null;
  readonly deliveryMode: Card["deliveryMode"];
  readonly campus: Card["campus"];
  readonly term: string | null;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly isEvening: boolean | null;
  readonly scheduleText: string | null;
  readonly status: Card["status"];
  readonly totalFeeCents: number | null;
  readonly registrationDeadline: string | null;
  readonly registrationDeadlineRule: string | null;
  readonly registrationUrl: string | null;
  readonly registrationKeyword: string | null;
  readonly detailUrl: string;
  readonly checkedAt: string;
  readonly fees: ReadonlyArray<{ label: string; amountCents: number; isTotal: boolean; }> | null;
}

// Listing/course ids are DB-generated bigints. Coerce to safe integer strings and
// drop anything else, then bind the whole `{…}` array as ONE parameter (the codebase
// convention — no `sql.array` at this beta). This keeps the query parameterized even
// though the ids arrive via model-chosen `listingId`s (which are grounded to real
// candidate ids upstream, but we defend here regardless).
const pgIntArray = (ids: ReadonlyArray<string>): string =>
  `{${ids.filter((id) => /^\d+$/.test(id)).join(",")}}`;

const toCard = (row: CardRow, why: string): Card => ({
  listingId: row.listingId as ListingId,
  courseId: row.courseId as CourseId,
  courseTitle: row.courseTitle,
  externalCourseId: row.externalCourseId,
  track: row.track,
  contactHours: row.contactHours,
  deliveryMode: row.deliveryMode,
  campus: row.campus,
  term: row.term,
  startsOn: row.startsOn,
  endsOn: row.endsOn,
  isEvening: row.isEvening,
  scheduleText: row.scheduleText,
  status: row.status,
  totalFeeCents: row.totalFeeCents,
  fees: (row.fees ?? []).map((f): CardFee => ({
    label: f.label,
    amountCents: f.amountCents,
    isTotal: f.isTotal,
  })),
  registrationDeadline: row.registrationDeadline,
  registrationDeadlineRule: row.registrationDeadlineRule,
  registrationUrl: row.registrationUrl,
  registrationKeyword: row.registrationKeyword,
  detailUrl: row.detailUrl,
  checkedAt: row.checkedAt,
  why,
});

/**
 * Hydrate `listingIds` to full `Card`s, live. Order follows the input; unknown ids are
 * dropped. `whyByListing` carries the model's one-line `why` per card (§4.2) — hydrate
 * attaches it but reads every FACT from Postgres, so no fact ever originates in the
 * model (ADR-008). Freshness (`checkedAt`) is the source page's `last_hash_comparison_at`
 * (when the fact was last verified), falling back to the listing's `last_seen_at`.
 */
export const hydrateCards = (
  listingIds: ReadonlyArray<ListingId>,
  whyByListing: ReadonlyMap<string, string>,
) =>
  Effect.gen(function*() {
    if (listingIds.length === 0) return [] as ReadonlyArray<Card>;
    const sql = yield* SqlClient;
    const ids = listingIds.map((id) => id as string);
    const rows = yield* sql<CardRow>`
      SELECT
        l.id::text        AS listing_id,
        l.course_id::text AS course_id,
        co.course_title,
        co.external_course_id,
        co.track,
        co.contact_hours::float8 AS contact_hours,
        coalesce(l.delivery_mode, 'unknown') AS delivery_mode,
        coalesce(l.campus, 'unknown')        AS campus,
        l.term,
        to_char(l.starts_on, 'YYYY-MM-DD') AS starts_on,
        to_char(l.ends_on,   'YYYY-MM-DD') AS ends_on,
        l.is_evening,
        l.schedule_text,
        l.status,
        l.total_fee_cents,
        to_char(l.registration_deadline, 'YYYY-MM-DD') AS registration_deadline,
        l.registration_deadline_rule,
        l.registration_url,
        co.registration_keyword,
        l.detail_url,
        to_char(
          coalesce(sp.last_hash_comparison_at, l.last_seen_at) AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS"Z"'
        ) AS checked_at,
        (
          SELECT coalesce(
            json_agg(json_build_object(
              'label', lf.label, 'amountCents', lf.amount_cents, 'isTotal', lf.is_total
            ) ORDER BY lf.ord),
            '[]'::json
          )
          FROM listing_fee lf WHERE lf.listing_id = l.id
        ) AS fees
      FROM listing l
      JOIN course co ON co.id = l.course_id
      LEFT JOIN cecc_course_index_course_listing sp ON sp.id = l.source_page_id
      WHERE l.id = ANY(${pgIntArray(ids)}::bigint[])
    `;
    // Reorder to match the requested id order (SQL ANY() does not preserve it).
    const byId = new Map(rows.map((r) => [r.listingId, r]));
    const out: Array<Card> = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (row === undefined) continue;
      out.push(toCard(row, whyByListing.get(id) ?? ""));
    }
    return out as ReadonlyArray<Card>;
  });

/**
 * The current LIVE listing for each course id (§8 — turning `search` course hits into
 * candidate listings). `DISTINCT ON (course_id)` keeps the most recent live term per
 * course; `disappeared_at IS NULL` hides vanished pages. Output order follows the input
 * `courseIds` (search relevance), not the SQL scan order.
 */
export const listingsForCourses = (courseIds: ReadonlyArray<CourseId>, perCourse: number) =>
  Effect.gen(function*() {
    if (courseIds.length === 0) return [] as ReadonlyArray<FilteredListing>;
    const sql = yield* SqlClient;
    const ids = courseIds.map((id) => id as string);
    const rows = yield* sql<FilteredListing>`
      SELECT
        x.listing_id, x.course_id, x.course_title, x.term, x.campus, x.delivery_mode,
        x.status, x.is_evening, x.starts_on, x.ends_on, x.total_fee_cents,
        x.contact_hours, x.detail_url, x.registration_url
      FROM (
        SELECT
          l.id::text        AS listing_id,
          l.course_id::text AS course_id,
          co.course_title,
          l.term,
          l.campus,
          l.delivery_mode,
          l.status,
          l.is_evening,
          to_char(l.starts_on, 'YYYY-MM-DD') AS starts_on,
          to_char(l.ends_on,   'YYYY-MM-DD') AS ends_on,
          l.total_fee_cents,
          co.contact_hours::float8 AS contact_hours,
          l.detail_url,
          l.registration_url,
          row_number() OVER (PARTITION BY l.course_id ORDER BY l.term_rank DESC, l.id) AS rn
        FROM listing l
        JOIN course co ON co.id = l.course_id
        WHERE l.disappeared_at IS NULL
          AND l.course_id = ANY(${pgIntArray(ids)}::bigint[])
      ) x
      WHERE x.rn <= ${perCourse}
    `;
    // Group by course, then emit in the requested course order.
    const byCourse = new Map<string, Array<FilteredListing>>();
    for (const r of rows) {
      const list = byCourse.get(r.courseId as string) ?? [];
      list.push(r);
      byCourse.set(r.courseId as string, list);
    }
    const out: Array<FilteredListing> = [];
    for (const id of ids) {
      const list = byCourse.get(id);
      if (list !== undefined) out.push(...list);
    }
    return out as ReadonlyArray<FilteredListing>;
  });

/** The observation window (§5.3.4/§10.6) from the single `system_epoch` row. Defaults
 * to today / 0 terms if the clock has not been seeded (a fresh DB). */
export const readObservationWindow = () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ observingSince: string; termsObserved: number; }>`
      SELECT to_char(observing_since AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS observing_since,
             terms_observed
      FROM system_epoch WHERE id = 1`;
    const row = rows[0];
    return {
      observingSince: row?.observingSince ?? "unknown",
      termsObserved: row?.termsObserved ?? 0,
    } satisfies ObservationWindow;
  });
