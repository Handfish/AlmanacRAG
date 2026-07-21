import "./env.js";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { writeFileSync } from "node:fs";
import { SqlAdmin } from "./adapters/sql-admin.js";
import { formatCrossoverTable } from "./eval/ablation-report.js";
import { runCrossover } from "./eval/crossover.js";

// The ADR-004 crossover runner (§11.5) — the synthetic exact/HNSW/DiskANN sweep. Uses
// SqlAdmin (direct :5432 session — it does DDL: CREATE TABLE/INDEX/EXTENSION), NOT the pooled
// client. Run:
//   pnpm --filter @catalog/server crossover
// Knobs: CROSSOVER_SIZES (csv, default 1000,5000,25000,100000) · CROSSOVER_DIMS (default 1536,
//        matching production) · CROSSOVER_QUERIES (default 15) · CROSSOVER_OUT=path.md.
// Larger sizes cost minutes (row generation + HNSW build scale with N·dims); keep the top
// size modest unless you want the tail of the curve.

const parseSizes = (csv: string): ReadonlyArray<number> =>
  csv.split(",").map((s) => Number.parseInt(s.trim(), 10)).filter((n) =>
    Number.isFinite(n) && n > 0
  );

const program = Effect.gen(function*() {
  const sizes = yield* Config.string("CROSSOVER_SIZES").pipe(
    Config.withDefault("1000,5000,25000,100000"),
    Config.map(parseSizes),
  );
  const dims = yield* Config.string("CROSSOVER_DIMS").pipe(
    Config.withDefault("1536"),
    Config.map((s) => Number.parseInt(s, 10) || 1536),
  );
  const queries = yield* Config.string("CROSSOVER_QUERIES").pipe(
    Config.withDefault("15"),
    Config.map((s) => Number.parseInt(s, 10) || 15),
  );
  const outPath = yield* Config.string("CROSSOVER_OUT").pipe(
    Config.withDefault(""),
    Config.map((s) => (s.trim() === "" ? undefined : s.trim())),
  );

  yield* Console.log(
    `ADR-004 crossover sweep: sizes=[${sizes.join(", ")}] dims=${dims} queries=${queries}\n`
      + `(this runs sequential + HNSW builds — larger N takes minutes)…`,
  );
  const report = yield* runCrossover({ sizes, dims, queries, k: 10 });
  const table = formatCrossoverTable(report);
  yield* Console.log(`\n${table}`);

  if (outPath !== undefined) {
    writeFileSync(outPath, `${table}\n`);
    yield* Console.log(`\nWrote the crossover table to ${outPath}`);
  }
});

NodeRuntime.runMain(program.pipe(Effect.provide(SqlAdmin)));
