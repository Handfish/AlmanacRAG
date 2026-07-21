import { EmbedError } from "@catalog/domain/errors";
import { Embedder, type EmbedTask } from "@catalog/domain/ports/embedder";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

// The Embedder adapter (plan §5.2 / ADR-I1, R3) — the single file carrying the
// embeddings vendor dependency behind the first-party `Embedder` port. Talks to
// Gemini's native `:batchEmbedContents` REST endpoint (there is no Effect v4 Google
// provider at this beta, and embeddings aren't on the OpenAI-compat surface), exactly
// as the Gemini batch EXTRACTOR does — one-file blast radius (§4).
//
// `gemini-embedding-001` is an asymmetric retrieval model: the corpus is embedded
// with taskType RETRIEVAL_DOCUMENT, the query with RETRIEVAL_QUERY (§7.2). Output
// width is a config knob (MRL: 768 / 1536 / 3072); the `chunk_embedding.embedding`
// column is unsized `halfvec` so the width is decided here, not in DDL. Sub-3072 MRL
// vectors aren't unit-norm from the API, so we L2-normalize — a no-op for cosine
// ranking (`<=>` is scale-invariant), but it keeps the stored vectors clean.

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const BATCH_SIZE = 100; // Gemini caps batchEmbedContents at 100 requests per call

/** Embedding model — a config knob and the §11.5 ablation seam. */
export const EmbeddingModel = Config.string("EMBEDDING_MODEL").pipe(
  Config.withDefault("gemini-embedding-001"),
);

/** Output width (MRL). 1536 halves storage vs 3072 at negligible quality cost. */
export const EmbeddingDimensions = Config.string("EMBEDDING_DIMENSIONS").pipe(
  Config.withDefault("1536"),
  Config.map((s) => Number.parseInt(s, 10) || 1536),
);

// The key is OPTIONAL at layer-build time so `main.ts` and the health endpoint boot
// without a secret; a missing key fails at CALL time as a typed EmbedError.
const OptionalApiKey = Config.redacted("GEMINI_API_KEY").pipe(
  Config.option,
  Config.map(Option.getOrUndefined),
);

const taskTypeOf = (task: EmbedTask): string =>
  task === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT";

const l2normalize = (v: ReadonlyArray<number>): ReadonlyArray<number> => {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  return norm > 0 ? v.map((x) => x / norm) : v;
};

const chunkArray = <A>(items: ReadonlyArray<A>, size: number): ReadonlyArray<ReadonlyArray<A>> => {
  const out: Array<ReadonlyArray<A>> = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** One :batchEmbedContents call for up to BATCH_SIZE texts. */
const embedOneBatch = (
  apiKey: Redacted.Redacted<string>,
  model: string,
  dimensions: number,
  texts: ReadonlyArray<string>,
  task: EmbedTask,
): Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, EmbedError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const body = {
        requests: texts.map((text) => ({
          model: `models/${model}`,
          content: { parts: [{ text }] },
          taskType: taskTypeOf(task),
          outputDimensionality: dimensions,
        })),
      };
      const res = await fetch(`${BASE_URL}/models/${model}:batchEmbedContents`, {
        method: "POST",
        signal,
        headers: {
          "x-goog-api-key": Redacted.value(apiKey),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const responseText = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${responseText.slice(0, 500)}`);
      const parsed = JSON.parse(responseText) as {
        embeddings?: ReadonlyArray<{ values?: ReadonlyArray<number>; }>;
      };
      const embeddings = parsed.embeddings ?? [];
      if (embeddings.length !== texts.length) {
        throw new Error(`expected ${texts.length} embeddings, got ${embeddings.length}`);
      }
      return embeddings.map((e, i) => {
        const values = e.values;
        if (!Array.isArray(values) || values.length === 0) {
          throw new Error(`embedding ${i} had no values`);
        }
        return l2normalize(values);
      });
    },
    catch: (cause) => new EmbedError({ message: "Gemini embedContents failed", cause }),
  });

export const EmbedderGeminiLive = Layer.effect(
  Embedder,
  Effect.gen(function*() {
    const apiKey = yield* OptionalApiKey;
    const modelName = yield* EmbeddingModel;
    const dimensions = yield* EmbeddingDimensions;
    return {
      modelName,
      dimensions,
      embed: (texts, task) =>
        apiKey === undefined
          ? Effect.fail(new EmbedError({ message: "GEMINI_API_KEY not set" }))
          : texts.length === 0
          ? Effect.succeed([])
          : Effect.forEach(
            chunkArray(texts, BATCH_SIZE),
            (group) => embedOneBatch(apiKey, modelName, dimensions, group, task),
            { concurrency: 4 },
          ).pipe(Effect.map((groups) => groups.flat())),
    };
  }),
);
