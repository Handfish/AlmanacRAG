import "./env.js";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { EmbedderGeminiLive } from "./adapters/embedder-gemini.js";
import { EmbeddingModel } from "./adapters/embedder-gemini.js";
import { PgKnowledgeBaseLive } from "./adapters/pg-knowledge-base.js";
import { RerankerBgeLive } from "./adapters/reranker-bge.js";
import { RouterGeminiLive } from "./adapters/router-gemini.js";
import { SqlLive } from "./adapters/sql-live.js";
import {
  type AblationReportInput,
  formatAblationTable,
  formatConsoleSummary,
} from "./eval/ablation-report.js";
import { runAblation } from "./eval/ablation.js";
import { runCompactBaseline } from "./eval/compact-baseline.js";
import { noPrefixModelName } from "./retrieval/index-noprefix.js";

// The Phase-8 ablation runner (§16 M8) — fills the §11.5 table by query shape, plus the two
// baselines. Run after `ablate:prep` (which builds the no-prefix embedding set):
//   GEMINI_API_KEY=… pnpm --filter @catalog/server ablate
// Knobs: ABLATE_CONCURRENCY (default 5) · ABLATE_BASELINE=0 to skip the compact-index LLM
//        run · ABLATE_OUT=path.md to also write the markdown table · RERANKER_URL to actually
//        measure the reranker (else the +reranker row is an identity pass).

const gitSha = (() => {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim() || "local";
  } catch {
    return "local";
  }
})();

/** Resolve an embedding model_id by name, or die with a clear instruction. */
const modelIdByName = (name: string, hint: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ id: number; }>`
      SELECT id FROM model WHERE name = ${name} AND kind = 'embedding'`;
    const id = rows[0]?.id;
    if (id === undefined) {
      return yield* Effect.die(`No embedding model '${name}'. ${hint}`);
    }
    return id;
  });

/** Max staleness (hours) of a live served card — the §10.4 freshness number. */
const freshMaxHours = Effect.gen(function*() {
  const sql = yield* SqlClient;
  const rows = yield* sql<{ hours: number | null; }>`
    SELECT ceil(extract(epoch FROM (now() - min(coalesce(sp.last_hash_comparison_at, l.last_seen_at))))
                / 3600.0)::int AS hours
    FROM listing l
    LEFT JOIN cecc_course_index_course_listing sp ON sp.id = l.source_page_id
    WHERE l.disappeared_at IS NULL`;
  return rows[0]?.hours ?? null;
});

const program = Effect.gen(function*() {
  const concurrency = yield* Config.string("ABLATE_CONCURRENCY").pipe(
    Config.withDefault("5"),
    Config.map((s) => Math.max(1, Number.parseInt(s, 10) || 5)),
  );
  const doBaseline = yield* Config.string("ABLATE_BASELINE").pipe(
    Config.withDefault("1"),
    Config.map((s) => s !== "0"),
  );
  const outPath = yield* Config.string("ABLATE_OUT").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  );
  const rerankerUrl = yield* Config.string("RERANKER_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  );
  const embeddingModel = yield* EmbeddingModel;

  const withPrefixModelId = yield* modelIdByName(
    embeddingModel,
    "Run `pnpm … index` first to build the live embedding set.",
  );
  const noPrefixModelId = yield* modelIdByName(
    noPrefixModelName(embeddingModel),
    "Run `pnpm … ablate:prep` first to build the no-prefix embedding set.",
  );
  const fresh = yield* freshMaxHours;

  yield* Console.log(
    `Running §11.5 ablation (concurrency ${concurrency}, reranker ${
      rerankerUrl === undefined ? "IDENTITY (no RERANKER_URL)" : rerankerUrl
    })…`,
  );
  const ablation = yield* runAblation({ withPrefixModelId, noPrefixModelId, concurrency });

  const baseline = doBaseline
    ? yield* (Console.log("Running the compact-index baseline (§1.1)…").pipe(
      Effect.flatMap(() => runCompactBaseline(concurrency)),
    ))
    : null;

  const reportInput: AblationReportInput = {
    rows: ablation.rows,
    baseline,
    crossover: null, // the crossover is a separate run (`pnpm … crossover`)
    freshMaxHours: fresh,
    itemCount: ablation.itemCount,
    gitSha,
  };

  yield* Console.log(formatConsoleSummary(reportInput));

  if (outPath !== undefined) {
    writeFileSync(outPath, `${formatAblationTable(reportInput)}\n`);
    yield* Console.log(`\nWrote the §11.5 table to ${outPath}`);
  }
});

const RetrievalLive = PgKnowledgeBaseLive.pipe(Layer.provide(EmbedderGeminiLive));

NodeRuntime.runMain(
  program.pipe(
    Effect.provide(RetrievalLive),
    Effect.provide(RouterGeminiLive),
    Effect.provide(EmbedderGeminiLive),
    Effect.provide(RerankerBgeLive),
    Effect.provide(SqlLive),
  ),
);
