import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { EmbedError } from "../errors.js";

// Turns text into vectors. Adapter (Phase 3): Gemini `gemini-embedding-001` via
// :batchEmbedContents (adapters/embedder-gemini.ts). No vendor import here — §4.
//
// `task` distinguishes the corpus side from the query side (architecture.md §7.2):
// document embeddings are stored in `chunk_embedding`, query embeddings are computed
// per search and never persisted. Providers with asymmetric retrieval models
// (Gemini's RETRIEVAL_DOCUMENT vs RETRIEVAL_QUERY) need the hint; a symmetric model
// ignores it. `modelName`/`dimensions` are surfaced because the retrieval layer must
// register the `model` row (§5.4) and knows the halfvec width by construction.
export type EmbedTask = "document" | "query";

export type EmbedderShape = {
  readonly modelName: string;
  readonly dimensions: number;
  readonly embed: (
    texts: ReadonlyArray<string>,
    task: EmbedTask,
  ) => Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, EmbedError>;
};

export class Embedder extends Context.Service<Embedder, EmbedderShape>()("catalog/Embedder") {}
