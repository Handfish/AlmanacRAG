import "./env.js";
import { ExtractedCourse } from "@catalog/domain/extraction";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { GeminiApiKey, GeminiExtractionModel, generateStructured } from "./adapters/ai-gemini.js";
import { SqlLive } from "./adapters/sql-live.js";
import type { StoredPageFields } from "./extraction/derive.js";
import { persistExtraction, recordExtractionFailure } from "./extraction/persist.js";
import { PROMPT_VERSION, SYSTEM } from "./extraction/prompt.js";

// Synchronous Gemini extraction runner (§16 M2) — the immediate-feedback sibling of
// main-extract-batch.ts, and the path that actually works here: the Anthropic
// `generateObject` route hits Anthropic's 16-union-parameter tool-schema limit (our
// single ExtractedCourse has 21 nullable fields), while Gemini's native `nullable`
// JSON schema has no such cap. Table-driven resume (ADR-I6): extract every page with
// raw_markdown that has no listing yet. Run with a key:
//   GEMINI_API_KEY=… pnpm --filter @catalog/server extract:sync
// Knobs: EXTRACT_LIMIT (0 = all), EXTRACT_CONCURRENCY (default 6), GEMINI_EXTRACTION_MODEL.

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
  const apiKey = yield* GeminiApiKey;
  const model = yield* GeminiExtractionModel;
  const limitStr = yield* Config.string("EXTRACT_LIMIT").pipe(Config.withDefault("0"));
  const concurrencyStr = yield* Config.string("EXTRACT_CONCURRENCY").pipe(Config.withDefault("6"));
  const limit = Number.parseInt(limitStr, 10) || 0;
  const concurrency = Math.max(1, Number.parseInt(concurrencyStr, 10) || 6);
  const effectiveLimit = limit > 0 ? limit : 2147483647;

  const pages = yield* sql<PageRow>`
    SELECT p.id::text AS id, p.url, p.group_url, p.raw_markdown, p.page_fields
    FROM cecc_course_index_course_listing p
    WHERE p.raw_markdown IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM listing l WHERE l.source_page_id = p.id)
    ORDER BY p.id
    LIMIT ${effectiveLimit}
  `;

  yield* Console.log(
    `Extracting ${pages.length} page(s) synchronously via ${model} at concurrency ${concurrency}…`,
  );

  const recordFail = (page: PageRow, error: string) =>
    recordExtractionFailure({
      sourcePageId: page.id,
      crawlRunId: null,
      modelName: model,
      promptVersion: PROMPT_VERSION,
      status: "schema_error",
      error,
    }).pipe(Effect.as<Outcome>({ ok: false, url: page.url, error }));

  const extractOne = (page: PageRow) =>
    generateStructured(
      apiKey,
      model,
      SYSTEM,
      `Extract the course from this catalog page:\n\n${page.rawMarkdown}`,
    ).pipe(
      Effect.flatMap((res) => {
        if (res.text === null) return recordFail(page, "empty response");
        let parsed: unknown;
        try {
          parsed = JSON.parse(res.text);
        } catch (e) {
          return recordFail(page, `json parse: ${String(e)}`);
        }
        return Schema.decodeUnknownEffect(ExtractedCourse)(parsed).pipe(
          Effect.matchEffect({
            onFailure: (err) => recordFail(page, `decode: ${String(err)}`),
            onSuccess: (extracted) =>
              persistExtraction({
                sourcePageId: page.id,
                crawlRunId: null,
                modelName: model,
                promptVersion: PROMPT_VERSION,
                extracted,
                pageFields: page.pageFields ?? {},
                ctx: { detailUrl: page.url, groupUrl: page.groupUrl },
                inputTokens: res.inputTokens,
                outputTokens: res.outputTokens,
              }).pipe(Effect.map((p): Outcome => ({ ok: true, url: page.url, alerts: p.alerts }))),
          }),
        );
      }),
      Effect.catchTag("GeminiBatchError", (e) => recordFail(page, `gemini: ${e.message}`)),
    );

  const outcomes = yield* Effect.forEach(pages, extractOne, { concurrency });

  let ok = 0;
  let failed = 0;
  for (const outcome of outcomes) {
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
  yield* Console.log(`Done: ${ok} ok, ${failed} schema_error.`);
});

NodeRuntime.runMain(program.pipe(Effect.provide(Layer.mergeAll(SqlLive))));
