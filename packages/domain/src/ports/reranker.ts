import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { RerankError } from "../errors.js";

// Reorders candidate documents for a query (bge-reranker-v2-m3 over HTTP, §11.6).
// The adapter degrades to identity on failure so the service stays up (§14).

export type RerankerShape = {
  // Returns a relevance score per input document, aligned by index.
  readonly rerank: (
    query: string,
    documents: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<number>, RerankError>;
};

export class Reranker extends Context.Service<Reranker, RerankerShape>()("catalog/Reranker") {}
