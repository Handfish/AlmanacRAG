import { ListingFilter } from "@catalog/domain/filter";
import * as Effect from "effect/Effect";
import { countListings, RELAXABLE_KEYS } from "./filter-listings.js";

// Zero-result relaxation (architecture.md §10.3) — "the strongest argument for typed
// filters over embeddings: you know which predicate killed it." When a `ListingFilter`
// matches nothing, drop ONE predicate at a time and count what comes back, turning the
// worst moment in a search UI into its most useful one:
//
//   > No evening Newark courses under $2,000 starting before September.
//   > · under $2,000  → 3 results
//   > · evenings      → 5 results
//   > · before Sept   → 2 results   ← drop one?
//
// N+1 count queries, trivial at this scale (§10.3). A vector search cannot do this: it
// returns nearest neighbours and says nothing about WHY. This is a plain WHERE relaxed
// one term at a time. The UI (§10.2/§10.3) renders each option as a one-click chip that
// re-runs `filter_listings` with that predicate removed — no LLM call.

/** How many results appear if a single predicate is dropped from the filter. `remaining`
 * is the human label for the predicate that stays absent (e.g. "evenings"), so the client
 * can render "drop `evenings` → 5 results" without re-deriving the filter's meaning. */
export interface Relaxation {
  /** The `ListingFilter` key that was dropped. */
  readonly key: string;
  /** A short human label for the dropped predicate (for the §10.3 chip). */
  readonly label: string;
  /** How many listings match once this predicate is removed. */
  readonly count: number;
}

export interface RelaxResult {
  /** Matches for the filter as-is. Relaxation only matters when this is 0 (§10.3). */
  readonly total: number;
  /** Per-predicate counts, only for predicates whose removal ADDS results, best-first. */
  readonly relaxations: ReadonlyArray<Relaxation>;
}

const fmtCents = (cents: number): string => {
  const dollars = cents / 100;
  return `$${dollars % 1 === 0 ? dollars.toFixed(0) : dollars.toFixed(2)}`;
};

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/** A short, human-readable label for a single predicate — what the chip says (§10.3). */
const labelFor = (key: keyof ListingFilter, value: unknown): string => {
  switch (key) {
    case "campus":
      return String(value);
    case "deliveryMode":
      return String(value).replace(/_/g, " ");
    case "status":
      return String(value);
    case "isEvening":
      return value === true ? "evenings" : "not evenings";
    case "term":
      return String(value);
    case "program":
      return String(value);
    case "ceccUnit":
      return String(value);
    case "maxFeeCents":
      return typeof value === "number" ? `under ${fmtCents(value)}` : "max fee";
    case "minFeeCents":
      return typeof value === "number" ? `over ${fmtCents(value)}` : "min fee";
    case "minHours":
      return `${String(value)}+ hours`;
    case "maxHours":
      return `≤ ${String(value)} hours`;
    case "startsAfter":
      return value instanceof Date ? `starts after ${isoDate(value)}` : "starts after";
    case "startsBefore":
      return value instanceof Date ? `starts before ${isoDate(value)}` : "starts before";
    case "openForReg":
      return "still open for registration";
    default:
      return String(key);
  }
};

/** Build a copy of `filter` with one key omitted (relaxing that predicate). */
const without = (filter: ListingFilter, drop: keyof ListingFilter): ListingFilter => {
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(filter)) {
    if (k === drop || v === undefined) continue;
    next[k] = v;
  }
  return new ListingFilter(next as ConstructorParameters<typeof ListingFilter>[0]);
};

/**
 * Count the filter as-is, and if it is empty, count each single-predicate relaxation
 * (§10.3). Returns only the relaxations that would ADD results (count > total), best
 * first — the "drop one?" menu. An empty list means no single drop helps (the filter is
 * over-constrained in more than one dimension, or genuinely nothing matches).
 */
export const relaxFilter = (filter: ListingFilter) =>
  Effect.gen(function*() {
    const total = yield* countListings(filter);

    // Which predicates are actually set (skip `includeGone`; it never "kills" a search).
    const active = RELAXABLE_KEYS.filter((k) => filter[k] !== undefined);
    if (total > 0 || active.length === 0) {
      return { total, relaxations: [] } satisfies RelaxResult;
    }

    const counted = yield* Effect.forEach(active, (key) =>
      countListings(without(filter, key)).pipe(
        Effect.map((count): Relaxation => ({ key, label: labelFor(key, filter[key]), count })),
      ), { concurrency: 5 });

    const relaxations = counted
      .filter((r) => r.count > total)
      .sort((a, b) => b.count - a.count);

    return { total, relaxations } satisfies RelaxResult;
  });
