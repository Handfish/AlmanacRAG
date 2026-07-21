import "./env.js";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { GeminiExtractionModel } from "./adapters/ai-gemini.js";
import { SqlLive } from "./adapters/sql-live.js";
import type { StoredPageFields } from "./extraction/derive.js";
import { type BatchInput, runBatch } from "./extraction/gemini-batch.js";
import { persistExtraction, recordExtractionFailure } from "./extraction/persist.js";
import { PROMPT_VERSION } from "./extraction/prompt.js";

// The Gemini batch runner (§16 M2, cheap-tier ablation) — the batch-mode sibling of
// main-extract.ts. Same table-driven resume (ADR-I6): extract every page with
// `raw_markdown` and no `listing` yet, in ONE Gemini batch job. Run with a key:
//   GEMINI_API_KEY=… pnpm --filter @catalog/server extract:batch
// Knobs: EXTRACT_LIMIT (0 = all), EXTRACT_CONCURRENCY (DB writes, default 4),
//   GEMINI_EXTRACTION_MODEL (default gemini-2.5-flash-lite),
//   GEMINI_BATCH_POLL_SECONDS, GEMINI_BATCH_MAX_MINUTES.

interface PageRow {
  readonly id: string;
  readonly url: string;
  readonly groupUrl: string | null;
  readonly rawMarkdown: string;
  readonly pageFields: StoredPageFields | null;
}

type Outcome =
  | { readonly ok: true; readonly url: string; readonly alerts: ReadonlyArray<string>; }
  | { readonly ok: false; readonly url: string; readonly error: string; };

const program = Effect.gen(function*() {
  const sql = yield* SqlClient;
  const modelName = yield* GeminiExtractionModel;
  const limitStr = yield* Config.string("EXTRACT_LIMIT").pipe(Config.withDefault("0"));
  const concurrencyStr = yield* Config.string("EXTRACT_CONCURRENCY").pipe(Config.withDefault("4"));
  const limit = Number.parseInt(limitStr, 10) || 0;
  const concurrency = Math.max(1, Number.parseInt(concurrencyStr, 10) || 4);
  const effectiveLimit = limit > 0 ? limit : 2147483647;

  const pages = yield* sql<PageRow>`
    SELECT p.id::text AS id, p.url, p.group_url, p.raw_markdown, p.page_fields
    FROM cecc_course_index_course_listing p
    WHERE p.raw_markdown IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM listing l WHERE l.source_page_id = p.id)
    ORDER BY p.id
    LIMIT ${effectiveLimit}
  `;

  if (pages.length === 0) {
    yield* Console.log("Nothing to extract — every page with raw_markdown already has a listing.");
    return;
  }

  yield* Console.log(`Submitting ${pages.length} page(s) to Gemini batch (${modelName})…`);
  const inputs: ReadonlyArray<BatchInput> = pages.map((p) => ({
    key: p.id,
    rawMarkdown: p.rawMarkdown,
  }));
  const results = yield* runBatch(inputs);
  yield* Console.log(`Batch finished: ${results.length} result(s) returned. Persisting…`);

  const byId = new Map(pages.map((p) => [p.id, p]));
  const seen = new Set<string>();

  const persistOne = (
    page: PageRow,
    extracted: (typeof results)[number]["extracted"],
    error: string | null,
    inputTokens: number | null,
    outputTokens: number | null,
  ) =>
    extracted !== null
      ? persistExtraction({
        sourcePageId: page.id,
        crawlRunId: null,
        modelName,
        promptVersion: PROMPT_VERSION,
        extracted,
        pageFields: page.pageFields ?? {},
        ctx: { detailUrl: page.url, groupUrl: page.groupUrl },
        inputTokens,
        outputTokens,
      }).pipe(Effect.map((p): Outcome => ({ ok: true, url: page.url, alerts: p.alerts })))
      : recordExtractionFailure({
        sourcePageId: page.id,
        crawlRunId: null,
        modelName,
        promptVersion: PROMPT_VERSION,
        status: "schema_error",
        error: error ?? "unknown",
      }).pipe(Effect.as<Outcome>({ ok: false, url: page.url, error: error ?? "unknown" }));

  const fromBatch = yield* Effect.forEach(results, (r) => {
    seen.add(r.key);
    const page = byId.get(r.key);
    if (page === undefined) return Effect.succeed<Outcome | null>(null); // unknown key — ignore
    return persistOne(page, r.extracted, r.error, r.inputTokens, r.outputTokens);
  }, { concurrency });

  // Pages the batch never returned a result for (uncorrelated / dropped): record a
  // typed schema_error so provenance is complete and table-driven resume re-tries them.
  const missing = pages.filter((p) => !seen.has(p.id));
  const fromMissing = yield* Effect.forEach(
    missing,
    (page) => persistOne(page, null, "no batch result returned for this page", null, null),
    { concurrency },
  );

  let ok = 0;
  let failed = 0;
  for (const outcome of [...fromBatch, ...fromMissing]) {
    if (outcome === null) continue;
    if (outcome.ok) {
      ok += 1;
      if (outcome.alerts.length > 0) {
        yield* Console.log(`  ⚠ ${outcome.url}: ${outcome.alerts.join("; ")}`);
      }
    } else {
      failed += 1;
      yield* Console.log(`  ✗ ${outcome.url}: ${outcome.error}`);
    }
  }
  if (missing.length > 0) {
    yield* Console.log(`  (${missing.length} page(s) had no batch result — recorded for retry)`);
  }
  yield* Console.log(`Done: ${ok} ok, ${failed} schema_error.`);
});

NodeRuntime.runMain(program.pipe(Effect.provide(SqlLive)));
