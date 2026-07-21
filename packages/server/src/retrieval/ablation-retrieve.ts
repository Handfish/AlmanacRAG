import { Reranker } from "@catalog/domain/ports/reranker";
import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { reorderByScores } from "./rerank.js";

// Parameterized retrieval for the §11.5 ablation ladder. Production retrieval (§7.2,
// retrieval/hybrid-rrf.ts) is a fixed hybrid-RRF-with-prefixes statement; the ablation
// needs the SAME retrieval with individual knobs flipped so each table row isolates ONE
// variable:
//   • modelId  — which embedding set to scan. The live set (model 994) was embedded WITH
//                §7.3 context prefixes; the ablation also builds a no-prefix set under a
//                second model row (retrieval/index-noprefix.ts). Selecting the model_id is
//                how "+ contextual prefixes" becomes a single-variable row (§5.4 put
//                model_id in the PK precisely for this).
//   • hybrid   — false drops the lexical (BM25) half, leaving vector-only kNN; true fuses
//                both by RRF exactly as §7.2. This is the "+ hybrid RRF" row.
//   • rerank   — cross-encode the fused pool with the Reranker port (§11.6) and reorder.
//                The "+ reranker" row; identity when no container (adapters/reranker-bge).
//
// The query embedding is model-agnostic (same gemini-embedding-001 model, same width), so
// the caller embeds the query ONCE and reuses it across every row — the ablation makes
// 0 extra embedding calls per config beyond the one-time no-prefix index build.

/** How many fused candidates to cross-encode before cutting to the requested limit — the
 * "top ~50 fused candidates" the reranker sees (§11.6). */
export const RERANK_POOL = 50;

export interface AblationKnobs {
  readonly modelId: number;
  readonly hybrid: boolean;
  readonly rerank: boolean;
}

export interface AblationHit {
  readonly courseId: string;
  readonly courseTitle: string | null;
}

const toVectorLiteral = (v: ReadonlyArray<number>): string => `[${v.join(",")}]`;

interface PoolRow {
  readonly courseId: string;
  readonly rrf: number;
  readonly courseTitle: string | null;
}

/** Vector-only kNN pool: rank courses by cosine distance against `modelId`'s embeddings,
 * scored as a single RRF list (1/(60+rank)) so the shape matches the hybrid branch. */
const vectorPool = (emb: string, modelId: number) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    return yield* sql<PoolRow>`
      WITH vec AS (
        SELECT c.course_id,
               row_number() OVER (ORDER BY e.embedding <=> ${emb}::halfvec) AS rank
        FROM chunk c
        JOIN chunk_embedding e ON e.chunk_id = c.id AND e.model_id = ${modelId}
        ORDER BY e.embedding <=> ${emb}::halfvec
        LIMIT ${RERANK_POOL}
      )
      SELECT v.course_id::text AS course_id, (1.0 / (60 + v.rank))::float8 AS rrf, co.course_title
      FROM vec v JOIN course co ON co.id = v.course_id
      ORDER BY rrf DESC
    `;
  });

/** Hybrid RRF pool — the §7.2 statement, parameterized on `modelId` (identical to
 * retrieval/hybrid-rrf.ts otherwise). */
const hybridPool = (emb: string, modelId: number, queryText: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    return yield* sql<PoolRow>`
      WITH vec AS (
        SELECT c.course_id,
               row_number() OVER (ORDER BY e.embedding <=> ${emb}::halfvec) AS rank
        FROM chunk c
        JOIN chunk_embedding e ON e.chunk_id = c.id AND e.model_id = ${modelId}
        ORDER BY e.embedding <=> ${emb}::halfvec
        LIMIT ${RERANK_POOL}
      ),
      lex AS (
        SELECT c.course_id,
               row_number() OVER (ORDER BY ts_rank_cd(c.tsv, q) DESC) AS rank
        FROM chunk c, websearch_to_tsquery('english', ${queryText}) q
        WHERE c.tsv @@ q
        ORDER BY ts_rank_cd(c.tsv, q) DESC
        LIMIT ${RERANK_POOL}
      ),
      fused AS (
        SELECT course_id, sum(1.0 / (60 + rank)) AS rrf
        FROM (SELECT * FROM vec UNION ALL SELECT * FROM lex) u
        GROUP BY course_id
        ORDER BY rrf DESC
        LIMIT ${RERANK_POOL}
      )
      SELECT f.course_id::text AS course_id, f.rrf::float8 AS rrf, co.course_title
      FROM fused f JOIN course co ON co.id = f.course_id
      ORDER BY f.rrf DESC
    `;
  });

/** The chunk text (situating prefix + body) for a set of course ids — what the reranker
 * cross-encodes against the query. One round trip; order restored by the caller. */
const chunkTextByCourse = (courseIds: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    if (courseIds.length === 0) return new Map<string, string>();
    const ids = `{${courseIds.filter((id) => /^\d+$/.test(id)).join(",")}}`;
    const rows = yield* sql<{ courseId: string; body: string; }>`
      SELECT ch.course_id::text AS course_id,
             coalesce(ch.context_prefix || ' ', '') || ch.text AS body
      FROM chunk ch
      WHERE ch.ord = 0 AND ch.course_id = ANY(${ids}::bigint[])
    `;
    return new Map(rows.map((r) => [r.courseId, r.body]));
  });

/**
 * Run one ablation-configured retrieval and return the ranked course hits, cut to `limit`.
 * With `rerank` on, the fused pool is cross-encoded by the Reranker port and reordered
 * before the cut; with it off (or an identity reranker), fusion order stands.
 */
export const ablationSearch = (
  knobs: AblationKnobs,
  opts: {
    readonly queryEmbedding: ReadonlyArray<number>;
    readonly queryText: string;
    readonly limit: number;
  },
): Effect.Effect<ReadonlyArray<AblationHit>, never, SqlClient | Reranker> =>
  Effect.gen(function*() {
    const emb = toVectorLiteral(opts.queryEmbedding);
    const pool = knobs.hybrid
      ? yield* hybridPool(emb, knobs.modelId, opts.queryText)
      : yield* vectorPool(emb, knobs.modelId);

    let ordered: ReadonlyArray<PoolRow> = pool;
    if (knobs.rerank && pool.length > 1) {
      const reranker = yield* Reranker;
      const texts = yield* chunkTextByCourse(pool.map((p) => p.courseId));
      const docs = pool.map((p) => texts.get(p.courseId) ?? p.courseTitle ?? "");
      const scores = yield* reranker.rerank(opts.queryText, docs);
      ordered = reorderByScores(pool, scores);
    }

    return ordered.slice(0, opts.limit).map((p): AblationHit => ({
      courseId: p.courseId,
      courseTitle: p.courseTitle,
    }));
  }).pipe(Effect.orDie); // retrieval faults are non-recoverable in an offline ablation run
