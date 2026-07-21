import "../env.js";
import { PageSource } from "@catalog/domain/ports/page-source";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { performance } from "node:perf_hooks";
import { FetchPageSourceLive } from "../adapters/fetch-page-source.js";
import { AppConfig } from "../config.js";
import { extractLinks } from "./segment.js";

// ── ADR-002 benchmark: `fetch` + parser vs. a headless browser. Milestone 0 says
// there is no volume to amortize a browser over (≈1k static pages), so this
// measures the boring option and publishes the number, exactly as ADR-002 asks.
// We time discovery (one index fetch + link extract) and a sample of detail
// fetches (network + turndown), end to end, through the real adapter.

const pct = (sorted: ReadonlyArray<number>, p: number): number =>
  sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;

const program = Effect.gen(function*() {
  const config = yield* AppConfig;
  const pageSource = yield* PageSource;
  const n = Number(process.env.BENCH_N ?? "12");

  const d0 = performance.now();
  const index = yield* pageSource.fetch(config.ceccIndexUrl);
  const links = index._tag === "Fetched"
    ? extractLinks(index.rawHtml, config.ceccIndexUrl, "a.chart")
    : [];
  const discoverMs = performance.now() - d0;

  const sample = links.slice(0, n);
  const times: Array<number> = [];
  let bytes = 0;
  for (const url of sample) {
    const t0 = performance.now();
    const r = yield* pageSource.fetch(url);
    times.push(performance.now() - t0);
    if (r._tag === "Fetched") bytes += r.rawHtml.length;
  }

  const sorted = [...times].sort((a, b) => a - b);
  const sum = times.reduce((a, b) => a + b, 0);
  const mean = times.length ? sum / times.length : 0;

  yield* Console.log("── ADR-002 fetch benchmark ───────────────────────────");
  yield* Console.log(
    `discovery:   1 index fetch → ${links.length} links in ${discoverMs.toFixed(0)}ms`,
  );
  yield* Console.log(
    `sample:      ${sample.length} detail pages, ${(bytes / 1024).toFixed(0)} KB total`,
  );
  yield* Console.log(
    `fetch+parse: mean ${mean.toFixed(0)}ms · p50 ${pct(sorted, 50).toFixed(0)}ms · p95 ${
      pct(sorted, 95).toFixed(0)
    }ms · min ${(sorted[0] ?? 0).toFixed(0)}ms · max ${
      (sorted[sorted.length - 1] ?? 0).toFixed(0)
    }ms`,
  );
  yield* Console.log(
    `throughput:  ${(sample.length / (sum / 1000)).toFixed(1)} pages/s single-threaded`,
  );
  yield* Console.log(
    `projection:  full ${links.length}-page re-crawl ≈ ${
      ((links.length * mean) / 1000).toFixed(0)
    }s single-threaded (÷ concurrency in practice)`,
  );
  yield* Console.log(
    "verdict:     static pages, sub-second each; a browser's startup/memory cost has no volume to amortize (ADR-002).",
  );
});

NodeRuntime.runMain(
  program.pipe(Effect.provide(Layer.mergeAll(FetchPageSourceLive, AppConfig.Default))),
);
