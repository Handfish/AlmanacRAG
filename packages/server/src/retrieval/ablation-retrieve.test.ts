import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgMigrator from "@effect/sql-pg/PgMigrator";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { RerankerIdentityLive } from "../adapters/reranker-bge.js";
import { PgTest, withTransactionRollback } from "../db/pg-test.js";
import { ablationSearch } from "./ablation-retrieve.js";

// Ablation retrieval (§11.5) against a real testcontainer with pgvector. Same three-course
// fixture as hybrid-rrf.test, but exercising the KNOB that matters: with `hybrid:false` only
// the vector half ranks the courses; with `hybrid:true` a lexical hit re-enters the fusion and
// PROMOTES a course the vector half ranked lower — proving "+ hybrid RRF" is a real
// single-variable flip. (At a 3-row corpus every course is inside the top-50 pool, so the
// signal is the RANK, not presence — exactly as in hybrid-rrf.test.)

const TestLive = Layer.mergeAll(
  PgMigrator.layer({
    loader: Migrator.fromGlob(import.meta.glob("../db/migrations/*.ts")),
  }).pipe(Layer.provide(NodeServices.layer), Layer.orDie, Layer.provideMerge(PgTest)),
  RerankerIdentityLive,
);

describe("ablationSearch", () => {
  it.layer(TestLive, { timeout: "90 seconds" })("vector-only vs hybrid", (it) => {
    it.effect("hybrid re-admits a lexical-only match the vector half misses", () =>
      withTransactionRollback(Effect.gen(function*() {
        const sql = yield* SqlClient;
        const modelId = (yield* sql<{ id: number; }>`
          INSERT INTO model (name, kind, dimensions) VALUES ('abl-embed-3', 'embedding', 3)
          RETURNING id`)[0]!.id;

        const insert = (i: number, title: string, body: string, emb: ReadonlyArray<number>) =>
          Effect.gen(function*() {
            const course = yield* sql<{ id: string; }>`
              INSERT INTO course (group_url, course_title, title_normalized)
              VALUES (${`https://ce/couID=${i}`}, ${title}, ${title.toLowerCase()})
              RETURNING id::text AS id`;
            const cid = course[0]!.id;
            const chunk = yield* sql<{ id: string; }>`
              INSERT INTO chunk (course_id, ord, text, token_count)
              VALUES (${cid}, 0, ${body}, ${Math.ceil(body.length / 4)})
              RETURNING id::text AS id`;
            yield* sql`
              INSERT INTO chunk_embedding (chunk_id, model_id, embedding)
              VALUES (${chunk[0]!.id}, ${modelId}, ${`[${emb.join(",")}]`}::halfvec)`;
            return cid;
          });

        const a = yield* insert(1, "Cybersecurity", "network defense and threat analysis", [
          1,
          0,
          0,
        ]);
        const b = yield* insert(2, "Grant Writing", "grant writing and proposal development", [
          0,
          1,
          0,
        ]);
        yield* insert(3, "Watercolor", "watercolor painting and color theory", [0, 0, 1]);

        // Query embedding points at A; query TEXT matches B lexically.
        const opts = { queryEmbedding: [0.9, 0.1, 0.0], queryText: "grant writing", limit: 10 };

        // Vector-only: ranked purely by cosine to A → A first, B not on top.
        const vecOnly = yield* ablationSearch(
          { modelId, hybrid: false, rerank: false },
          opts,
        );
        expect(vecOnly[0]?.courseId).toBe(a);
        expect(vecOnly[0]?.courseId).not.toBe(b);

        // Hybrid: B is a DOUBLE hit (vector rank 2 + lexical rank 1) → its fused RRF beats A's
        // vector-only score, so the lexical signal promotes B to the top.
        const hybrid = yield* ablationSearch(
          { modelId, hybrid: true, rerank: false },
          opts,
        );
        expect(hybrid[0]?.courseId).toBe(b);

        // rerank:true with the identity reranker is a no-op — identical order to hybrid.
        const reranked = yield* ablationSearch(
          { modelId, hybrid: true, rerank: true },
          opts,
        );
        expect(reranked.map((h) => h.courseId)).toEqual(hybrid.map((h) => h.courseId));
      })));
  });
});
