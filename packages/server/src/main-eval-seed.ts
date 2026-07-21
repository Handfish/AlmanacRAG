import "./env.js";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { SqlLive } from "./adapters/sql-live.js";
import { seedGoldenSet } from "./eval/seed.js";

// Seed the §11.1 golden set into `eval_item`, resolving `expected_ids` against the live
// corpus. Idempotent — safe to re-run after editing labels. Run after `migrate`:
//   pnpm --filter @catalog/server eval:seed
const program = Effect.gen(function*() {
  const res = yield* seedGoldenSet();
  yield* Console.log(
    `Seeded ${res.inserted}/${res.total} golden items into eval_item`
      + (res.removed > 0 ? ` (reconciled: dropped ${res.removed} orphaned).` : "."),
  );
  if (res.warnings.length > 0) {
    yield* Console.log(`\n${res.warnings.length} warning(s) — label resolved to 0 courses:`);
    for (const w of res.warnings) yield* Console.log(`  ⚠ ${w}`);
  } else {
    yield* Console.log("Every non-refusal item resolved to ≥1 course.");
  }
});

NodeRuntime.runMain(program.pipe(Effect.provide(SqlLive)));
