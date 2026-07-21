import "./env.js";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { ExtractorAnthropicLive } from "./adapters/extractor-anthropic.js";
import { SqlLive } from "./adapters/sql-live.js";
import type { StoredPageFields } from "./extraction/derive.js";
import { extractPage } from "./extraction/extract-page.js";

// The Phase-2 batch runner (§16 M2) — the analogue of Phase 1's main-crawl.ts.
// Table-driven resume (ADR-I6 / decision D6): "which pages need extraction?" is a
// query — every page with `raw_markdown` that has no `listing` yet. Run with a key:
//   ANTHROPIC_API_KEY=… pnpm --filter @catalog/server extract
// Knobs: EXTRACT_LIMIT (0 = all), EXTRACT_CONCURRENCY (default 4), EXTRACTION_MODEL.

interface PageRow {
  readonly id: string;
  readonly url: string;
  readonly groupUrl: string | null;
  readonly rawMarkdown: string;
  readonly pageFields: StoredPageFields | null;
}

const program = Effect.gen(function*() {
  const sql = yield* SqlClient;
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

  yield* Console.log(`Extracting ${pages.length} page(s) at concurrency ${concurrency}…`);

  const outcomes = yield* Effect.forEach(
    pages,
    (page) =>
      extractPage({
        sourcePageId: page.id,
        rawMarkdown: page.rawMarkdown,
        pageFields: page.pageFields ?? {},
        ctx: { detailUrl: page.url, groupUrl: page.groupUrl },
        crawlRunId: null,
      }),
    { concurrency },
  );

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i]!;
    if (outcome.ok) {
      ok += 1;
      if (outcome.alerts.length > 0) {
        yield* Console.log(`  ⚠ ${pages[i]!.url}: ${outcome.alerts.join("; ")}`);
      }
    } else {
      failed += 1;
      yield* Console.log(`  ✗ ${pages[i]!.url}: ${outcome.error}`);
    }
  }
  yield* Console.log(`Done: ${ok} ok, ${failed} schema_error.`);
});

NodeRuntime.runMain(program.pipe(Effect.provide(Layer.mergeAll(ExtractorAnthropicLive, SqlLive))));
