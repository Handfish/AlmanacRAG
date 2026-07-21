import { Extractor } from "@catalog/domain/ports/extractor";
import * as Effect from "effect/Effect";
import { ExtractionModel } from "../adapters/ai-anthropic.js";
import { PROMPT_VERSION } from "../adapters/extractor-anthropic.js";
import type { DeriveContext, StoredPageFields } from "./derive.js";
import { persistExtraction, recordExtractionFailure } from "./persist.js";

// Orchestration (architecture.md §6/§9): extract one page through the Extractor
// port, then persist. The failure path is first-class — a page the model refuses or
// mis-decodes gets a typed `schema_error` extraction row and NO listing, rather than
// a half-written or silently-null row.

export interface ExtractPageInput {
  readonly sourcePageId: string;
  readonly rawMarkdown: string;
  readonly pageFields: StoredPageFields;
  readonly ctx: DeriveContext;
  readonly crawlRunId: number | null;
}

export type ExtractPageOutcome =
  | {
    readonly ok: true;
    readonly courseId: string;
    readonly listingId: string;
    readonly alerts: ReadonlyArray<string>;
  }
  | { readonly ok: false; readonly error: string; };

export const extractPage = (input: ExtractPageInput) =>
  Effect.gen(function*() {
    const modelName = yield* ExtractionModel;
    const extractor = yield* Extractor;

    // Both arms handle their outcome, so this never fails — a bad extract becomes a
    // typed schema_error row and an `ok: false` result, not an error on the channel.
    return yield* extractor.extract({ rawMarkdown: input.rawMarkdown }).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          recordExtractionFailure({
            sourcePageId: input.sourcePageId,
            crawlRunId: input.crawlRunId,
            modelName,
            promptVersion: PROMPT_VERSION,
            status: "schema_error",
            error: error.message,
          }).pipe(Effect.as({ ok: false as const, error: error.message })),
        onSuccess: (extracted) =>
          persistExtraction({
            sourcePageId: input.sourcePageId,
            crawlRunId: input.crawlRunId,
            modelName,
            promptVersion: PROMPT_VERSION,
            extracted,
            pageFields: input.pageFields,
            ctx: input.ctx,
            inputTokens: null,
            outputTokens: null,
          }).pipe(Effect.map((persisted) => ({
            ok: true as const,
            courseId: persisted.courseId,
            listingId: persisted.listingId,
            alerts: persisted.alerts,
          }))),
      }),
    );
  });
