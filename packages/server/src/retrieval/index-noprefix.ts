import { Embedder } from "@catalog/domain/ports/embedder";
import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { ensureEmbeddingModel, upsertEmbedding } from "./index-courses.js";

// The no-prefix embedding set for the "+ contextual prefixes" ablation row (§7.3 / §11.5).
// The live index (model `gemini-embedding-001`) embeds `context_prefix || text`; to isolate
// the prefix as a single variable we need the SAME chunks embedded from `text` ALONE, under
// a SECOND model row — exactly the multi-model coexistence §5.4 designed `model_id`-in-PK
// for. Additive and idempotent: it reads the existing `chunk` rows and only writes
// `chunk_embedding`, so it NEVER mutates the live index (no `context_prefix` clobber) and a
// re-run only fills chunks still missing this model's vector.

/** The model name for the no-prefix ablation set — the live model with a `::noprefix`
 * suffix, so it is unmistakably the same embedder, prefixes removed. */
export const noPrefixModelName = (liveName: string): string => `${liveName}::noprefix`;

export interface NoPrefixResult {
  readonly modelId: number;
  readonly embedded: number;
}

/**
 * Embed every chunk's raw `text` (no situating prefix) under the `::noprefix` model row.
 * Table-driven resume like the main indexer: only chunks lacking this model's embedding are
 * (re)embedded, so it is safe to re-run and cheap to top up after a re-crawl.
 */
export const indexNoPrefixEmbeddings = (opts: { readonly limit: number; }) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const embedder = yield* Embedder;

    const modelName = noPrefixModelName(embedder.modelName);
    const modelId = yield* ensureEmbeddingModel(modelName, embedder.dimensions);
    const effectiveLimit = opts.limit > 0 ? opts.limit : 2147483647;

    const chunks = yield* sql<{ id: string; text: string; }>`
      SELECT ch.id::text AS id, ch.text
      FROM chunk ch
      WHERE ch.ord = 0
        AND NOT EXISTS (
          SELECT 1 FROM chunk_embedding e
          WHERE e.chunk_id = ch.id AND e.model_id = ${modelId}
        )
      ORDER BY ch.id
      LIMIT ${effectiveLimit}
    `;
    if (chunks.length === 0) return { modelId, embedded: 0 } satisfies NoPrefixResult;

    // Embed the bodies alone (task=document, matching the corpus side of §7.2).
    const vectors = yield* embedder.embed(chunks.map((c) => c.text), "document");
    if (vectors.length !== chunks.length) {
      return yield* Effect.die(
        `embedder returned ${vectors.length} vectors for ${chunks.length} chunks`,
      );
    }

    yield* Effect.forEach(
      chunks.map((c, i) => ({ chunkId: c.id, vec: vectors[i]! })),
      ({ chunkId, vec }) => upsertEmbedding(chunkId, modelId, vec),
      { concurrency: 8 },
    );

    return { modelId, embedded: chunks.length } satisfies NoPrefixResult;
  });
