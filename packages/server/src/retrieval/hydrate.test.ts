import type { ListingId } from "@catalog/domain/ids";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgMigrator from "@effect/sql-pg/PgMigrator";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { PgTest, withTransactionRollback } from "../db/pg-test.js";
import { hydrateCards, listingsForCourses, readObservationWindow } from "./hydrate.js";

// The §1 guarantee in SQL (§10.4), against a real testcontainer: a `listingId` resolves to
// a full `Card` whose FACTS — status, fees, dates, freshness — come from Postgres, and
// `listingsForCourses` turns a course id into its current live listing. Freshness reads
// the source page's `last_hash_comparison_at`.

const TestLive = PgMigrator.layer({
  loader: Migrator.fromGlob(import.meta.glob("../db/migrations/*.ts")),
}).pipe(Layer.provide(NodeServices.layer), Layer.orDie, Layer.provideMerge(PgTest));

const seed = Effect.gen(function*() {
  const sql = yield* SqlClient;
  const modelId = (yield* sql<{ id: number; }>`
    INSERT INTO model (name, kind) VALUES ('test-llm', 'llm') RETURNING id`)[0]!.id;
  const courseId = (yield* sql<{ id: string; }>`
    INSERT INTO course (group_url, course_title, title_normalized, contact_hours,
                        registration_keyword, external_course_id)
    VALUES ('https://x/couID=1', 'Grant Writing I', 'grant writing i', 12,
            'Grant Writing', 'GW-101')
    RETURNING id::text AS id`)[0]!.id;
  const pageId = (yield* sql<{ id: string; }>`
    INSERT INTO cecc_course_index_course_listing (url, last_hash_comparison_at)
    VALUES ('https://x/schID=1', '2026-07-21T09:00:00Z')
    RETURNING id::text AS id`)[0]!.id;
  const extId = (yield* sql<{ id: string; }>`
    INSERT INTO extraction (source_page_id, model_id, prompt_version, status)
    VALUES (${pageId}, ${modelId}, 'v1', 'ok') RETURNING id::text AS id`)[0]!.id;
  const listingId = (yield* sql<{ id: string; }>`
    INSERT INTO listing
      (source_page_id, extraction_id, course_id, status, campus, delivery_mode,
       total_fee_cents, starts_on, ends_on, term, detail_url, registration_url)
    VALUES
      (${pageId}, ${extId}, ${courseId}, 'open', 'Newark', 'online_sync',
       41500, '2026-07-20', '2026-08-03', 'Summer 2026', 'https://x/schID=1', null)
    RETURNING id::text AS id`)[0]!.id;
  yield* sql`
    INSERT INTO listing_fee (listing_id, ord, label, amount_cents, is_total) VALUES
      (${listingId}, 0, 'Tuition', 40000, false),
      (${listingId}, 1, 'Total Fees', 41500, true)`;
  return { courseId, listingId };
});

describe("hydrate", () => {
  it.layer(TestLive, { timeout: "90 seconds" })("live card hydration", (it) => {
    it.effect("hydrateCards reads facts + fees + freshness from Postgres, attaches why", () =>
      withTransactionRollback(Effect.gen(function*() {
        const { listingId } = yield* seed;
        const why = new Map([[listingId, "the evening option"]]);
        const cards = yield* hydrateCards([listingId as ListingId], why);
        expect(cards.length).toBe(1);
        const c = cards[0]!;
        expect(c.courseTitle).toBe("Grant Writing I");
        expect(c.status).toBe("open");
        expect(c.campus).toBe("Newark");
        expect(c.totalFeeCents).toBe(41500);
        expect(c.startsOn).toBe("2026-07-20");
        expect(c.registrationKeyword).toBe("Grant Writing");
        expect(c.externalCourseId).toBe("GW-101");
        // every fee line, is_total on the total (§9.2 — never "the first dollar figure")
        expect(c.fees.map((f) => [f.label, f.amountCents, f.isTotal])).toEqual([
          ["Tuition", 40000, false],
          ["Total Fees", 41500, true],
        ]);
        expect(c.checkedAt).toBe("2026-07-21T09:00:00Z"); // last_hash_comparison_at
        expect(c.why).toBe("the evening option");
      })));

    it.effect("hydrateCards preserves input order and drops unknown ids", () =>
      withTransactionRollback(Effect.gen(function*() {
        const { listingId } = yield* seed;
        const cards = yield* hydrateCards(
          ["999999" as ListingId, listingId as ListingId, "888888" as ListingId],
          new Map(),
        );
        expect(cards.map((c) => c.listingId as string)).toEqual([listingId]);
      })));

    it.effect("listingsForCourses returns the live listing for a course id", () =>
      withTransactionRollback(Effect.gen(function*() {
        const { courseId, listingId } = yield* seed;
        const rows = yield* listingsForCourses([courseId as never], 1);
        expect(rows.map((r) => r.listingId as string)).toEqual([listingId]);
        expect(rows[0]!.courseTitle).toBe("Grant Writing I");
      })));

    it.effect("readObservationWindow returns the seeded epoch", () =>
      withTransactionRollback(Effect.gen(function*() {
        const sql = yield* SqlClient;
        yield* sql`INSERT INTO system_epoch (id, observing_since, terms_observed)
                   VALUES (1, '2026-07-16T00:00:00Z', 1)
                   ON CONFLICT (id) DO UPDATE SET observing_since = EXCLUDED.observing_since,
                                                  terms_observed = EXCLUDED.terms_observed`;
        const w = yield* readObservationWindow();
        expect(w.observingSince).toBe("2026-07-16");
        expect(w.termsObserved).toBe(1);
      })));
  });
});
