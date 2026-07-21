import "./env.js";
import { Embedder } from "@catalog/domain/ports/embedder";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { EmbedderGeminiLive } from "./adapters/embedder-gemini.js";
import { SqlLive } from "./adapters/sql-live.js";
import { hybridRrf } from "./retrieval/hybrid-rrf.js";

// The Phase-3 exit criterion, made runnable (§16 M3): run a hybrid search and MEASURE
// the exact-scan latency (ADR-004 — "sub-millisecond, faster than HNSW, at 100%
// recall"). The query is embedded ONCE (that network hop is not the scan); then the
// single fused RRF statement is timed over N iterations against the live corpus.
//   GEMINI_API_KEY=… SEARCH_QUERY="grant writing" pnpm --filter @catalog/server search
const program = Effect.gen(function*() {
  const sql = yield* SqlClient;
  const embedder = yield* Embedder;
  const query = yield* Config.string("SEARCH_QUERY").pipe(
    Config.withDefault("leadership and management for school administrators"),
  );
  const limit = yield* Config.string("SEARCH_LIMIT").pipe(
    Config.withDefault("10"),
    Config.map((s) => Number.parseInt(s, 10) || 10),
  );
  const iters = yield* Config.string("SEARCH_ITERS").pipe(
    Config.withDefault("25"),
    Config.map((s) => Number.parseInt(s, 10) || 25),
  );

  const models = yield* sql<{ id: number; }>`
    SELECT id FROM model WHERE name = ${embedder.modelName} AND kind = 'embedding'`;
  const modelId = models[0]?.id;
  if (modelId === undefined) {
    yield* Console.log("No embedding model indexed yet — run `pnpm … index` first.");
    return;
  }
  const counts = yield* sql<{ n: number; }>`
    SELECT count(*)::int AS n FROM chunk_embedding WHERE model_id = ${modelId}`;
  const vectors = counts[0]?.n ?? 0;
  yield* Console.log(
    `Query: ${
      JSON.stringify(query)
    }\n${vectors} vectors indexed (model=${embedder.modelName}, dim=${embedder.dimensions}, model_id=${modelId})\n`,
  );
  if (vectors === 0) {
    yield* Console.log("No vectors indexed — run `pnpm … index` first.");
    return;
  }

  const embedded = yield* embedder.embed([query], "query");
  const vec = embedded[0];
  if (vec === undefined) {
    yield* Console.log("Query produced no embedding.");
    return;
  }

  const runRrf = hybridRrf({ queryEmbedding: vec, modelId, queryText: query, limit });

  // Warm up (plan the query, fill caches), then time the pure exact scan N times.
  const hits = yield* runRrf;
  const millis: Array<number> = [];
  for (let i = 0; i < iters; i++) {
    const [dur] = yield* Effect.timed(runRrf);
    millis.push(Duration.toMillis(dur));
  }
  millis.sort((a, b) => a - b);
  const mean = millis.reduce((s, x) => s + x, 0) / millis.length;
  const at = (p: number) => millis[Math.min(millis.length - 1, Math.floor(p * millis.length))]!;

  yield* Console.log(`Top ${hits.length} fused course(s):`);
  for (const [i, h] of hits.entries()) {
    yield* Console.log(`  ${i + 1}. [${h.rrf.toFixed(5)}] ${h.courseTitle ?? "(untitled)"}`);
  }
  yield* Console.log(
    `\nExact-scan latency over ${iters} runs (ms): `
      + `min ${at(0).toFixed(2)} · p50 ${at(0.5).toFixed(2)} · mean ${mean.toFixed(2)} · `
      + `p95 ${at(0.95).toFixed(2)} · max ${millis[millis.length - 1]!.toFixed(2)}`,
  );
});

NodeRuntime.runMain(program.pipe(Effect.provide(EmbedderGeminiLive), Effect.provide(SqlLive)));
