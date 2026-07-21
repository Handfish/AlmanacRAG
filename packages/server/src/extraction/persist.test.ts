import type { ExtractedCourse } from "@catalog/domain/extraction";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgMigrator from "@effect/sql-pg/PgMigrator";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { PgTest, withTransactionRollback } from "../db/pg-test.js";
import type { StoredPageFields } from "./derive.js";
import { persistExtraction } from "./persist.js";

// End-to-end persistence against a real Postgres testcontainer (no LLM): a derived
// ExtractedCourse is written to course + listing + children, and a re-extract with a
// changed status writes a `listing_change` row (§5.3.2).

const TestLive = PgMigrator.layer({
  loader: Migrator.fromGlob(import.meta.glob("../db/migrations/*.ts")),
}).pipe(Layer.provide(NodeServices.layer), Layer.orDie, Layer.provideMerge(PgTest));

const REF = new Date("2026-01-01T00:00:00Z");

const baseExtracted: ExtractedCourse = {
  courseTitle: "Test Course",
  externalCourseId: null,
  track: null,
  contactHours: null,
  subject: null,
  program: null,
  description: null,
  audience: null,
  prerequisiteText: null,
  registrationKeyword: null,
  relations: [],
  externalSectionId: null,
  sessionLabel: null,
  datesText: null,
  scheduleText: null,
  timesText: null,
  isEvening: null,
  registrationDeadlineText: null,
  formatText: null,
  deliveryMode: "unknown",
  locationText: null,
  campus: "unknown",
  statusRaw: "Registration Available",
  isNew: false,
  fees: [],
  instructors: [],
};

const GROUP = "https://ce-catalog.rutgers.edu/searchResults.cfm?couID=123";
const DETAIL = "https://ce-catalog.rutgers.edu/courseDisplay.cfm?schID=289";

describe("persist", () => {
  it.layer(TestLive, { timeout: "90 seconds" })("extraction persistence", (it) => {
    it.effect("writes course + listing + children, then logs a status change", () =>
      withTransactionRollback(Effect.gen(function*() {
        const sql = yield* SqlClient;
        const page = yield* sql<{ id: string; }>`
          INSERT INTO cecc_course_index_course_listing (url, group_url)
          VALUES (${DETAIL}, ${GROUP})
          RETURNING id::text AS id`;
        const sourcePageId = page[0]!.id;

        const extracted: ExtractedCourse = {
          ...baseExtracted,
          courseTitle: "45 - Hour Numeracy Online Course",
          externalCourseId: "ALT10",
          statusRaw: "Registration Available",
          instructors: [{ lastName: "Teehan", firstName: "Kare" }],
        };
        const pageFields: StoredPageFields = {
          status: "Registration Available",
          dates: "7/20/2026 - 8/03/2026",
          sectionId: "289",
          fees: [{ label: "Tuition", amount: "$ 415" }, { label: "Total Fees", amount: "$ 415" }],
        };
        const input = {
          sourcePageId,
          crawlRunId: null,
          modelName: "claude-haiku-4-5",
          promptVersion: "extract-v1",
          extracted,
          pageFields,
          ctx: { detailUrl: DETAIL, groupUrl: GROUP, referenceDate: REF },
          inputTokens: 1200,
          outputTokens: 300,
        };

        const first = yield* persistExtraction(input);

        const course = yield* sql<
          { externalCourseId: string; groupUrl: string; contactHours: string; }
        >`
          SELECT external_course_id, group_url, contact_hours FROM course WHERE id = ${first.courseId}`;
        expect(course[0]?.externalCourseId).toBe("ALT10");
        expect(course[0]?.groupUrl).toBe(GROUP);
        expect(Number(course[0]?.contactHours)).toBe(45); // parsed from the title

        const listing = yield* sql<
          { status: string; termSeason: string; totalFeeCents: number; startsOn: string; }
        >`
          SELECT status, term_season, total_fee_cents,
                 to_char(starts_on, 'YYYY-MM-DD') AS starts_on
          FROM listing WHERE id = ${first.listingId}`;
        expect(listing[0]).toMatchObject({
          status: "open",
          termSeason: "Summer",
          totalFeeCents: 41500,
          startsOn: "2026-07-20",
        });

        const fees = yield* sql<{ n: number; }>`
          SELECT count(*)::int AS n FROM listing_fee WHERE listing_id = ${first.listingId}`;
        expect(fees[0]?.n).toBe(2);
        const instr = yield* sql<{ lastName: string; }>`
          SELECT last_name FROM listing_instructor WHERE listing_id = ${first.listingId}`;
        expect(instr[0]?.lastName).toBe("Teehan");
        const extraction = yield* sql<{ status: string; }>`
          SELECT status FROM extraction WHERE id = ${first.extractionId}`;
        expect(extraction[0]?.status).toBe("ok");

        // Re-extract the same page with a changed status → a listing_change row.
        const second = yield* persistExtraction({
          ...input,
          extracted: { ...extracted, statusRaw: "Course Full" },
          pageFields: { ...pageFields, status: "Course Full" },
        });
        expect(second.listingId).toBe(first.listingId); // upsert, not a new row

        const change = yield* sql<{ field: string; oldValue: string; newValue: string; }>`
          SELECT field, old_value, new_value FROM listing_change
          WHERE listing_id = ${first.listingId} AND field = 'status'`;
        expect(change[0]).toMatchObject({ field: "status", oldValue: "open", newValue: "full" });
      })));
  });
});
