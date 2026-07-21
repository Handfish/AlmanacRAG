import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { filterListings } from "../retrieval/filter-listings.js";
import { canonicalFilter } from "./filter-compare.js";
import { GOLDEN_SET, type GoldenItem } from "./golden-set.js";

// Seed the golden set into `eval_item` (§11.1), resolving `expected_ids` LIVE against the
// corpus so the ground truth tracks the data (a re-crawl adds a section, a sweep retires
// one — §5.3). Idempotent: `ON CONFLICT (question)` upserts, so re-seeding after editing a
// label just refreshes it. The seed also computes each course-specific item's field-presence
// BAND (§2.1) from its target course, giving §11.1 its second stratification axis.

// ── expected_ids resolution ───────────────────────────────────────────────────
/** Distinct course ids (as text) whose live listings pass a `filter`-resolved item. */
const idsByFilter = (item: GoldenItem) =>
  Effect.gen(function*() {
    if (item.expectedFilter === null) return [] as ReadonlyArray<string>;
    const listings = yield* filterListings(item.expectedFilter, 100000);
    return [...new Set(listings.map((l) => l.courseId as string))];
  });

/** Distinct course ids whose title matches ANY pattern (ILIKE), for the soft shapes. */
const idsByTitle = (patterns: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    if (patterns.length === 0) return [] as ReadonlyArray<string>;
    const clauses = patterns.map((p) => sql`course_title ILIKE ${`%${p}%`}`);
    const rows = yield* sql<{ id: string; }>`
      SELECT id::text AS id FROM course WHERE ${sql.or(clauses)} ORDER BY id`;
    return rows.map((r) => r.id);
  });

const resolveExpectedIds = (item: GoldenItem) => {
  switch (item.resolve.kind) {
    case "filter":
      return idsByFilter(item);
    case "title":
      return idsByTitle(item.resolve.patterns);
    case "none":
      return Effect.succeed([] as ReadonlyArray<string>);
  }
};

// ── field-presence band (§2.1) — computed from the target course(s) ─────────────
// The core+tail gradient: count how many of the eight optional course fields are present.
// sparse (0–2) · core (3–5) · rich (6–8). Only meaningful for a course-specific item.
const bandOf = (courseIds: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const primary = courseIds[0];
    if (primary === undefined) return null;
    const rows = yield* sql<{ n: number; }>`
      SELECT (
        (description IS NOT NULL)::int + (audience IS NOT NULL)::int
        + (prerequisite_text IS NOT NULL)::int + (subject IS NOT NULL)::int
        + (track IS NOT NULL)::int + (program IS NOT NULL)::int
        + (contact_hours IS NOT NULL)::int + (registration_keyword IS NOT NULL)::int
      )::int AS n
      FROM course WHERE id = ${primary}`;
    const n = rows[0]?.n ?? 0;
    return n <= 2 ? "sparse" : n <= 5 ? "core" : "rich";
  });

const pgIntArray = (ids: ReadonlyArray<string>): string => `{${ids.join(",")}}`;

export interface SeedResolved {
  readonly item: GoldenItem;
  readonly expectedIds: ReadonlyArray<string>;
  readonly band: string | null;
}

export interface SeedResult {
  readonly total: number;
  readonly inserted: number;
  /** Items dropped because they are no longer in the golden set (e.g. a reworded question). */
  readonly removed: number;
  /** Non-refusal items that resolved to ZERO courses — a stale or mis-authored label. */
  readonly warnings: ReadonlyArray<string>;
}

// Reconcile: an item whose question text changed is a NEW item (question is the natural
// key), which orphans the old row. Drop any eval_item not in the current set, and its
// results first (no ON DELETE cascade on eval_result.item_id — a renamed item forfeits its
// history, which is correct: it no longer exists).
const reconcile = (keep: ReadonlySet<string>) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const existing = yield* sql<{ id: string; question: string; }>`
      SELECT id::text AS id, question FROM eval_item`;
    const orphans = existing.filter((e) => !keep.has(e.question)).map((e) => e.id);
    for (const id of orphans) {
      yield* sql`DELETE FROM eval_result WHERE item_id = ${id}`;
      yield* sql`DELETE FROM eval_item WHERE id = ${id}`;
    }
    return orphans.length;
  });

const upsertItem = (r: SeedResolved) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const expectedFilter = r.item.expectedFilter === null
      ? null
      : canonicalFilter(r.item.expectedFilter);
    yield* sql`
      INSERT INTO eval_item (question, shape, band, expected_filter, expected_ids, rubric,
                             reviewed_by, reviewed_at)
      VALUES (
        ${r.item.question}, ${r.item.shape}, ${r.band},
        ${expectedFilter}::jsonb, ${pgIntArray(r.expectedIds)}::bigint[], ${r.item.rubric},
        'golden-set-v1', now())
      ON CONFLICT (question) DO UPDATE SET
        shape = EXCLUDED.shape, band = EXCLUDED.band,
        expected_filter = EXCLUDED.expected_filter, expected_ids = EXCLUDED.expected_ids,
        rubric = EXCLUDED.rubric, reviewed_by = EXCLUDED.reviewed_by,
        reviewed_at = EXCLUDED.reviewed_at`;
  });

/** Resolve + upsert every golden item; report items whose label resolved to nothing. */
export const seedGoldenSet = (
  items: ReadonlyArray<GoldenItem> = GOLDEN_SET,
): Effect.Effect<SeedResult, never, SqlClient> =>
  Effect.gen(function*() {
    const warnings: Array<string> = [];
    let inserted = 0;
    for (const item of items) {
      const expectedIds = yield* resolveExpectedIds(item);
      // Band is the §2.1 field-presence gradient of a SPECIFIC target course, so it only
      // applies to the soft, course-anchored shapes — not to a broad filter's arbitrary
      // first row.
      const band = item.resolve.kind === "title" ? yield* bandOf(expectedIds) : null;
      yield* upsertItem({ item, expectedIds, band });
      inserted += 1;
      const isRefusal = item.resolve.kind === "none";
      if (!isRefusal && expectedIds.length === 0) {
        warnings.push(`[${item.shape}] resolved to 0 courses: ${item.question}`);
      }
    }
    const removed = yield* reconcile(new Set(items.map((i) => i.question)));
    return { total: items.length, inserted, removed, warnings };
  }).pipe(Effect.orDie);
