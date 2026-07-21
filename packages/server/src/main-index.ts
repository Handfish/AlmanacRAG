import "./env.js";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { EmbedderGeminiLive } from "./adapters/embedder-gemini.js";
import { SqlLive } from "./adapters/sql-live.js";
import { indexCourses } from "./retrieval/index-courses.js";

// The Phase-3 indexing runner (§16 M3) — build chunks + embeddings over the extracted
// courses. Table-driven resume: only courses lacking an embedding for the active model
// are (re)indexed, so this is safe to re-run. Needs a key:
//   GEMINI_API_KEY=… pnpm --filter @catalog/server index
// Knobs: INDEX_LIMIT (0 = all), INDEX_CONCURRENCY (default 6),
//   CONTEXT_PREFIX (true|false — §7.3 situating prefixes),
//   EMBEDDING_MODEL (default gemini-embedding-001), EMBEDDING_DIMENSIONS (default 1536),
//   CONTEXT_MODEL (default gemini-2.5-flash-lite).
const program = Effect.gen(function*() {
  const limitStr = yield* Config.string("INDEX_LIMIT").pipe(Config.withDefault("0"));
  const concurrencyStr = yield* Config.string("INDEX_CONCURRENCY").pipe(Config.withDefault("6"));
  const prefixStr = yield* Config.string("CONTEXT_PREFIX").pipe(Config.withDefault("true"));
  const limit = Number.parseInt(limitStr, 10) || 0;
  const concurrency = Math.max(1, Number.parseInt(concurrencyStr, 10) || 6);
  const withContextPrefix = prefixStr.toLowerCase() !== "false";

  yield* Console.log(
    `Indexing courses (limit=${
      limit || "all"
    }, concurrency=${concurrency}, contextPrefix=${withContextPrefix})…`,
  );
  const result = yield* indexCourses({ limit, concurrency, withContextPrefix });
  if (result.indexed === 0) {
    yield* Console.log("Nothing to index — every course already has an embedding for this model.");
  } else {
    yield* Console.log(
      `Done: indexed ${result.indexed} course(s) (model_id=${result.modelId}, ${result.withPrefix} with a context prefix).`,
    );
  }
});

NodeRuntime.runMain(program.pipe(Effect.provide(EmbedderGeminiLive), Effect.provide(SqlLive)));
