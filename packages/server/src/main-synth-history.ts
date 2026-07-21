import "./env.js";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { SqlLive } from "./adapters/sql-live.js";
import { synthesizeAndLoad } from "./history/load-synth.js";

// Load synthetic history into a database for TESTING / DEMO only (Phase 7). The real corpus
// is n=1, so the positive branch of §10.6 (reporting a real multi-term history) has nothing
// to exercise; this fabricates plausible prior terms so it does.
//
// THIS MUST NEVER RUN AGAINST THE REAL CATALOG. History cannot be backfilled (§5.3), and the
// whole product point is that the system must not invent a pattern from insufficient
// observation. So this CLI:
//   • refuses to run unless ALLOW_SYNTHETIC_HISTORY=1 is set explicitly;
//   • tags every row (`synthetic://…`, `prompt_version='synthetic-history'`) and sets an
//     `app_meta` marker `synthetic_history=true` so the DB is self-identifying;
//   • is purely additive (prior terms only) and idempotent (a reload clears prior synth rows).
// Point it at a THROWAWAY scratch DB (a copy of the corpus), never the durable catalog.
//   ALLOW_SYNTHETIC_HISTORY=1 POSTGRES_URL=…scratch… \
//     pnpm --filter @catalog/server synth:history
// Knobs: SYNTH_LIMIT (courses to seed, default 30) · SYNTH_BALANCED=0 to hash archetypes
//        instead of forcing all three across the seed order.

const program = Effect.gen(function*() {
  const allow = yield* Config.string("ALLOW_SYNTHETIC_HISTORY").pipe(Config.withDefault("0"));
  if (allow !== "1") {
    yield* Console.error(
      "✋ Refusing to load synthetic history.\n"
        + "   Synthetic history is a TEST/DEMO fixture and must never touch the real catalog\n"
        + "   (history cannot be backfilled — §5.3). Set ALLOW_SYNTHETIC_HISTORY=1 and point\n"
        + "   POSTGRES_URL at a THROWAWAY scratch DB to proceed.",
    );
    process.exitCode = 1;
    return;
  }

  const limit = yield* Config.string("SYNTH_LIMIT").pipe(
    Config.withDefault("30"),
    Config.map((s) => Math.max(1, Number.parseInt(s, 10) || 30)),
  );
  const balanced = yield* Config.string("SYNTH_BALANCED").pipe(
    Config.withDefault("1"),
    Config.map((s) => s !== "0"),
  );

  yield* Console.log(
    `⚠️  Loading SYNTHETIC history (${limit} courses, ${
      balanced ? "balanced archetypes" : "hashed archetypes"
    }) — this DB will be marked synthetic_history=true.\n`,
  );
  const r = yield* synthesizeAndLoad({ limit, balanced });

  const counts = r.assignments.reduce<Record<string, number>>((acc, a) => {
    acc[a.archetype] = (acc[a.archetype] ?? 0) + 1;
    return acc;
  }, {});
  yield* Console.log(
    `Seeded ${r.seeds} courses; inserted ${r.listings} synthetic prior-term listings.`,
  );
  yield* Console.log(
    `Archetypes: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · ") || "(none)"}`,
  );
  yield* Console.log(
    `Observation window moved back to ${r.observingSince}; terms_observed now ${r.termsObserved}.`,
  );
  yield* Console.log(
    "\nThis is a SYNTHETIC scratch DB. Temporal questions will now report a fabricated"
      + " multi-term history — do NOT treat these answers as real.",
  );
});

NodeRuntime.runMain(program.pipe(Effect.provide(SqlLive)));
