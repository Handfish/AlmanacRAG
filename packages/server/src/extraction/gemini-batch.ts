import { ExtractedCourse } from "@catalog/domain/extraction";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  createBatch,
  GeminiApiKey,
  GeminiBatchError,
  GeminiExtractionModel,
  GeminiMaxMinutes,
  GeminiPollSeconds,
  getBatch,
  RESPONSE_SCHEMA,
} from "../adapters/ai-gemini.js";
import { SYSTEM } from "./prompt.js";

// Gemini batch orchestration (architecture.md §9): submit one inline batch of the
// pages needing extraction, poll the long-running job, then decode EACH result
// through the domain `ExtractedCourse` schema — the same decode the synchronous
// Anthropic path uses. A page whose output will not decode yields `extracted: null`
// + an `error`; the caller writes it as a typed `schema_error` row, never a silent
// null. Batch trades latency (minutes) for ~50% cost (§ extraction cost ablation).

export interface BatchInput {
  readonly key: string; // the source_page_id — round-trips via Gemini per-request metadata
  readonly rawMarkdown: string;
}

export interface BatchItemResult {
  readonly key: string;
  readonly extracted: ExtractedCourse | null; // null ⇒ failed (see `error`)
  readonly error: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

// ── Defensive navigation of the batch response ──────────────────────────────
// The exact operation nesting (`response.inlinedResponses[].response…`) can only be
// pinned on a live run, so we read it tolerantly and surface anything unexpected as
// a per-row error rather than crashing the whole batch. Correctness of the DATA is
// enforced by the `ExtractedCourse` decode below regardless of these shapes.
const get = (o: unknown, k: string): unknown =>
  typeof o === "object" && o !== null && k in o ? (o as Record<string, unknown>)[k] : undefined;
const asStr = (o: unknown): string | null => (typeof o === "string" ? o : null);
const asNum = (o: unknown): number | null => (typeof o === "number" ? o : null);
const asArr = (o: unknown): ReadonlyArray<unknown> => (Array.isArray(o) ? o : []);

const stateOf = (batch: unknown): string | null =>
  asStr(get(batch, "state")) ?? asStr(get(get(batch, "metadata"), "state"));

const inlinedOf = (batch: unknown): ReadonlyArray<unknown> => {
  const ir = get(get(batch, "response"), "inlinedResponses");
  return Array.isArray(ir) ? ir : asArr(get(ir, "inlinedResponses"));
};

const textOf = (response: unknown): string | null => {
  const parts = asArr(get(get(asArr(get(response, "candidates"))[0], "content"), "parts"));
  const texts = parts.map((p) => asStr(get(p, "text"))).filter((t): t is string => t !== null);
  return texts.length > 0 ? texts.join("") : asStr(get(response, "text"));
};

const buildRequest = (input: BatchInput) => ({
  request: {
    system_instruction: { parts: [{ text: SYSTEM }] },
    contents: [
      {
        role: "user",
        parts: [{ text: `Extract the course from this catalog page:\n\n${input.rawMarkdown}` }],
      },
    ],
    generation_config: {
      temperature: 0,
      response_mime_type: "application/json",
      response_schema: RESPONSE_SCHEMA,
    },
  },
  metadata: { key: input.key },
});

const decodeEntry = (entry: unknown): Effect.Effect<BatchItemResult | null> => {
  const key = asStr(get(get(entry, "metadata"), "key"));
  if (key === null) return Effect.succeed(null); // uncorrelated — caller reports the count gap

  const response = get(entry, "response");
  const um = get(response, "usageMetadata");
  const inputTokens = asNum(get(um, "promptTokenCount"));
  const outputTokens = asNum(get(um, "candidatesTokenCount"));
  const fail = (error: string): BatchItemResult => ({
    key,
    extracted: null,
    error,
    inputTokens,
    outputTokens,
  });

  const errObj = get(entry, "error");
  if (errObj !== undefined) {
    return Effect.succeed(fail(`gemini: ${JSON.stringify(errObj).slice(0, 300)}`));
  }

  const text = textOf(response);
  if (text === null) return Effect.succeed(fail("empty response"));

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return Effect.succeed(fail(`json parse: ${String(e)}`));
  }
  return Schema.decodeUnknownEffect(ExtractedCourse)(parsed).pipe(
    Effect.match({
      onSuccess: (extracted): BatchItemResult => ({
        key,
        extracted,
        error: null,
        inputTokens,
        outputTokens,
      }),
      onFailure: (err): BatchItemResult => fail(`decode: ${String(err)}`),
    }),
  );
};

/**
 * Submit the inputs as one Gemini batch, wait for it, and decode every result.
 * Fails (GeminiBatchError) only on job/transport failure; per-page decode misses
 * come back as `extracted: null` rows for the caller to record as `schema_error`.
 */
export const runBatch = (inputs: ReadonlyArray<BatchInput>) =>
  Effect.gen(function*() {
    const apiKey = yield* GeminiApiKey;
    const model = yield* GeminiExtractionModel;
    const pollSeconds = yield* GeminiPollSeconds;
    const maxMinutes = yield* GeminiMaxMinutes;

    const body = {
      batch: {
        display_name: `catalog-extract-${inputs.length}`,
        input_config: { requests: { requests: inputs.map(buildRequest) } },
      },
    };

    const created = yield* createBatch(apiKey, model, body);
    const name = asStr(get(created, "name"));
    if (name === null) {
      return yield* Effect.fail(
        new GeminiBatchError({
          message: "batch create returned no operation name",
          cause: created,
        }),
      );
    }

    const maxAttempts = Math.max(1, Math.ceil((maxMinutes * 60) / pollSeconds));
    const poll = (attempt: number): Effect.Effect<unknown, GeminiBatchError> =>
      Effect.gen(function*() {
        const batch = yield* getBatch(apiKey, name);
        const state = stateOf(batch);
        const done = get(batch, "done") === true && get(batch, "response") !== undefined;
        if (state === "JOB_STATE_SUCCEEDED" || done) return batch;
        if (
          state === "JOB_STATE_FAILED" || state === "JOB_STATE_CANCELLED"
          || state === "JOB_STATE_EXPIRED"
        ) {
          return yield* Effect.fail(
            new GeminiBatchError({ message: `batch ${state}`, cause: batch }),
          );
        }
        if (attempt >= maxAttempts) {
          return yield* Effect.fail(
            new GeminiBatchError({
              message: `batch unfinished after ${maxMinutes}m (state=${state ?? "unknown"})`,
            }),
          );
        }
        yield* Effect.sleep(Duration.seconds(pollSeconds));
        return yield* poll(attempt + 1);
      });

    const finished = yield* poll(0);
    const decoded = yield* Effect.forEach(inlinedOf(finished), decodeEntry, {
      concurrency: "unbounded",
    });
    return decoded.filter((r): r is BatchItemResult => r !== null);
  });
