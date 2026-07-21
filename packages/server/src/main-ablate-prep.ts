import "./env.js";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { EmbedderGeminiLive } from "./adapters/embedder-gemini.js";
import { SqlLive } from "./adapters/sql-live.js";
import { indexNoPrefixEmbeddings } from "./retrieval/index-noprefix.js";

// Phase-8 prep (§11.5 "+ contextual prefixes" row) — build the no-prefix embedding set so
// the ablation can isolate the §7.3 prefix as a single variable. Additive + idempotent: it
// only writes `chunk_embedding` under the `::noprefix` model row, never touching the live
// index. Run once before `ablate`:
//   GEMINI_API_KEY=… pnpm --filter @catalog/server ablate:prep
// Knob: ABLATE_PREP_LIMIT (0 = all chunks).
const program = Effect.gen(function*() {
  const limit = yield* Config.string("ABLATE_PREP_LIMIT").pipe(
    Config.withDefault("0"),
    Config.map((s) => Number.parseInt(s, 10) || 0),
  );
  yield* Console.log("Building the no-prefix embedding set for the §11.5 ablation…");
  const result = yield* indexNoPrefixEmbeddings({ limit });
  yield* Console.log(
    result.embedded === 0
      ? `Nothing to embed — the ::noprefix set (model_id=${result.modelId}) is already complete.`
      : `Done: embedded ${result.embedded} chunk(s) with NO context prefix (model_id=${result.modelId}).`,
  );
});

NodeRuntime.runMain(program.pipe(Effect.provide(EmbedderGeminiLive), Effect.provide(SqlLive)));
