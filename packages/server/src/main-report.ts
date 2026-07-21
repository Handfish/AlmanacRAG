import "./env.js";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { SqlLive } from "./adapters/sql-live.js";

// Extraction correctness report (architecture.md §9.3, tiers 1–2). Read-only — no
// AI, no writes. Publishes the numbers the design insists on: extraction status
// mix, per-field NULL/unknown rates (a rising rate flags template drift or a weak
// model), and the courseId-shape verification (the tier-1 check, now that families
// are gone). Run after an extraction pass: pnpm --filter @catalog/server report.

const program = Effect.gen(function*() {
  const sql = yield* SqlClient;

  const status = yield* sql<{ status: string; n: number; }>`
    SELECT status, count(*)::int AS n FROM extraction GROUP BY status ORDER BY n DESC`;
  yield* Console.log("── extraction status (§5.5: a typed row per attempt) ──");
  if (status.length === 0) yield* Console.log("  (no extractions yet — run `pnpm … extract`)");
  for (const row of status) yield* Console.log(`  ${row.status.padEnd(14)} ${row.n}`);

  const counts = yield* sql<{ courses: number; listings: number; }>`
    SELECT (SELECT count(*) FROM course)::int AS courses,
           (SELECT count(*) FROM listing)::int AS listings`;
  yield* Console.log(
    `\n  courses ${counts[0]?.courses ?? 0} · listings ${counts[0]?.listings ?? 0}`,
  );

  const nulls = yield* sql<{
    total: number;
    startsNull: number;
    campusUnknown: number;
    deliveryUnknown: number;
    feeNull: number;
    termNull: number;
    eveningNull: number;
  }>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE starts_on IS NULL)::int         AS starts_null,
           count(*) FILTER (WHERE campus = 'unknown')::int        AS campus_unknown,
           count(*) FILTER (WHERE delivery_mode = 'unknown')::int AS delivery_unknown,
           count(*) FILTER (WHERE total_fee_cents IS NULL)::int   AS fee_null,
           count(*) FILTER (WHERE term_season IS NULL)::int       AS term_null,
           count(*) FILTER (WHERE is_evening IS NULL)::int        AS evening_null
    FROM listing`;
  const n = nulls[0];
  if (n && n.total > 0) {
    const pct = (x: number): string => `${Math.round((100 * x) / n.total)}%`;
    yield* Console.log("\n── listing per-field absence (NULL / unknown) ──");
    yield* Console.log(`  starts_on NULL      ${pct(n.startsNull)}`);
    yield* Console.log(`  term_season NULL    ${pct(n.termNull)}`);
    yield* Console.log(`  campus unknown      ${pct(n.campusUnknown)}`);
    yield* Console.log(`  delivery unknown    ${pct(n.deliveryUnknown)}`);
    yield* Console.log(`  total_fee_cents NULL ${pct(n.feeNull)}`);
    yield* Console.log(
      `  is_evening NULL     ${pct(n.eveningNull)} (async has no clock time — expected)`,
    );
  }

  // §9.3 tier-1: is external_course_id a usable code, a slug, or a bare section-id?
  const shape = yield* sql<{ total: number; code: number; bareInt: number; missing: number; }>`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE external_course_id ~ '[A-Za-z]')::int   AS code,
           count(*) FILTER (WHERE external_course_id ~ '^[0-9]+$')::int   AS bare_int,
           count(*) FILTER (WHERE external_course_id IS NULL)::int        AS missing
    FROM course`;
  const s = shape[0];
  if (s && s.total > 0) {
    yield* Console.log("\n── external_course_id shape (§9.3: verify, don't trust) ──");
    yield* Console.log(`  has letters (code-like) ${s.code}`);
    yield* Console.log(`  bare integer (section?) ${s.bareInt}`);
    yield* Console.log(`  missing                 ${s.missing}`);
  }
});

NodeRuntime.runMain(program.pipe(Effect.provide(SqlLive)));
