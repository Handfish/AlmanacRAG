import "./env.js";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { createServer } from "node:http";
import { EmbedderGeminiLive } from "./adapters/embedder-gemini.js";
import { PgKnowledgeBaseLive } from "./adapters/pg-knowledge-base.js";
import { SqlLive } from "./adapters/sql-live.js";
import { AppConfig } from "./config.js";
import { ApiLive } from "./http/api.js";
import { TelemetryLive } from "./telemetry.js";

// The composition root (plan §6.5) — the ONE file that wires every layer.
// Swapping a provider (Anthropic → local, embedder OpenAI → Gemini, reranker on/off
// for §11.5) is an edit here and nowhere else. Phase 3 wires the retrieval port:
// KnowledgeBase over Postgres, backed by the Gemini embedder — serving `/search`.
// Adapters (Extractor/Answerer/…) join as their phases land.

// KnowledgeBase (Phase 3) = hybrid RRF + filter_listings over Postgres, with the
// Gemini embedder for the query side. Still requires SqlClient, satisfied by SqlLive.
const RetrievalLive = PgKnowledgeBaseLive.pipe(Layer.provide(EmbedderGeminiLive));

// The port comes from AppConfig (env PORT, default 3000), so the server layer is
// built inside an Effect that reads it.
const HttpLive = Layer.unwrap(
  Effect.gen(function*() {
    const config = yield* AppConfig;
    return HttpRouter.serve(ApiLive).pipe(
      Layer.provide(RetrievalLive),
      Layer.provide(NodeHttpServer.layer(() => createServer(), { port: config.port })),
    );
  }),
);

const AppLive = HttpLive.pipe(
  Layer.provide(SqlLive),
  Layer.provide(AppConfig.Default),
  Layer.provide(TelemetryLive),
);

NodeRuntime.runMain(Layer.launch(AppLive));
