import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

// Hybrid fusion (architecture.md §7.2): vector kNN and BM25, fused by reciprocal rank
// fusion in ONE statement — one round trip, one plan, no application-side merge. Exact
// scan, no vector index (ADR-004): at ~732 courses the whole vector set is a couple of
// MB and a sequential scan with distance computation beats HNSW at 100% recall.
//
// `k = 60` is the conventional RRF constant (a §11.5 knob). The vector side casts the
// query to `halfvec` (unsized — dimension inferred from the literal, matched to the
// stored `chunk_embedding` width by construction) and orders by cosine distance
// (`<=>`); the lexical side uses `websearch_to_tsquery` over the stored `tsv`.

const toVectorLiteral = (v: ReadonlyArray<number>): string => `[${v.join(",")}]`;

export interface RrfHit {
  readonly courseId: string;
  readonly rrf: number;
  readonly courseTitle: string | null;
}

export const hybridRrf = (opts: {
  readonly queryEmbedding: ReadonlyArray<number>;
  readonly modelId: number;
  readonly queryText: string;
  readonly limit: number;
}) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const emb = toVectorLiteral(opts.queryEmbedding);
    return yield* sql<RrfHit>`
      WITH vec AS (
        SELECT c.course_id,
               row_number() OVER (ORDER BY e.embedding <=> ${emb}::halfvec) AS rank
        FROM chunk c
        JOIN chunk_embedding e ON e.chunk_id = c.id AND e.model_id = ${opts.modelId}
        ORDER BY e.embedding <=> ${emb}::halfvec
        LIMIT 50
      ),
      lex AS (
        SELECT c.course_id,
               row_number() OVER (ORDER BY ts_rank_cd(c.tsv, q) DESC) AS rank
        FROM chunk c, websearch_to_tsquery('english', ${opts.queryText}) q
        WHERE c.tsv @@ q
        ORDER BY ts_rank_cd(c.tsv, q) DESC
        LIMIT 50
      ),
      fused AS (
        SELECT course_id, sum(1.0 / (60 + rank)) AS rrf
        FROM (SELECT * FROM vec UNION ALL SELECT * FROM lex) u
        GROUP BY course_id
        ORDER BY rrf DESC
        LIMIT ${opts.limit}
      )
      SELECT f.course_id::text AS course_id, f.rrf::float8 AS rrf, co.course_title
      FROM fused f
      JOIN course co ON co.id = f.course_id
      ORDER BY f.rrf DESC
    `;
  });
