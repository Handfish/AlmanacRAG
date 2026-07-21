import { Embedder } from "@catalog/domain/ports/embedder";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { GeminiContextModel } from "../adapters/ai-gemini.js";
import { buildChunkText, type CourseChunkSource, estimateTokens } from "./chunk-text.js";
import { generateContextPrefix } from "./context-prefix.js";

// The context-prefix key is read OPTIONALLY here (unlike the embedder, which owns its
// own key): prefixes are a best-effort §7.3 enhancement, so a keyless run — or a
// mock-Embedder test — simply indexes without them rather than failing at config time.
const OptionalGeminiKey = Config.redacted("GEMINI_API_KEY").pipe(
  Config.option,
  Config.map(Option.getOrUndefined),
);

// The Phase-3 indexing pipeline (architecture.md §5.4/§7.3) — turn extracted courses
// into searchable chunks: build the chunk text, write the §7.3 situating prefix, embed
// prefix+text, and store the halfvec. Table-driven resume (ADR-I6, like extraction): a
// course is (re)indexed iff it lacks a `chunk_embedding` for the active model, so a
// crashed or partial run simply re-runs, and a new embedding model backfills without
// touching the old one (`model_id` in the PK, §5.4).

// ── model registry (§5.4) — the embedding row, with its dimensions ───────────
export const ensureEmbeddingModel = (name: string, dimensions: number) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ id: number; }>`
      INSERT INTO model (name, kind, dimensions) VALUES (${name}, 'embedding', ${dimensions})
      ON CONFLICT (name) DO UPDATE SET dimensions = EXCLUDED.dimensions
      RETURNING id
    `;
    return rows[0]!.id;
  });

export const upsertChunk = (
  courseId: string,
  chunk: {
    readonly contextPrefix: string | null;
    readonly text: string;
    readonly tokenCount: number;
  },
) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ id: string; }>`
      INSERT INTO chunk (course_id, ord, context_prefix, text, token_count)
      VALUES (${courseId}, 0, ${chunk.contextPrefix}, ${chunk.text}, ${chunk.tokenCount})
      ON CONFLICT (course_id, ord) DO UPDATE SET
        context_prefix = EXCLUDED.context_prefix,
        text           = EXCLUDED.text,
        token_count    = EXCLUDED.token_count
      RETURNING id::text AS id
    `;
    return rows[0]!.id;
  });

export const upsertEmbedding = (
  chunkId: string,
  modelId: number,
  embedding: ReadonlyArray<number>,
) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const literal = `[${embedding.join(",")}]`;
    yield* sql`
      INSERT INTO chunk_embedding (chunk_id, model_id, embedding)
      VALUES (${chunkId}, ${modelId}, ${literal}::halfvec)
      ON CONFLICT (chunk_id, model_id) DO UPDATE SET embedding = EXCLUDED.embedding
    `;
  });

interface CourseRow {
  readonly id: string;
  readonly courseTitle: string;
  readonly subject: string | null;
  readonly track: string | null;
  readonly program: string | null;
  readonly audience: string | null;
  readonly description: string | null;
  readonly prerequisiteText: string | null;
  readonly contactHours: number | null;
}

const toSource = (row: CourseRow): CourseChunkSource => ({
  courseTitle: row.courseTitle,
  subject: row.subject,
  track: row.track,
  program: row.program,
  audience: row.audience,
  description: row.description,
  prerequisiteText: row.prerequisiteText,
  contactHours: row.contactHours,
});

export interface IndexResult {
  readonly modelId: number;
  readonly indexed: number;
  readonly withPrefix: number;
}

/**
 * Index every course that lacks an embedding for the active model. Prefix generation
 * runs at bounded concurrency (cheap LLM); embeddings go out in one batched call
 * (the adapter chunks to the provider's per-request cap); persistence is per-course.
 */
export const indexCourses = (opts: {
  readonly limit: number;
  readonly concurrency: number;
  readonly withContextPrefix: boolean;
}) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const embedder = yield* Embedder;
    const apiKey = yield* OptionalGeminiKey;
    const contextModel = yield* GeminiContextModel;

    const modelId = yield* ensureEmbeddingModel(embedder.modelName, embedder.dimensions);
    const effectiveLimit = opts.limit > 0 ? opts.limit : 2147483647;

    const courses = yield* sql<CourseRow>`
      SELECT c.id::text AS id, c.course_title, c.subject, c.track, c.program, c.audience,
             c.description, c.prerequisite_text, c.contact_hours::float8 AS contact_hours
      FROM course c
      WHERE NOT EXISTS (
        SELECT 1 FROM chunk ch
        JOIN chunk_embedding e ON e.chunk_id = ch.id AND e.model_id = ${modelId}
        WHERE ch.course_id = c.id AND ch.ord = 0
      )
      ORDER BY c.id
      LIMIT ${effectiveLimit}
    `;

    if (courses.length === 0) return { modelId, indexed: 0, withPrefix: 0 } satisfies IndexResult;

    // Stage 1 — build text + (optional) situating prefix.
    const prepared = yield* Effect.forEach(courses, (row) =>
      Effect.gen(function*() {
        const source = toSource(row);
        const text = buildChunkText(source);
        const prefix = opts.withContextPrefix && apiKey !== undefined
          ? yield* generateContextPrefix(apiKey, contextModel, source)
          : null;
        const embedInput = prefix ? `${prefix}\n\n${text}` : text;
        return { courseId: row.id, text, prefix, tokenCount: estimateTokens(text), embedInput };
      }), { concurrency: opts.concurrency });

    // Stage 2 — embed all inputs (the adapter batches to the provider cap).
    const vectors = yield* embedder.embed(prepared.map((p) => p.embedInput), "document");
    if (vectors.length !== prepared.length) {
      return yield* Effect.die(
        `embedder returned ${vectors.length} vectors for ${prepared.length} chunks`,
      );
    }

    // Stage 3 — persist chunk + embedding.
    yield* Effect.forEach(
      prepared.map((p, i) => ({ p, vec: vectors[i]! })),
      ({ p, vec }) =>
        Effect.gen(function*() {
          const chunkId = yield* upsertChunk(p.courseId, {
            contextPrefix: p.prefix,
            text: p.text,
            tokenCount: p.tokenCount,
          });
          yield* upsertEmbedding(chunkId, modelId, vec);
        }),
      { concurrency: opts.concurrency },
    );

    return {
      modelId,
      indexed: prepared.length,
      withPrefix: prepared.filter((p) => p.prefix !== null).length,
    } satisfies IndexResult;
  });
