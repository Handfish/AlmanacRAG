import { ListingFilter } from "@catalog/domain/filter";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgMigrator from "@effect/sql-pg/PgMigrator";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { PgTest, withTransactionRollback } from "../db/pg-test.js";
import { filterListings } from "./filter-listings.js";

// `filter_listings` (§8) against a real Postgres testcontainer: the ListingFilter →
// SQL compilation, exercising the load-bearing semantics — `disappeared_at IS NULL`
// unless includeGone (§5.3), fee/date bounds, enum predicates, and NULL discipline
// (a positive `isEvening`/`status` filter excludes NULL/non-matching rows).

const TestLive = PgMigrator.layer({
  loader: Migrator.fromGlob(import.meta.glob("../db/migrations/*.ts")),
}).pipe(Layer.provide(NodeServices.layer), Layer.orDie, Layer.provideMerge(PgTest));

interface Seed {
  readonly i: number;
  readonly courseId: string;
  readonly campus: string | null;
  readonly deliveryMode: string | null;
  readonly status: string;
  readonly totalFeeCents: number | null;
  readonly startsOn: string | null;
  readonly isEvening: boolean | null;
  readonly term: string | null;
  readonly gone: boolean;
}

const seedListing = (modelId: number, s: Seed) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const url = `https://ce-catalog.rutgers.edu/courseDisplay.cfm?schID=${s.i}`;
    const page = yield* sql<{ id: string; }>`
      INSERT INTO cecc_course_index_course_listing (url) VALUES (${url}) RETURNING id::text AS id`;
    const pid = page[0]!.id;
    const ext = yield* sql<{ id: string; }>`
      INSERT INTO extraction (source_page_id, model_id, prompt_version, status)
      VALUES (${pid}, ${modelId}, 'test-v1', 'ok') RETURNING id::text AS id`;
    const rows = yield* sql<{ id: string; }>`
      INSERT INTO listing
        (source_page_id, extraction_id, course_id, status, campus, delivery_mode,
         total_fee_cents, starts_on, is_evening, term, detail_url, disappeared_at)
      VALUES
        (${pid}, ${ext[0]!.id}, ${s.courseId}, ${s.status}, ${s.campus}, ${s.deliveryMode},
         ${s.totalFeeCents}, ${s.startsOn}, ${s.isEvening}, ${s.term}, ${url},
         ${s.gone ? "2026-02-01T00:00:00Z" : null})
      RETURNING id::text AS id`;
    return rows[0]!.id;
  });

const insertCourse = (i: number, program: string, contactHours: number) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ id: string; }>`
      INSERT INTO course (group_url, course_title, title_normalized, program, contact_hours)
      VALUES (${`https://ce-catalog.rutgers.edu/searchResults.cfm?couID=${i}`},
              ${`Course ${i}`}, ${`course ${i}`}, ${program}, ${contactHours})
      RETURNING id::text AS id`;
    return rows[0]!.id;
  });

const ids = (rows: ReadonlyArray<{ listingId: string; }>) => new Set(rows.map((r) => r.listingId));

describe("filterListings", () => {
  it.layer(TestLive, { timeout: "90 seconds" })("ListingFilter → SQL", (it) => {
    it.effect("compiles the load-bearing predicates correctly", () =>
      withTransactionRollback(Effect.gen(function*() {
        const sql = yield* SqlClient;
        const modelId = (yield* sql<{ id: number; }>`
            INSERT INTO model (name, kind) VALUES ('test-llm', 'llm') RETURNING id`)[0]!.id;

        const courseA = yield* insertCourse(1, "Nonprofit Management", 12);
        const courseB = yield* insertCourse(2, "Cybersecurity", 40);

        const l1 = yield* seedListing(modelId, {
          i: 1,
          courseId: courseA,
          campus: "Newark",
          deliveryMode: "online_async",
          status: "open",
          totalFeeCents: 150000,
          startsOn: "2026-03-01",
          isEvening: null,
          term: "Spring 2026",
          gone: false,
        });
        const l2 = yield* seedListing(modelId, {
          i: 2,
          courseId: courseA,
          campus: "New Brunswick",
          deliveryMode: "in_person",
          status: "full",
          totalFeeCents: 250000,
          startsOn: "2026-10-01",
          isEvening: true,
          term: "Fall 2026",
          gone: false,
        });
        const l3 = yield* seedListing(modelId, {
          i: 3,
          courseId: courseB,
          campus: "Online",
          deliveryMode: "online_sync",
          status: "open",
          totalFeeCents: 50000,
          startsOn: "2026-06-01",
          isEvening: null,
          term: "Summer 2026",
          gone: false,
        });
        const l4 = yield* seedListing(modelId, {
          i: 4,
          courseId: courseB,
          campus: "Newark",
          deliveryMode: "online_async",
          status: "open",
          totalFeeCents: 100000,
          startsOn: "2026-04-01",
          isEvening: null,
          term: "Spring 2026",
          gone: true, // disappeared — hidden unless includeGone
        });

        const run = (f: ListingFilter) => filterListings(f, 100).pipe(Effect.map(ids));

        // default: gone listing hidden (§5.3)
        const live = yield* run(new ListingFilter({}));
        expect(live).toEqual(new Set([l1, l2, l3]));
        expect(live.has(l4)).toBe(false);

        // includeGone surfaces the disappeared one
        expect(yield* run(new ListingFilter({ includeGone: true }))).toEqual(
          new Set([l1, l2, l3, l4]),
        );

        // campus, still gone-filtered by default
        expect(yield* run(new ListingFilter({ campus: "Newark" }))).toEqual(new Set([l1]));
        expect(yield* run(new ListingFilter({ campus: "Newark", includeGone: true }))).toEqual(
          new Set([l1, l4]),
        );

        // fee ceiling ("under $1,600") — the off-by-100 hazard lives above this
        expect(yield* run(new ListingFilter({ maxFeeCents: 160000 }))).toEqual(new Set([l1, l3]));

        // status positive filter excludes non-open
        expect(yield* run(new ListingFilter({ status: "open" }))).toEqual(new Set([l1, l3]));

        // isEvening=true must exclude NULL rows (positive predicate), not include them
        expect(yield* run(new ListingFilter({ isEvening: true }))).toEqual(new Set([l2]));

        // date bound (before May 2026), still live-only
        expect(yield* run(new ListingFilter({ startsBefore: new Date("2026-05-01") }))).toEqual(
          new Set([l1]),
        );

        // course-level predicates: program and contact-hour floor
        expect(yield* run(new ListingFilter({ program: "Cybersecurity" }))).toEqual(new Set([l3]));
        expect(yield* run(new ListingFilter({ minHours: 20 }))).toEqual(new Set([l3]));

        // delivery mode
        expect(yield* run(new ListingFilter({ deliveryMode: "online_async" }))).toEqual(
          new Set([l1]),
        );
      })));
  });
});
