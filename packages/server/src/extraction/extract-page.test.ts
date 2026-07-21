import { ExtractError } from "@catalog/domain/errors";
import type { ExtractedCourse } from "@catalog/domain/extraction";
import { Extractor } from "@catalog/domain/ports/extractor";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgMigrator from "@effect/sql-pg/PgMigrator";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { PgTest, withTransactionRollback } from "../db/pg-test.js";
import { extractPage } from "./extract-page.js";

// Orchestration test: the Extractor PORT is mocked (our seam), the DB is real. Both
// the success path and the failure path (§9's "typed schema_error, never a silent
// null") are exercised without spending on a provider.

const DbLive = PgMigrator.layer({
  loader: Migrator.fromGlob(import.meta.glob("../db/migrations/*.ts")),
}).pipe(Layer.provide(NodeServices.layer), Layer.orDie, Layer.provideMerge(PgTest));

const canned: ExtractedCourse = {
  courseTitle: "Mock Course",
  externalCourseId: "MOCK1",
  track: null,
  contactHours: null,
  subject: null,
  program: null,
  description: null,
  audience: null,
  prerequisiteText: null,
  registrationKeyword: null,
  relations: [],
  externalSectionId: "42",
  sessionLabel: null,
  datesText: null,
  scheduleText: null,
  timesText: null,
  isEvening: null,
  registrationDeadlineText: null,
  formatText: null,
  deliveryMode: "online_async",
  locationText: null,
  campus: "Online",
  statusRaw: "Registration Available",
  isNew: false,
  fees: [],
  instructors: [],
};

const okExtractor = Layer.succeed(Extractor, { extract: () => Effect.succeed(canned) });
const failingExtractor = Layer.succeed(Extractor, {
  extract: () => Effect.fail(new ExtractError({ message: "would not decode" })),
});

const seedPage = (sql: SqlClient, url: string) =>
  sql<{ id: string; }>`
    INSERT INTO cecc_course_index_course_listing (url, group_url)
    VALUES (${url}, ${"https://x/searchResults.cfm?couID=1"})
    RETURNING id::text AS id`;

const input = (sourcePageId: string) => ({
  sourcePageId,
  rawMarkdown: "# Mock Course\n...",
  pageFields: { status: "Registration Available" },
  ctx: {
    detailUrl: "https://x/courseDisplay.cfm?schID=42",
    groupUrl: "https://x/searchResults.cfm?couID=1",
  },
  crawlRunId: null,
});

describe("extractPage", () => {
  it.layer(DbLive, { timeout: "90 seconds" })("orchestration", (it) => {
    it.effect("ok: persists a listing + an 'ok' extraction row", () =>
      withTransactionRollback(Effect.gen(function*() {
        const sql = yield* SqlClient;
        const page = yield* seedPage(sql, "https://x/courseDisplay.cfm?schID=42");
        const id = page[0]!.id;

        const outcome = yield* extractPage(input(id)).pipe(Effect.provide(okExtractor));
        expect(outcome.ok).toBe(true);

        const listing = yield* sql<{ n: number; }>`
          SELECT count(*)::int AS n FROM listing WHERE source_page_id = ${id}`;
        expect(listing[0]?.n).toBe(1);
        const extraction = yield* sql<{ status: string; }>`
          SELECT status FROM extraction WHERE source_page_id = ${id}`;
        expect(extraction[0]?.status).toBe("ok");
      })));

    it.effect("failure: a schema_error row, NO listing", () =>
      withTransactionRollback(Effect.gen(function*() {
        const sql = yield* SqlClient;
        const page = yield* seedPage(sql, "https://x/courseDisplay.cfm?schID=99");
        const id = page[0]!.id;

        const outcome = yield* extractPage(input(id)).pipe(Effect.provide(failingExtractor));
        expect(outcome.ok).toBe(false);

        const extraction = yield* sql<{ status: string; }>`
          SELECT status FROM extraction WHERE source_page_id = ${id}`;
        expect(extraction[0]?.status).toBe("schema_error");
        const listing = yield* sql<{ n: number; }>`
          SELECT count(*)::int AS n FROM listing WHERE source_page_id = ${id}`;
        expect(listing[0]?.n).toBe(0); // never a half-written or silently-null row
      })));
  });
});
