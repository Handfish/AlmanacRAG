import type { CourseId } from "@catalog/domain/ids";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgMigrator from "@effect/sql-pg/PgMigrator";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { PgTest, withTransactionRollback } from "../db/pg-test.js";
import { courseHistory } from "../retrieval/course-history.js";
import { composeHistory } from "./format-history.js";
import { isSyntheticDb, synthesizeAndLoad } from "./load-synth.js";

// The Phase-7 exit criterion, end-to-end in real Postgres (§16 M7): synthetic history turns
// the n=1 corpus into a multi-term one WITHOUT touching the honesty guarantee, so both
// branches of §10.6 are provable. `course_history` reads the §5.3.5 rollup over live +
// disappeared listings; `composeHistory` turns it into a grounded or "I don't know yet"
// answer. The marker + `synthetic://` tagging keep the fixture self-identifying.

const TestLive = PgMigrator.layer({
  loader: Migrator.fromGlob(import.meta.glob("../db/migrations/*.ts")),
}).pipe(Layer.provide(NodeServices.layer), Layer.orDie, Layer.provideMerge(PgTest));

// Insert one current, live, DATED listing per course — the n=1 anchor the generator clones
// backward from. Courses are inserted in order so their ids ascend; `collectSeedCourses`
// orders by course_id, so `balanced` archetypes land as [recurring, returning, current_only].
const seedCurrent = Effect.gen(function*() {
  const sql = yield* SqlClient;
  const modelId = (yield* sql<{ id: number; }>`
    INSERT INTO model (name, kind) VALUES ('test-llm', 'llm') RETURNING id`)[0]!.id;

  const mkCourse = (title: string, fee: number) =>
    Effect.gen(function*() {
      const courseId = (yield* sql<{ id: string; }>`
        INSERT INTO course (group_url, course_title, title_normalized)
        VALUES (${`https://ce/couID=${title}`}, ${title}, ${title.toLowerCase()})
        RETURNING id::text AS id`)[0]!.id;
      const pageId = (yield* sql<{ id: string; }>`
        INSERT INTO cecc_course_index_course_listing (url) VALUES (${`https://ce/${title}`})
        RETURNING id::text AS id`)[0]!.id;
      const extId = (yield* sql<{ id: string; }>`
        INSERT INTO extraction (source_page_id, model_id, prompt_version, status)
        VALUES (${pageId}, ${modelId}, 'v1', 'ok') RETURNING id::text AS id`)[0]!.id;
      yield* sql`
        INSERT INTO listing
          (source_page_id, extraction_id, course_id, status, campus, delivery_mode,
           term, term_season, term_year, total_fee_cents, detail_url)
        VALUES
          (${pageId}, ${extId}, ${courseId}, 'open', 'Newark', 'in_person',
           'Fall 2026', 'Fall', 2026, ${fee}, ${`https://ce/${title}`})`;
      return courseId;
    });

  const a = yield* mkCourse("RecurringCourse", 45000);
  const b = yield* mkCourse("ReturningCourse", 30000);
  const c = yield* mkCourse("CurrentOnlyCourse", 10000);
  // The epoch as the real crawl would leave it: n=1, clock just started.
  yield* sql`INSERT INTO system_epoch (id, observing_since, terms_observed)
             VALUES (1, '2026-09-05T00:00:00Z', 1) ON CONFLICT (id) DO NOTHING`;
  return { a, b, c };
});

describe("synthetic history (integration)", () => {
  it.layer(TestLive, { timeout: "120 seconds" })("both §10.6 branches over real Postgres", (it) => {
    it.effect("recurring archetype → 3 terms, grounded, fee trajectory + change log", () =>
      withTransactionRollback(Effect.gen(function*() {
        const { a } = yield* seedCurrent;
        const load = yield* synthesizeAndLoad({ limit: 10, balanced: true });
        expect(load.listings).toBe(3); // +2 (recurring) +1 (returning) +0 (current_only)
        expect(yield* isSyntheticDb).toBe(true);
        // the window moved back to cover the fabricated terms
        expect(load.observingSince.startsWith("2024-09")).toBe(true);
        expect(load.termsObserved).toBe(3); // distinct (Fall,2024/2025/2026)

        const h = yield* courseHistory(a as CourseId);
        expect(h).not.toBeNull();
        expect(h!.termsSeen).toBe(3);
        expect(h!.terms.map((t) => t.term)).toEqual(["Fall 2024", "Fall 2025", "Fall 2026"]);
        // fees ascend into the present; the change log recorded the arc
        const fees = h!.terms.map((t) => t.minFeeCents);
        expect(fees[0]!).toBeLessThan(fees[2]!);
        expect(h!.changes.length).toBeGreaterThan(0);
        // only the current term is still listed
        expect(h!.terms.find((t) => t.term === "Fall 2026")!.stillListed).toBe(true);
        expect(h!.terms.find((t) => t.term === "Fall 2024")!.stillListed).toBe(false);

        const answer = composeHistory(h, "Recurring Course");
        expect(answer.verdict).toBe("grounded");
        expect(answer.prose).toContain("3 terms");
        expect(answer.prose).toMatch(/risen from/);
      })));

    it.effect("current_only archetype → still n=1 → 'I don't know yet' (§10.6)", () =>
      withTransactionRollback(Effect.gen(function*() {
        const { c } = yield* seedCurrent;
        yield* synthesizeAndLoad({ limit: 10, balanced: true });

        const h = yield* courseHistory(c as CourseId);
        expect(h!.termsSeen).toBe(1); // no prior terms were fabricated for this one
        const answer = composeHistory(h, "Current Only Course");
        expect(answer.verdict).toBe("insufficient");
        expect(answer.prose).toMatch(/only seen .* once/i);
        // even in a DB that now holds YEARS of other history, this course is honest
        expect(answer.prose).not.toMatch(/every (year|fall)/i);
      })));

    it.effect("a course whose current listing has gone → history still reports it, honestly", () =>
      withTransactionRollback(Effect.gen(function*() {
        const { c } = yield* seedCurrent;
        yield* synthesizeAndLoad({ limit: 10, balanced: true });
        const sql = yield* SqlClient;
        // The course falls off the site: its only term disappears (retention, §5.3 — we
        // DON'T delete it).
        yield* sql`UPDATE listing SET disappeared_at = now() WHERE course_id = ${c}`;

        const h = yield* courseHistory(c as CourseId);
        expect(h!.terms).toHaveLength(1); // still on record, not deleted
        expect(h!.terms[0]!.stillListed).toBe(false);
        const answer = composeHistory(h, "Current Only Course");
        expect(answer.verdict).toBe("insufficient");
        expect(answer.prose).toMatch(/hasn't appeared since/i);
      })));

    it.effect("unknown course id → null history → not_found answer", () =>
      withTransactionRollback(Effect.gen(function*() {
        const h = yield* courseHistory("999999" as CourseId);
        expect(h).toBeNull();
        expect(composeHistory(h, "ghost course").verdict).toBe("not_found");
      })));
  });
});
