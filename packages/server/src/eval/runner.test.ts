import { Answer } from "@catalog/domain/answer";
import { ListingFilter } from "@catalog/domain/filter";
import { Answerer } from "@catalog/domain/ports/answerer";
import { Judge } from "@catalog/domain/ports/judge";
import { KnowledgeBase } from "@catalog/domain/ports/knowledge-base";
import { RouteDecision, Router } from "@catalog/domain/ports/router";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgMigrator from "@effect/sql-pg/PgMigrator";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { PgTest, withTransactionRollback } from "../db/pg-test.js";
import { runEval } from "./runner.js";

// The eval runner (§11.3) end-to-end against a testcontainer, with MOCK Router + KB (no
// vendor spend). Proves the harness computes and PERSISTS the §11.2 metrics: a filtered
// item whose router matches the label scores filter_exact=true and retrieves the filtered
// course (nDCG 1); a lookup routes to the mock search; an unanswerable item is refused and
// scored on refusal, not retrieval. concurrency:1 — the whole test is one rolled-back tx.

// Mock router: a fixed decision per question.
const decisions: Record<string, RouteDecision> = {
  "courses in Newark": new RouteDecision({
    filter: new ListingFilter({ campus: "Newark" }),
    searchQuery: null,
    refuse: false,
  }),
  "tell me about grant writing": new RouteDecision({
    filter: null,
    searchQuery: "grant writing",
    refuse: false,
  }),
  "do you offer flying lessons": new RouteDecision({
    filter: null,
    searchQuery: null,
    refuse: true,
  }),
};

const MockRouter = Layer.succeed(Router, {
  route: (question) =>
    Effect.succeed(
      decisions[question] ?? new RouteDecision({ filter: null, searchQuery: null, refuse: true }),
    ),
});

// Mock KB: search returns a fixed hit; filterListings is unused by the runner (it calls the
// retrieval `filterListings` directly against SQL), so it can be a stub.
const searchHits: Record<string, ReadonlyArray<string>> = {
  "grant writing": [], // filled per-test with the real seeded course id
};
const MockKb = Layer.sync(KnowledgeBase, () => ({
  search: (query: string) =>
    Effect.succeed(
      (searchHits[query] ?? []).map((id) => ({
        courseId: id as never,
        score: 1,
        courseTitle: null,
      })),
    ),
  filterListings: () => Effect.succeed([]),
  listingsForCourses: () => Effect.succeed([]),
  hydrate: () => Effect.succeed([]),
  observationWindow: () => Effect.succeed({ observingSince: "2026-07-16", termsObserved: 1 }),
}));

// Answerer + Judge are required by the runner's type (the prose pass), but with
// evalProse:false they are never called — trivial stubs satisfy the layer.
const MockAnswerer = Layer.sync(Answerer, () => ({
  answer: () => Effect.succeed(new Answer({ prose: "", cards: [], filter: null, followups: [] })),
}));
const MockJudge = Layer.sync(Judge, () => ({
  judge: () => Effect.succeed({ faithful: true, score: 1, rationale: "stub" }),
}));

const DbLive = PgMigrator.layer({
  loader: Migrator.fromGlob(import.meta.glob("../db/migrations/*.ts")),
}).pipe(Layer.provide(NodeServices.layer), Layer.orDie, Layer.provideMerge(PgTest));

const TestLive = Layer.mergeAll(DbLive, MockRouter, MockKb, MockAnswerer, MockJudge);

// Minimal course + live listing so the retrieval `filterListings` has something to return.
const seedNewarkCourse = Effect.gen(function*() {
  const sql = yield* SqlClient;
  const modelId = (yield* sql<{ id: number; }>`
    INSERT INTO model (name, kind) VALUES ('test-llm', 'llm') RETURNING id`)[0]!.id;
  const courseId = (yield* sql<{ id: string; }>`
    INSERT INTO course (group_url, course_title, title_normalized, program)
    VALUES ('https://ce/couID=1', 'Grant Writing 101', 'grant writing 101', 'Cont Ed')
    RETURNING id::text AS id`)[0]!.id;
  const pageId = (yield* sql<{ id: string; }>`
    INSERT INTO cecc_course_index_course_listing (url) VALUES ('https://ce/schID=1')
    RETURNING id::text AS id`)[0]!.id;
  const extId = (yield* sql<{ id: string; }>`
    INSERT INTO extraction (source_page_id, model_id, prompt_version, status)
    VALUES (${pageId}, ${modelId}, 'v1', 'ok') RETURNING id::text AS id`)[0]!.id;
  yield* sql`
    INSERT INTO listing (source_page_id, extraction_id, course_id, status, campus, detail_url)
    VALUES (${pageId}, ${extId}, ${courseId}, 'open', 'Newark', 'https://ce/schID=1')`;
  return courseId;
});

const seedItem = (q: string, shape: string, filter: string | null, ids: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    yield* sql`
      INSERT INTO eval_item (question, shape, expected_filter, expected_ids, rubric)
      VALUES (${q}, ${shape}, ${filter}::jsonb, ${`{${ids.join(",")}}`}::bigint[], 'test')`;
  });

describe("runEval", () => {
  it.layer(TestLive, { timeout: "90 seconds" })("scores + persists the golden set", (it) => {
    it.effect("computes filter_exact, nDCG, and refusal, writing eval_run/eval_result", () =>
      withTransactionRollback(Effect.gen(function*() {
        const sql = yield* SqlClient;
        const courseId = yield* seedNewarkCourse;
        searchHits["grant writing"] = [courseId]; // the mock search now returns the real id

        // filtered: label matches the mock router's filter → filter_exact true, nDCG 1
        yield* seedItem("courses in Newark", "filtered", `{"campus":"Newark"}`, [courseId]);
        // lookup: routes to mock search which returns the course → nDCG 1, filter null exact
        yield* seedItem("tell me about grant writing", "lookup", null, [courseId]);
        // unanswerable: refusal item (no expected ids/filter)
        yield* seedItem("do you offer flying lessons", "unanswerable", null, []);

        const { runId, results } = yield* runEval({
          today: new Date("2026-07-21"),
          gitSha: "testsha",
          routerVersion: "test",
          embeddingModel: "mock",
          termsObserved: 1,
          concurrency: 1,
          evalProse: false,
        });

        const byQ = Object.fromEntries(results.map((r) => [r.question, r]));

        // filtered item: exact match + perfect retrieval of the one Newark course
        expect(byQ["courses in Newark"]!.filterExact).toBe(true);
        expect(byQ["courses in Newark"]!.ndcg10).toBeCloseTo(1);

        // lookup item: router emitted null filter (correct) → exact; search found the course
        expect(byQ["tell me about grant writing"]!.filterExact).toBe(true);
        expect(byQ["tell me about grant writing"]!.mrr).toBeCloseTo(1);

        // unanswerable: refused, scored on refusal not retrieval (metrics null)
        const refusal = byQ["do you offer flying lessons"]!;
        expect(refusal.refused).toBe(true);
        expect(refusal.expectedRefuse).toBe(true);
        expect(refusal.filterExact).toBeNull();
        expect(refusal.ndcg10).toBeNull();

        // persistence: the run is finished and every item has a result row
        const run = yield* sql<{ finished: string | null; }>`
          SELECT finished_at AS finished FROM eval_run WHERE id = ${runId}`;
        expect(run[0]!.finished).not.toBeNull();
        const rows = yield* sql<{ n: number; }>`
          SELECT count(*)::int AS n FROM eval_result WHERE run_id = ${runId}`;
        expect(rows[0]!.n).toBe(3);
      })));
  });
});
