import type { ListingFilter } from "@catalog/domain/filter";
import type { FilteredListing } from "@catalog/domain/ports/knowledge-base";
import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import type { Fragment } from "effect/unstable/sql/Statement";

// Compile a `ListingFilter` (§4.2/§8) to ONE parameterized SQL statement (§7.2/§8.4).
// No injection surface, no hallucinated columns, no unbounded scan — every predicate
// is a bound parameter. `disappeared_at IS NULL` unless `includeGone` (§5.3): a
// listing whose page has vanished is hidden from live results by default.
//
// NULL discipline (§8): a positive filter (`status = 'open'`, `is_evening = true`,
// `total_fee_cents <= …`) excludes rows where the column is NULL — that is correct SQL
// for an *explicit* predicate. The architecture's warning ("NULL must not silently
// exclude") is about the ROUTER's decision to APPLY a filter, not about this
// compilation; the chips (§10.2) are what make an over-eager filter recoverable.

const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

export const filterListings = (filter: ListingFilter, limit: number) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const conds: Array<Fragment> = [];

    if (filter.includeGone !== true) conds.push(sql`l.disappeared_at IS NULL`);
    if (filter.campus !== undefined) conds.push(sql`l.campus = ${filter.campus}`);
    if (filter.deliveryMode !== undefined) {
      conds.push(sql`l.delivery_mode = ${filter.deliveryMode}`);
    }
    if (filter.status !== undefined) conds.push(sql`l.status = ${filter.status}`);
    if (filter.isEvening !== undefined) conds.push(sql`l.is_evening = ${filter.isEvening}`);
    if (filter.term !== undefined) conds.push(sql`l.term = ${filter.term}`);
    if (filter.program !== undefined) conds.push(sql`co.program = ${filter.program}`);
    if (filter.ceccUnit !== undefined) conds.push(sql`u.name = ${filter.ceccUnit}`);

    if (filter.maxFeeCents !== undefined) {
      conds.push(sql`l.total_fee_cents IS NOT NULL AND l.total_fee_cents <= ${filter.maxFeeCents}`);
    }
    if (filter.minFeeCents !== undefined) {
      conds.push(sql`l.total_fee_cents IS NOT NULL AND l.total_fee_cents >= ${filter.minFeeCents}`);
    }
    if (filter.minHours !== undefined) {
      conds.push(sql`co.contact_hours IS NOT NULL AND co.contact_hours >= ${filter.minHours}`);
    }
    if (filter.maxHours !== undefined) {
      conds.push(sql`co.contact_hours IS NOT NULL AND co.contact_hours <= ${filter.maxHours}`);
    }
    if (filter.startsAfter !== undefined) {
      conds.push(
        sql`l.starts_on IS NOT NULL AND l.starts_on >= ${isoDate(filter.startsAfter)}::date`,
      );
    }
    if (filter.startsBefore !== undefined) {
      conds.push(
        sql`l.starts_on IS NOT NULL AND l.starts_on < ${isoDate(filter.startsBefore)}::date`,
      );
    }
    // registration still open: no stated deadline, or the deadline has not passed.
    if (filter.openForReg === true) {
      conds.push(sql`(l.registration_deadline IS NULL OR l.registration_deadline >= CURRENT_DATE)`);
    }

    const where = conds.length > 0 ? sql`WHERE ${sql.and(conds)}` : sql``;

    return yield* sql<FilteredListing>`
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
        l.registration_url
      FROM listing l
      JOIN course co ON co.id = l.course_id
      LEFT JOIN unit u ON u.id = co.unit_id
      ${where}
      ORDER BY l.term_rank DESC, l.id
      LIMIT ${limit}
    `;
  });
