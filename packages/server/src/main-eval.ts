import "./env.js";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { AnswererGeminiLive } from "./adapters/answerer-gemini.js";
import { EmbedderGeminiLive } from "./adapters/embedder-gemini.js";
import { JudgeGeminiLive } from "./adapters/judge-gemini.js";
import { PgKnowledgeBaseLive } from "./adapters/pg-knowledge-base.js";
import { RouterGeminiLive } from "./adapters/router-gemini.js";
import { ROUTER_VERSION } from "./adapters/router-prompt.js";
import { SqlLive } from "./adapters/sql-live.js";
import { gate, type MetricSnapshot } from "./eval/gate.js";
import { EVAL_TODAY } from "./eval/golden-set.js";
import { formatReport, summarize } from "./eval/report.js";
import { runEval } from "./eval/runner.js";

// The Phase-4 exit runner (§16 M4): run the golden set through router + retrieval, write
// `eval_run`/`eval_result`, print the §11.2 report, and enforce the §11.4 CI gate against
// the committed baseline. Run after `migrate` + `eval:seed`:
//   GEMINI_API_KEY=… pnpm --filter @catalog/server eval
// Knobs: EVAL_CONCURRENCY (default 5, §11.3) · EVAL_GATE=0 to skip the gate ·
//        EVAL_WRITE_BASELINE=1 to (re)record baseline.json from this run.

const BASELINE_URL = new URL("./eval/baseline.json", import.meta.url);

const gitSha = (() => {
  try {
    // stderr ignored: a repo with no commits yet (pre-first-commit) just yields "local".
    return execSync("git rev-parse HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim() || "local";
  } catch {
    return "local";
  }
})();

const program = Effect.gen(function*() {
  const concurrency = yield* Config.string("EVAL_CONCURRENCY").pipe(
    Config.withDefault("5"),
    Config.map((s) => Math.max(1, Number.parseInt(s, 10) || 5)),
  );
  const doGate = yield* Config.string("EVAL_GATE").pipe(
    Config.withDefault("1"),
    Config.map((s) => s !== "0"),
  );
  const writeBaseline = yield* Config.string("EVAL_WRITE_BASELINE").pipe(
    Config.withDefault("0"),
    Config.map((s) => s === "1"),
  );
  const embeddingModel = yield* Config.string("GEMINI_EMBEDDING_MODEL").pipe(
    Config.withDefault("gemini-embedding-001"),
  );
  // Phase 5 (§11.2): score prose_faithful via the answer agent + LlmJudge. Opt-in — two
  // extra LLM calls/item — so the cheap router+retrieval gate (§11.4) is the default path.
  const evalProse = yield* Config.string("EVAL_PROSE").pipe(
    Config.withDefault("0"),
    Config.map((s) => s === "1"),
  );

  yield* Console.log(
    `Running eval (concurrency ${concurrency}, today ${EVAL_TODAY.toISOString().slice(0, 10)}${
      evalProse ? ", +prose_faithful" : ""
    })…`,
  );
  const { runId, results } = yield* runEval({
    today: EVAL_TODAY,
    gitSha,
    routerVersion: ROUTER_VERSION,
    embeddingModel,
    termsObserved: 1, // §11.1 — the observation window; recorded so old runs stay interpretable
    concurrency,
    evalProse,
  });

  const summary = summarize(results);
  yield* Console.log(formatReport(summary, { runId, gitSha }));

  if (writeBaseline) {
    writeFileSync(BASELINE_URL, `${JSON.stringify(summary.snapshot, null, 2)}\n`);
    yield* Console.log(`\nWrote baseline.json: ${JSON.stringify(summary.snapshot)}`);
    return;
  }

  if (doGate) {
    let baseline: MetricSnapshot | null = null;
    try {
      baseline = JSON.parse(readFileSync(BASELINE_URL, "utf8")) as MetricSnapshot;
    } catch {
      baseline = null;
    }
    if (baseline === null) {
      yield* Console.log(
        "\nNo baseline.json yet — skipping gate. Record one with EVAL_WRITE_BASELINE=1.",
      );
      return;
    }
    const result = gate(summary.snapshot, baseline);
    if (result.passed) {
      yield* Console.log(
        `\n✅ CI gate PASSED vs baseline (filter_exact ${
          baseline.filterExactPct.toFixed(1)
        }%, nDCG@10 ${baseline.ndcg10Pct.toFixed(1)}).`,
      );
    } else {
      yield* Console.log(`\n❌ CI gate FAILED (§11.4):`);
      for (const r of result.regressions) yield* Console.log(`   • ${r}`);
      process.exitCode = 1;
    }
  }
});

const RetrievalLive = PgKnowledgeBaseLive.pipe(Layer.provide(EmbedderGeminiLive));

// Router + retrieval are always needed; Answerer + Judge only when EVAL_PROSE=1, but
// providing them unconditionally is cheap (layers are built lazily) and keeps wiring simple.
NodeRuntime.runMain(
  program.pipe(
    Effect.provide(RetrievalLive),
    Effect.provide(RouterGeminiLive),
    Effect.provide(AnswererGeminiLive),
    Effect.provide(JudgeGeminiLive),
    Effect.provide(SqlLive),
  ),
);
