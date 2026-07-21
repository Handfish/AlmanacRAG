import "../env.js";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchPageSourceLive } from "../adapters/fetch-page-source.js";
import { SqlLive } from "../adapters/sql-live.js";
import { AppConfig } from "../config.js";
import { runCrawl } from "./crawl.js";
import { Robots } from "./robots.js";

// Phase-1 crawl entrypoint. Runs the re-crawl against the live catalog and prints
// a summary. Migrations must already be applied (`pnpm --filter @catalog/server
// migrate`). Politeness/scale knobs via env:
//   CRAWL_LIMIT        cap the seed set (a bounded sample run)
//   CRAWL_CONCURRENCY  parallel fetches (default 4)
//   CRAWL_DELAY_MS     min delay per fetch per worker (default 250)
//   CECC_INDEX_URL     override the discovery index

const numEnv = (key: string): number | undefined => {
  const v = process.env[key];
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const program = Effect.gen(function*() {
  const config = yield* AppConfig;
  const limit = numEnv("CRAWL_LIMIT");
  const concurrency = numEnv("CRAWL_CONCURRENCY");
  const minDelayMs = numEnv("CRAWL_DELAY_MS");

  const summary = yield* runCrawl({
    indexUrl: config.ceccIndexUrl,
    ...(limit !== undefined ? { limit } : {}),
    ...(concurrency !== undefined ? { concurrency } : {}),
    ...(minDelayMs !== undefined ? { minDelayMs } : {}),
  });

  yield* Console.log("\n── Phase 1 crawl summary ─────────────────────────────");
  yield* Console.log(JSON.stringify(summary, null, 2));
});

const CrawlLive = Layer.mergeAll(
  SqlLive,
  FetchPageSourceLive,
  Robots.Default,
  AppConfig.Default,
);

NodeRuntime.runMain(program.pipe(Effect.provide(CrawlLive)));
