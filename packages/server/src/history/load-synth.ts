import type { TermSeason } from "@catalog/domain/course";
import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { refreshTermsObserved } from "../retrieval/course-history.js";
import {
  balancedArchetype,
  planSyntheticHistory,
  type SeedCourse,
  type SynthListing,
  type SynthPlan,
} from "./synth-history.js";

// Materialize a synthetic-history plan (synth-history.ts) into Postgres. This is the ONLY
// place fabricated terms touch a database, and it is deliberately loud about it: every
// synthetic row is tagged (`detail_url`/`url` prefix `synthetic://`, `extraction.prompt_version
// = 'synthetic-history'`), and an `app_meta` marker `synthetic_history = true` makes any DB
// carrying fake history self-identifying. Idempotent — a reload clears the prior synthetic
// rows first. Intended for a testcontainer or a clearly marked SCRATCH DB, never the real
// catalog (the CLI, main-synth-history.ts, gates on an explicit env flag).

export const SYNTHETIC_MARKER = "synthetic_history";
const SYNTH_PREFIX = "synthetic://";

/** True if this database has ever had synthetic history loaded (the `app_meta` marker). */
export const isSyntheticDb = Effect.gen(function*() {
  const sql = yield* SqlClient;
  const rows = yield* sql<{ value: string; }>`
    SELECT value FROM app_meta WHERE key = ${SYNTHETIC_MARKER}`;
  return rows[0]?.value === "true";
});

/** Remove every previously loaded synthetic row (listings cascade to fees + changes), so a
 * reload is idempotent. Deletion order respects the FKs: listing → extraction → source page. */
export const clearSyntheticHistory = Effect.gen(function*() {
  const sql = yield* SqlClient;
  yield* sql`DELETE FROM listing WHERE detail_url LIKE ${`${SYNTH_PREFIX}%`}`;
  yield* sql`DELETE FROM extraction WHERE prompt_version = 'synthetic-history'`;
  yield* sql`DELETE FROM cecc_course_index_course_listing WHERE url LIKE ${`${SYNTH_PREFIX}%`}`;
});

const ensureSyntheticModel = Effect.gen(function*() {
  const sql = yield* SqlClient;
  yield* sql`
    INSERT INTO model (name, kind) VALUES ('synthetic-history', 'llm')
    ON CONFLICT (name) DO NOTHING`;
  const rows = yield* sql<{ id: number; }>`
    SELECT id FROM model WHERE name = 'synthetic-history'`;
  return rows[0]!.id;
});

const insertListing = (l: SynthListing, modelId: number) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    // The provenance page (a different URL per term — exactly how a new term appears on the
    // real site). Deterministic uuid, so a reload after a clear reproduces the same rows.
    yield* sql`
      INSERT INTO cecc_course_index_course_listing
        (id, url, last_hash_comparison_at, first_seen_at, last_seen_at, disappeared_at)
      VALUES (${l.sourcePageId}, ${l.detailUrl}, ${l.lastSeenAt},
              ${l.firstSeenAt}, ${l.lastSeenAt}, ${l.disappearedAt})
      ON CONFLICT (id) DO NOTHING`;
    const extId = (yield* sql<{ id: string; }>`
      INSERT INTO extraction (source_page_id, model_id, prompt_version, status)
      VALUES (${l.sourcePageId}, ${modelId}, 'synthetic-history', 'ok')
      RETURNING id::text AS id`)[0]!.id;
    const listingId = (yield* sql<{ id: string; }>`
      INSERT INTO listing
        (source_page_id, extraction_id, course_id, term, term_season, term_year,
         starts_on, ends_on, status, campus, delivery_mode, total_fee_cents,
         detail_url, first_seen_at, last_seen_at, disappeared_at)
      VALUES
        (${l.sourcePageId}, ${extId}, ${l.courseId}, ${l.term}, ${l.termSeason}, ${l.termYear},
         ${l.startsOn}, ${l.endsOn}, ${l.status}, ${l.campus}, ${l.deliveryMode}, ${l.totalFeeCents},
         ${l.detailUrl}, ${l.firstSeenAt}, ${l.lastSeenAt}, ${l.disappearedAt})
      RETURNING id::text AS id`)[0]!.id;
    if (l.totalFeeCents !== null) {
      yield* sql`
        INSERT INTO listing_fee (listing_id, ord, label, amount_cents, is_total)
        VALUES (${listingId}, 0, 'Total Fees', ${l.totalFeeCents}, true)`;
    }
    for (const c of l.changes) {
      yield* sql`
        INSERT INTO listing_change (listing_id, field, old_value, new_value, observed_at)
        VALUES (${listingId}, ${c.field}, ${c.oldValue}, ${c.newValue}, ${c.observedAt})`;
    }
  });

