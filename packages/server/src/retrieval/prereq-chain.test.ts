import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgMigrator from "@effect/sql-pg/PgMigrator";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { PgTest, withTransactionRollback } from "../db/pg-test.js";
import { prereqChain } from "./prereq-chain.js";

// Prerequisite chains (§7.4): the recursive CTE walks resolved course_relation edges,
// and — critically — the depth guard survives a cycle (catalog data contains them).

const TestLive = PgMigrator.layer({
  loader: Migrator.fromGlob(import.meta.glob("../db/migrations/*.ts")),
}).pipe(Layer.provide(NodeServices.layer), Layer.orDie, Layer.provideMerge(PgTest));

describe("prereqChain", () => {
  it.layer(TestLive, { timeout: "90 seconds" })("recursive prereq walk", (it) => {
    it.effect("resolves a transitive chain and terminates on a cycle", () =>
      withTransactionRollback(Effect.gen(function*() {
        const sql = yield* SqlClient;
        const mkCourse = (i: number, title: string) =>
          sql<{ id: string; }>`
            INSERT INTO course (group_url, course_title, title_normalized)
            VALUES (${`https://ce/couID=${i}`}, ${title}, ${title.toLowerCase()})
            RETURNING id::text AS id`.pipe(Effect.map((r) => r[0]!.id));

        const a = yield* mkCourse(1, "Advanced");
        const b = yield* mkCourse(2, "Intermediate");
        const c = yield* mkCourse(3, "Beginner");

        const requires = (from: string, to: string) =>
          sql`INSERT INTO course_relation (course_id, raw_text, source, requires_id, kind)
              VALUES (${from}, ${`requires ${to}`}, 'prereq_field', ${to}, 'required')`;

        // A → B → C, plus a cycle C → A that must not loop forever.
        yield* requires(a, b);
        yield* requires(b, c);
        yield* requires(c, a);

        const chain = yield* prereqChain(a);
        // From A: B (depth 1), C (depth 2), and A itself reappears via the cycle (depth 3).
        const byDepth = chain.map((r) => ({ title: r.courseTitle, depth: r.depth }));
        expect(byDepth[0]).toEqual({ title: "Intermediate", depth: 1 });
        expect(byDepth[1]).toEqual({ title: "Beginner", depth: 2 });
        // Terminated (finite result), didn't hang — the depth guard held.
        expect(chain.length).toBeLessThanOrEqual(10);
        expect(chain.every((r) => r.depth <= 10)).toBe(true);
      })));
  });
});
