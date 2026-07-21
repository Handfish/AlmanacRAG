import { Embedder } from "@catalog/domain/ports/embedder";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgMigrator from "@effect/sql-pg/PgMigrator";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { PgTest, withTransactionRollback } from "../db/pg-test.js";
import { indexCourses } from "./index-courses.js";

// The indexing pipeline (§5.4/§7.3) end-to-end against a testcontainer, with a MOCK
// Embedder (no vendor spend) — deterministic 3-dim vectors. Asserts chunks + embeddings
// are written, the `model` row is registered with its dimensions, and the table-driven
// resume (ADR-I6) re-indexes nothing on a second pass. concurrency:1 because the whole
// test runs inside one rolled-back transaction (one pinned connection).

const MockEmbedder = Layer.succeed(Embedder, {
  modelName: "mock-embed-3",
  dimensions: 3,
  embed: (texts, _task) =>
    Effect.succeed(texts.map((t) => {
      const h = t.length % 3;
      return [h === 0 ? 1 : 0, h === 1 ? 1 : 0, h === 2 ? 1 : 0];
    })),
});

const DbLive = PgMigrator.layer({
  loader: Migrator.fromGlob(import.meta.glob("../db/migrations/*.ts")),
}).pipe(Layer.provide(NodeServices.layer), Layer.orDie, Layer.provideMerge(PgTest));

const TestLive = Layer.mergeAll(DbLive, MockEmbedder);

describe("indexCourses", () => {
  it.layer(TestLive, { timeout: "90 seconds" })("chunk + embed pipeline", (it) => {
    it.effect("indexes courses, registers the model, and resumes idempotently", () =>
      withTransactionRollback(Effect.gen(function*() {
        const sql = yield* SqlClient;
        const mkCourse = (i: number, title: string, description: string) =>
          sql<{ id: string; }>`
            INSERT INTO course (group_url, course_title, title_normalized, description)
            VALUES (${`https://ce/couID=${i}`}, ${title}, ${title.toLowerCase()}, ${description})
            RETURNING id::text AS id`.pipe(Effect.map((r) => r[0]!.id));

        yield* mkCourse(1, "Cybersecurity", "Network defense and threat analysis.");
        yield* mkCourse(2, "Grant Writing", "Fundraising and proposal development.");

        const first = yield* indexCourses({ limit: 0, concurrency: 1, withContextPrefix: false });
        expect(first.indexed).toBe(2);
        expect(first.withPrefix).toBe(0); // no key / disabled → no prefixes

        const chunks = yield* sql<{ n: number; }>`SELECT count(*)::int AS n FROM chunk`;
        expect(chunks[0]?.n).toBe(2);
        const embs = yield* sql<{ n: number; }>`
          SELECT count(*)::int AS n FROM chunk_embedding WHERE model_id = ${first.modelId}`;
        expect(embs[0]?.n).toBe(2);

        // the embedding model row is registered with its dimensions (§5.4)
        const model = yield* sql<{ kind: string; dimensions: number; }>`
          SELECT kind, dimensions FROM model WHERE id = ${first.modelId}`;
        expect(model[0]).toMatchObject({ kind: "embedding", dimensions: 3 });

        // tsv is populated (the BM25 half) — a lexical match resolves
        const lex = yield* sql<{ n: number; }>`
          SELECT count(*)::int AS n FROM chunk
          WHERE tsv @@ websearch_to_tsquery('english', 'cybersecurity')`;
        expect(lex[0]?.n).toBe(1);

        // table-driven resume: nothing left to index on a second pass
        const second = yield* indexCourses({ limit: 0, concurrency: 1, withContextPrefix: false });
        expect(second.indexed).toBe(0);
      })));
  });
});