export interface LoadResult {
  readonly listings: number;
  readonly observingSince: string;
  readonly termsObserved: number;
}

/** Insert a plan, move the observation window back to cover it, refresh `terms_observed`,
 * and set the `synthetic_history` marker. Clears any prior synthetic rows first. */
export const loadSynthPlan = (plan: SynthPlan) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    yield* clearSyntheticHistory;
    const modelId = yield* ensureSyntheticModel;
    yield* Effect.forEach(plan.listings, (l) => insertListing(l, modelId), { discard: true });

    // Move the clock back to cover the fabricated terms (LEAST keeps the earliest known
    // start) so the scratch DB reports a consistent — if fabricated — observation window.
    yield* sql`
      INSERT INTO system_epoch (id, observing_since) VALUES (1, ${plan.observingSince})
      ON CONFLICT (id) DO UPDATE
        SET observing_since = LEAST(system_epoch.observing_since, EXCLUDED.observing_since)`;
    const termsObserved = yield* refreshTermsObserved;

    yield* sql`
      INSERT INTO app_meta (key, value) VALUES (${SYNTHETIC_MARKER}, 'true')
      ON CONFLICT (key) DO UPDATE SET value = 'true', updated_at = now()`;

    return {
      listings: plan.listings.length,
      observingSince: plan.observingSince,
      termsObserved,
    } satisfies LoadResult;
  });

interface SeedRow {
  readonly courseId: string;
  readonly courseTitle: string;
  readonly termSeason: TermSeason;
  readonly termYear: number;
  readonly totalFeeCents: number | null;
  readonly campus: string | null;
  readonly deliveryMode: string | null;
}

/** Read up to `limit` real live courses as generator seeds — one current, dated listing per
 * course (the most recent term). Only dated, live listings qualify (we clone backward from a
 * known anchor term). */
export const collectSeedCourses = (limit: number) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const rows = yield* sql<SeedRow>`
      SELECT DISTINCT ON (l.course_id)
        l.course_id::text  AS course_id,
        co.course_title    AS course_title,
        l.term_season      AS term_season,
        l.term_year        AS term_year,
        l.total_fee_cents  AS total_fee_cents,
        l.campus           AS campus,
        l.delivery_mode    AS delivery_mode
      FROM listing l
      JOIN course co ON co.id = l.course_id
      WHERE l.disappeared_at IS NULL
        AND l.term_season IS NOT NULL
        AND l.term_year IS NOT NULL
        AND l.detail_url NOT LIKE ${`${SYNTH_PREFIX}%`}
      ORDER BY l.course_id, l.term_rank DESC
      LIMIT ${limit}`;
    return rows.map((r): SeedCourse => ({
      courseId: r.courseId,
      courseTitle: r.courseTitle,
      season: r.termSeason,
      year: r.termYear,
      feeCents: r.totalFeeCents,
      campus: r.campus,
      deliveryMode: r.deliveryMode,
    }));
  });

/** End-to-end for the CLI/scratch DB: read real seed courses, plan synthetic prior terms,
 * and load them. `balanced` forces all three archetypes over the seed order (a demo/eval
 * fixture); otherwise the archetype is hashed per course. */
export const synthesizeAndLoad = (options: { limit: number; balanced: boolean; }) =>
  Effect.gen(function*() {
    const seeds = yield* collectSeedCourses(options.limit);
    const plan = options.balanced
      ? planSyntheticHistory(seeds, {
        assignArchetype: balancedArchetype(seeds.map((s) => s.courseId)),
      })
      : planSyntheticHistory(seeds);
    const result = yield* loadSynthPlan(plan);
    return { ...result, seeds: seeds.length, assignments: plan.assignments };
  });
