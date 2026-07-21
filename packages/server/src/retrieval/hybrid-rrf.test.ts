import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgMigrator from "@effect/sql-pg/PgMigrator";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { PgTest, withTransactionRollback } from "../db/pg-test.js";
import { hybridRrf } from "./hybrid-rrf.js";

// Hybrid RRF (§7.2) against a real testcontainer with pgvector: three courses, each a
// one-hot 3-dim embedding + a distinct lexical body. Proves the two halves genuinely
// FUSE — a course that ranks in BOTH the vector and lexical lists beats a course that
// wins only one, which is the whole point of reciprocal rank fusion.

const TestLive = PgMigrator.layer({
  loader: Migrator.fromGlob(import.meta.glob("../db/migrations/*.ts")),
}).pipe(Layer.provide(NodeServices.layer), Layer.orDie, Layer.provideMerge(PgTest));

describe("hybridRrf", () => {
  it.layer(TestLive, { timeout: "90 seconds" })("vector + BM25 fusion", (it) => {
    it.effect("fuses the two ranked lists by reciprocal rank", () =>
      withTransactionRollback(Effect.gen(function*() {
        const sql = yield* SqlClient;
        const modelId = (yield* sql<{ id: number; }>`
          INSERT INTO model (name, kind, dimensions) VALUES ('mock-embed-3', 'embedding', 3)
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

        const a = yield* insert(
          1,
          "Introduction to Cybersecurity",
          "Cybersecurity fundamentals: network defense and threat analysis.",
          [1, 0, 0],
        );
        const b = yield* insert(
          2,
          "Grant Writing for Nonprofits",
          "Grant writing, fundraising, and proposal development for nonprofits.",
          [0, 1, 0],
        );
        const c = yield* insert(
          3,
          "Watercolor Painting Basics",
          "Watercolor painting techniques and color theory for artists.",
          [0, 0, 1],
        );

        // Query embedding nearest A + lexical hit on A → A wins outright.
        const r1 = yield* hybridRrf({
          queryEmbedding: [0.9, 0.1, 0.0],
          modelId,
          queryText: "cybersecurity",
          limit: 10,
        });
        expect(r1[0]?.courseId).toBe(a);
        expect(r1[0]?.courseTitle).toBe("Introduction to Cybersecurity");

        // Query embedding nearest C, but lexical matches B. B appears in BOTH lists
        // (vector rank ~2 + lexical rank 1) and so must outrank C (vector rank 1 only).
        const r2 = yield* hybridRrf({
          queryEmbedding: [0.0, 0.0, 1.0],
          modelId,
          queryText: "grant writing",
          limit: 10,
        });
        expect(r2[0]?.courseId).toBe(b);
        const returned = new Set(r2.map((h) => h.courseId));
        expect(returned.has(c)).toBe(true); // C still surfaced by the vector half

        // Scores are descending.
        for (let i = 1; i < r2.length; i++) {
          expect(r2[i - 1]!.rrf).toBeGreaterThanOrEqual(r2[i]!.rrf);
        }
      })));
  });
});
