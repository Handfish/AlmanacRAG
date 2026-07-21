import { PageFetchError } from "@catalog/domain/errors";
import {
  type ConditionalHeaders,
  type FetchResult,
  PageSource,
} from "@catalog/domain/ports/page-source";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgMigrator from "@effect/sql-pg/PgMigrator";
import { describe, expect, it } from "@effect/vitest";
import { detailHtml } from "@test/fixtures";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { PgTest, withTransactionRollback } from "../db/pg-test.js";
import { getEpoch } from "../db/repos/system-epoch.js";
import { runCrawl } from "./crawl.js";
import { contentHashOf } from "./hash.js";
import { Robots } from "./robots.js";
import { htmlToMarkdown } from "./segment.js";

// End-to-end Phase-1 pipeline against a real Postgres testcontainer with a fake
// PageSource (mutable in-memory map — no network). One transaction, rolled back,
// so the retention/sweep ordering is exercised on clock_timestamp() semantics.

const TestMigrationLayer = PgMigrator.layer({
  loader: Migrator.fromGlob(import.meta.glob("../db/migrations/*.ts")),
}).pipe(Layer.provide(NodeServices.layer), Layer.orDie);

const TestLive = TestMigrationLayer.pipe(Layer.provideMerge(PgTest));

const FakeRobots = Layer.succeed(Robots, { isAllowed: () => Effect.succeed(true) });

const makeFakePageSource = (pages: ReadonlyMap<string, string>) =>
  Layer.succeed(PageSource, {
    fetch: (url: string, conditional?: ConditionalHeaders) =>
      Effect.gen(function*() {
        const html = pages.get(url);
        if (html === undefined) {
          return yield* Effect.fail(new PageFetchError({ url, message: "404", status: 404 }));
        }
        const etag = `"${contentHashOf(html).slice(0, 16)}"`;
        if (conditional?.etag === etag) {
          return {
            _tag: "NotModified",
            url,
            httpStatus: 304,
            etag,
            lastModified: undefined,
          } satisfies FetchResult;
        }
        return {
          _tag: "Fetched",
          url,
          httpStatus: 200,
          etag,
          lastModified: undefined,
          rawHtml: html,
          rawMarkdown: htmlToMarkdown(html),
        } satisfies FetchResult;
      }),
  });

const urls = Array.from(
  { length: 5 },
  (_, i) => `https://ce-catalog.test/courseDisplay.cfm?schID=${i + 1}`,
);
const contentFor = (i: number, status?: string) =>
  detailHtml({ sectionId: `SEC-${i + 1}`, ...(status !== undefined ? { status } : {}) });

describe("crawl", () => {
  it.layer(TestLive, { timeout: "120 seconds" })("Phase-1 ingest pipeline", (it) => {
    it.effect("captures, dedups, hashes by segment, and gates the sweep", () =>
      withTransactionRollback(Effect.gen(function*() {
        const sql = yield* SqlClient;
        const pages = new Map(urls.map((u, i) => [u, contentFor(i)]));
        const deps = Layer.mergeAll(makeFakePageSource(pages), FakeRobots);
        const crawl = (seeds: ReadonlyArray<string>) =>
          runCrawl({ seeds, concurrency: 1, minDelayMs: 0 }).pipe(Effect.provide(deps));
        const snapshotCount = Effect.map(
          sql<{ n: number; }>`SELECT count(*)::int AS n FROM page_snapshot`,
          (r) => r[0]?.n ?? -1,
        );

        // ── Run 1: first full crawl. Everything new; the clock starts. ──────────
        const r1 = yield* crawl(urls);
        expect(r1.fetched).toBe(5);
        expect(r1.newPages).toBe(5);
        expect(r1.snapshotsWritten).toBe(5);
        expect(r1.groupLinks).toBe(5); // "More offerings like this" captured on each
        expect(r1.status).toBe("ok");
        expect(r1.sweep.swept).toBe(true); // first run: nothing prior to protect
        expect(r1.sweep.disappeared).toBe(0);
        expect(yield* getEpoch).not.toBeNull(); // system_epoch seeded — clock started
        expect(yield* snapshotCount).toBe(5);

        // full capture + queryable fields + grouping, all persisted.
        // Result keys are camelCase (pgConfig transformResultNames snake→camel).
        const row = yield* sql<
          { rawMarkdown: string | null; status: string | null; groupUrl: string | null; }
        >`
          SELECT raw_markdown, page_fields->>'status' AS status, group_url
          FROM cecc_course_index_course_listing WHERE url = ${urls[0]!}
        `;
        expect(row[0]?.rawMarkdown).toContain("Registration Available"); // blocking gap closed
        expect(row[0]?.status).toBe("Registration Available"); // RAG-friendly jsonb
        expect(row[0]?.groupUrl).toContain("couID="); // §5.2.6 grouping ground truth

        // ── Run 2: nothing changed → conditional GET → 304 → no new snapshots. ──
        const r2 = yield* crawl(urls);
        expect(r2.notModified).toBe(5);
        expect(r2.fetched).toBe(0);
        expect(r2.snapshotsWritten).toBe(0);
        expect(yield* snapshotCount).toBe(5); // dedup: no growth

        // ── Run 3: one status flip. Listing hash moves; course hash does not. ──
        pages.set(urls[0]!, contentFor(0, "Course Full"));
        const r3 = yield* crawl(urls);
        expect(r3.fetched).toBe(1);
        expect(r3.notModified).toBe(4);
        expect(r3.listingChanged).toBe(1);
        expect(r3.courseChanged).toBe(0); // segmented hashing, in the pipeline
        expect(r3.snapshotsWritten).toBe(1);
        expect(yield* snapshotCount).toBe(6); // the changed page has two snapshots now

        // ── Run 4: a short crawl. The sweep MUST refuse (§6.2). ────────────────
        const r4 = yield* crawl([urls[0]!, urls[1]!]);
        expect(r4.pagesSeen).toBe(2);
        expect(r4.sweep.swept).toBe(false); // the headline safety property
        expect(r4.sweep.reason).toMatch(/REFUSED/);
        const goneAfter4 = yield* sql<{ n: number; }>`
          SELECT count(*)::int AS n FROM cecc_course_index_course_listing
          WHERE disappeared_at IS NOT NULL
        `;
        expect(goneAfter4[0]?.n).toBe(0); // nothing wrongly declared dead

        // ── Run 5: a plausible crawl missing one page → that page is swept. ────
        const r5 = yield* crawl(urls.slice(0, 4));
        expect(r5.pagesSeen).toBe(4);
        expect(r5.sweep.swept).toBe(true);
        expect(r5.sweep.disappeared).toBe(1); // schID=5, unobserved, marked gone
        const gone = yield* sql<{ disappearedAt: string | null; }>`
          SELECT disappeared_at FROM cecc_course_index_course_listing WHERE url = ${urls[4]!}
        `;
        expect(gone[0]?.disappearedAt).not.toBeNull();
        const live = yield* sql<{ disappearedAt: string | null; }>`
          SELECT disappeared_at FROM cecc_course_index_course_listing WHERE url = ${urls[0]!}
        `;
        expect(live[0]?.disappearedAt).toBeNull(); // a re-observed page stays live
      })));
  });
});
