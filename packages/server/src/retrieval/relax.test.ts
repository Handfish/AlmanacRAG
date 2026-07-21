import { ListingFilter } from "@catalog/domain/filter";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgMigrator from "@effect/sql-pg/PgMigrator";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { PgTest, withTransactionRollback } from "../db/pg-test.js";
import { relaxFilter } from "./relax.js";

// Zero-result relaxation (§10.3) against a real testcontainer: an over-constrained
// filter that matches NOTHING should report, per predicate, how many results dropping
// just that one constraint surfaces — "you know which predicate killed it."

const TestLive = PgMigrator.layer({
  loader: Migrator.fromGlob(import.meta.glob("../db/migrations/*.ts")),
}).pipe(Layer.provide(NodeServices.layer), Layer.orDie, Layer.provideMerge(PgTest));

interface Seed {
  readonly i: number;
  readonly courseId: string;
  readonly campus: string | null;
  readonly status: string;
  readonly totalFeeCents: number | null;
  readonly isEvening: boolean | null;
}

const insertCourse = (i: number) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ id: string; }>`
      INSERT INTO course (group_url, course_title, title_normalized)
      VALUES (${`https://ce-catalog.rutgers.edu/searchResults.cfm?couID=${i}`},
              ${`Course ${i}`}, ${`course ${i}`})
      RETURNING id::text AS id`;
    return rows[0]!.id;
  });

const seedListing = (modelId: number, s: Seed) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const url = `https://ce-catalog.rutgers.edu/courseDisplay.cfm?schID=${s.i}`;
    const pid = (yield* sql<{ id: string; }>`
      INSERT INTO cecc_course_index_course_listing (url) VALUES (${url}) RETURNING id::text AS id`)[
      0
    ]!.id;
    const ext = (yield* sql<{ id: string; }>`
      INSERT INTO extraction (source_page_id, model_id, prompt_version, status)
      VALUES (${pid}, ${modelId}, 'test-v1', 'ok') RETURNING id::text AS id`)[0]!.id;
    yield* sql`
      INSERT INTO listing
        (source_page_id, extraction_id, course_id, status, campus, total_fee_cents, is_evening,
         detail_url)
      VALUES
        (${pid}, ${ext}, ${s.courseId}, ${s.status}, ${s.campus}, ${s.totalFeeCents},
         ${s.isEvening}, ${url})`;
  });

describe("relaxFilter (§10.3)", () => {
  it.layer(TestLive, { timeout: "90 seconds" })("zero-result relaxation", (it) => {
    it.effect("counts each single-predicate drop when the filter matches nothing", () =>
      withTransactionRollback(Effect.gen(function*() {
        const sql = yield* SqlClient;
        const modelId = (yield* sql<{ id: number; }>`
          INSERT INTO model (name, kind) VALUES ('test-llm', 'llm') RETURNING id`)[0]!.id;
        const c1 = yield* insertCourse(1);
        const c2 = yield* insertCourse(2);
        const c3 = yield* insertCourse(3);

        // Corpus: no single row is Newark AND evening AND under $2,000, but each
        // predicate alone has matches. (Fees are cents: $2,000 = 200000.)
        yield* seedListing(modelId, {
          i: 1,
          courseId: c1,
          campus: "Newark",
          status: "open",
          totalFeeCents: 300000, // Newark, evening, but $3,000 (fails the fee)
          isEvening: true,
        });
        yield* seedListing(modelId, {
          i: 2,
          courseId: c2,
          campus: "Newark",
          status: "open",
          totalFeeCents: 150000, // Newark, $1,500, but daytime (fails evening)
          isEvening: false,
        });
        yield* seedListing(modelId, {
          i: 3,
          courseId: c3,
          campus: "Online",
          status: "open",
          totalFeeCents: 100000, // evening, $1,000, but Online (fails campus)
          isEvening: true,
        });

        const filter = new ListingFilter({
          campus: "Newark",
          isEvening: true,
          maxFeeCents: 200000,
        });

        const result = yield* relaxFilter(filter);

        // The full filter matches nothing (that is the §10.3 case).
        expect(result.total).toBe(0);

        // Each drop is reported with its count, best-first, only when it adds results.
        const byKey = new Map(result.relaxations.map((r) => [r.key, r.count]));
        expect(byKey.get("maxFeeCents")).toBe(1); // drop the fee → l1 (Newark evening $3k)
        expect(byKey.get("isEvening")).toBe(1); // drop evening → l2 (Newark day $1.5k)
        expect(byKey.get("campus")).toBe(1); // drop campus → l3 (Online evening $1k)
        expect(result.relaxations).toHaveLength(3);

        // The dropped-fee chip carries a human label for the §10.3 UI.
        const fee = result.relaxations.find((r) => r.key === "maxFeeCents");
        expect(fee?.label).toBe("under $2000");
      })));

    it.effect("a filter that already matches needs no relaxation", () =>
      withTransactionRollback(Effect.gen(function*() {
        const sql = yield* SqlClient;
        const modelId = (yield* sql<{ id: number; }>`
          INSERT INTO model (name, kind) VALUES ('test-llm', 'llm') RETURNING id`)[0]!.id;
        const c1 = yield* insertCourse(1);
        yield* seedListing(modelId, {
          i: 1,
          courseId: c1,
          campus: "Newark",
          status: "open",
          totalFeeCents: 100000,
          isEvening: true,
        });
        const result = yield* relaxFilter(new ListingFilter({ campus: "Newark" }));
        expect(result.total).toBe(1);
        expect(result.relaxations).toEqual([]); // nothing to relax
      })));
  });
});
