import { ListingFilter } from "@catalog/domain/filter";
import type { CourseId } from "@catalog/domain/ids";
import { Embedder } from "@catalog/domain/ports/embedder";
import { KnowledgeBase } from "@catalog/domain/ports/knowledge-base";
import { Reranker } from "@catalog/domain/ports/reranker";
import type { RouteDecision } from "@catalog/domain/ports/router";
import { Router } from "@catalog/domain/ports/router";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { composeHistory } from "../history/format-history.js";
import { type AblationKnobs, ablationSearch } from "../retrieval/ablation-retrieve.js";
import { filterListings } from "../retrieval/filter-listings.js";
import { filterExact } from "./filter-compare.js";
import { EVAL_TODAY, type Shape } from "./golden-set.js";
import { meanOrNull, ndcgAt } from "./metrics.js";

// The §11.5 ablation ladder — "the README centerpiece", broken out by query shape because
// "a single aggregate hides the entire finding". Each row flips ONE knob relative to the
// row above, so the table reads as a causal chain: what does each capability buy?
//
//   naive chunks, vector only  → no prefixes, no lexical half, no rerank, no router
//   + contextual prefixes      → §7.3 situating prefix (the no-prefix vs with-prefix model)
//   + hybrid RRF               → fuse BM25 with the vector half (§7.2)
//   + reranker                 → cross-encode the fused pool (§11.6)
//   + typed filter routing     → the router's ListingFilter drives HARD shapes (§8) and
//                                refusal (§10.6) turns on — this is where filter_exact and
//                                filtered-recall are supposed to jump (attention is not a
//                                WHERE clause, §1.1)
//   + retention & history      → temporal questions route to course_history (§5.3/§8.1),
//                                the one capability the compact-index baseline CANNOT have
//
// The whole ladder runs on ONE router decision + ONE query embedding per item (both are
// config-independent), so the sweep costs ~1 router + ~1 embed call per golden item total,
// not per row — the rest is pure Postgres.

export interface AblationConfig {
  readonly key: string;
  readonly label: string;
  readonly contextPrefix: boolean; // false → the ::noprefix embedding set
  readonly hybrid: boolean; // false → vector-only kNN
  readonly rerank: boolean;
  readonly filterRouting: boolean; // false → the router's filter/refusal are NOT applied
  readonly history: boolean; // temporal → course_history (true) vs refuse (false)
}

/** The cumulative ladder (§11.5), top to bottom. */
export const LADDER: ReadonlyArray<AblationConfig> = [
  {
    key: "vec",
    label: "naive chunks, vector only",
    contextPrefix: false,
    hybrid: false,
    rerank: false,
    filterRouting: false,
    history: false,
  },
  {
    key: "prefix",
    label: "+ contextual prefixes",
    contextPrefix: true,
    hybrid: false,
    rerank: false,
    filterRouting: false,
    history: false,
  },
  {
    key: "hybrid",
    label: "+ hybrid RRF",
    contextPrefix: true,
    hybrid: true,
    rerank: false,
    filterRouting: false,
    history: false,
  },
  {
    key: "rerank",
    label: "+ reranker",
    contextPrefix: true,
    hybrid: true,
    rerank: true,
    filterRouting: false,
    history: false,
  },
  {
    key: "filter",
    label: "+ typed filter routing",
    contextPrefix: true,
    hybrid: true,
    rerank: true,
    filterRouting: true,
    history: false,
  },
  {
    key: "history",
    label: "+ retention & history",
    contextPrefix: true,
    hybrid: true,
    rerank: true,
    filterRouting: true,
    history: true,
  },
];

const K = 20; // retrieve top-K; metrics cut at @10

export interface AblationRow {
  readonly key: string;
  readonly label: string;
  readonly filterRouting: boolean;
  readonly filterExactPct: number | null; // null (rendered "—") when filter routing is off
  readonly ndcgLookup: number | null;
  readonly ndcgFiltered: number | null;
  readonly refusalPct: number | null;
  readonly memory: boolean;
  readonly p95Ms: number;
  readonly n: number;
}

// ── golden items (mirror runner.ts) ──────────────────────────────────────────
interface ItemRow {
  readonly id: string;
  readonly question: string;
  readonly shape: Shape;
  readonly expectedFilter: unknown;
  readonly expectedIds: ReadonlyArray<string>;
}

const decodeFilter = Schema.decodeUnknownSync(ListingFilter);
const decodeExpectedFilter = (raw: unknown): ListingFilter | null =>
  raw === null || raw === undefined ? null : decodeFilter(raw);

const isHard = (shape: Shape): boolean => shape === "filtered" || shape === "availability";

/** Distinct course ids passing `filter`, in filter_listings order, capped at `k`
 * (config-independent — cached once per item). */
const filterCourses = (filter: ListingFilter, k: number) =>
  Effect.gen(function*() {
    const listings = yield* filterListings(filter, 400);
    const seen = new Set<string>();
    const ids: Array<string> = [];
    for (const l of listings) {
      const id = l.courseId as string;
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= k) break;
    }
    return ids as ReadonlyArray<string>;
  });

// Everything the config-independent prep resolves ONCE per item.
interface Prepared {
  readonly row: ItemRow;
  readonly decision: RouteDecision;
  readonly relevant: ReadonlySet<string>;
  readonly expectedFilter: ListingFilter | null;
  readonly isTemporal: boolean;
  readonly expectedRefuse: boolean;
  readonly queryText: string;
  readonly queryEmbedding: ReadonlyArray<number> | null;
  readonly filterCourseIds: ReadonlyArray<string> | null; // filter_listings result, cached
}

const prepareItem = (row: ItemRow) =>
  Effect.gen(function*() {
    const router = yield* Router;
    const embedder = yield* Embedder;

    const decision = yield* router.route(row.question, EVAL_TODAY);
    const expectedFilter = decodeExpectedFilter(row.expectedFilter);
    const relevant = new Set(row.expectedIds);
    const isTemporal = row.shape === "temporal";
    const expectedRefuse = !isTemporal && relevant.size === 0 && expectedFilter === null;

    // Soft query text — the router's extracted topic, falling back to the raw question so a
    // pure-structured route still has something to search (keeps every row comparable).
    const queryText = decision.searchQuery ?? row.question;
    // Embed once; reused for every ablation row (the vector is model-agnostic).
    const embedded = yield* embedder.embed([queryText], "query");
    const queryEmbedding = embedded[0] ?? null;

    const filterCourseIds = decision.filter !== null
      ? yield* filterCourses(decision.filter, K)
      : null;

    return {
      row,
      decision,
      relevant,
      expectedFilter,
      isTemporal,
      expectedRefuse,
      queryText,
      queryEmbedding,
      filterCourseIds,
    } satisfies Prepared;
  });

export interface ItemScore {
  readonly shape: Shape;
  readonly filterExact: boolean | null;
  readonly ndcg10: number | null;
  readonly refused: boolean;
  readonly expectedRefuse: boolean;
  readonly latencyMs: number;
}

/** Score one prepared item under one config. Pure Postgres — no LLM call (the router
 * decision and query embedding are already resolved), except the temporal-history path
 * which resolves the course via KnowledgeBase.search when `history` is on. */
const scoreItem = (
  prep: Prepared,
  cfg: AblationConfig,
  knobs: AblationKnobs,
) =>
  Effect.gen(function*() {
    const kb = yield* KnowledgeBase;
    const { decision, row } = prep;
    const scored = !prep.isTemporal && prep.relevant.size > 0;

    const [duration, retrieved] = yield* Effect.timed(Effect.gen(function*() {
      // Temporal: history on → route to course_history; off → the Phase-4 refusal stopgap.
      if (prep.isTemporal) return [] as ReadonlyArray<string>;
      // Refusal only applies once the router is "in" (typed filter routing on).
      if (cfg.filterRouting && decision.refuse) return [] as ReadonlyArray<string>;

      if (isHard(row.shape) && cfg.filterRouting && prep.filterCourseIds !== null) {
        return prep.filterCourseIds;
      }
      if (prep.queryEmbedding === null) return [] as ReadonlyArray<string>;
      const hits = yield* ablationSearch(knobs, {
        queryEmbedding: prep.queryEmbedding,
        queryText: prep.queryText,
        limit: K,
      });
      return hits.map((h) => h.courseId);
    }));

    // The config's effective refusal: temporal is refused only when history is off; an
    // ordinary refusal fires only when the router is in (filter routing on).
    let refused: boolean;
    if (prep.isTemporal) {
      refused = !cfg.history; // history on → routed to course_history, not a refusal
      if (cfg.history) {
        // Resolve + compose so a misroute or a fabricated pattern would show as a wrong
        // verdict; the retrieval columns don't score temporal, but honesty must hold.
        const hits = decision.historyQuery !== null
          ? yield* kb.search(decision.historyQuery, 1)
          : [];
        const courseId = hits[0]?.courseId ?? null;
        const history = courseId === null ? null : yield* kb.courseHistory(courseId as CourseId);
        const composed = composeHistory(history, decision.historyQuery ?? row.question);
        refused = composed.verdict === "not_found";
      }
    } else {
      refused = cfg.filterRouting && decision.refuse;
    }

    const scorable = !prep.expectedRefuse && !prep.isTemporal;
    return {
      shape: row.shape,
      filterExact: (cfg.filterRouting && scorable)
        ? filterExact(decision.filter, prep.expectedFilter)
        : null,
      ndcg10: scored ? ndcgAt(retrieved, prep.relevant, 10) : null,
      refused,
      expectedRefuse: prep.expectedRefuse,
      latencyMs: Math.round(Duration.toMillis(duration)),
    } satisfies ItemScore;
  });

const pctTrue = (xs: ReadonlyArray<boolean>): number | null =>
  xs.length === 0 ? null : (100 * xs.filter((x) => x).length) / xs.length;

const percentile = (xs: ReadonlyArray<number>, p: number): number => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
};

const aggregate = (cfg: AblationConfig, scores: ReadonlyArray<ItemScore>): AblationRow => {
  const fe = scores.map((s) => s.filterExact).filter((x): x is boolean => x !== null);
  const lookup = scores.filter((s) => s.shape === "lookup").map((s) => s.ndcg10).filter((
    x,
  ): x is number => x !== null);
  const filtered = scores.filter((s) => s.shape === "filtered").map((s) => s.ndcg10).filter((
    x,
  ): x is number => x !== null);
  const refusalSlice = scores.filter((s) => s.expectedRefuse);
  return {
    key: cfg.key,
    label: cfg.label,
    filterRouting: cfg.filterRouting,
    filterExactPct: cfg.filterRouting ? (pctTrue(fe) ?? 0) : null,
    ndcgLookup: meanOrNull(lookup),
    ndcgFiltered: meanOrNull(filtered),
    refusalPct: pctTrue(refusalSlice.map((s) => s.refused)),
    memory: cfg.history,
    p95Ms: percentile(scores.map((s) => s.latencyMs), 0.95),
    n: scores.length,
  };
};

export interface AblationInput {
  readonly withPrefixModelId: number;
  readonly noPrefixModelId: number;
  readonly concurrency: number;
}

export interface AblationResult {
  readonly rows: ReadonlyArray<AblationRow>;
  readonly itemCount: number;
}

/** Run the full §11.5 ladder over the reviewed golden set. */
export const runAblation = (
  input: AblationInput,
): Effect.Effect<
  AblationResult,
  never,
  SqlClient | Router | KnowledgeBase | Embedder | Reranker
> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const items = yield* sql<ItemRow>`
      SELECT id::text AS id, question, shape, expected_filter,
             expected_ids::text[] AS expected_ids
      FROM eval_item WHERE reviewed_at IS NOT NULL ORDER BY id`;

    // Prep: one router + one embed call per item (config-independent). Bounded concurrency
    // so a whole run is a handful of provider calls in flight at once.
    const prepared = yield* Effect.forEach(items, prepareItem, {
      concurrency: input.concurrency,
    });

    // Score each config over the prepared items — pure Postgres, so unbounded within a row.
    const rows = yield* Effect.forEach(LADDER, (cfg) =>
      Effect.gen(function*() {
        const knobs: AblationKnobs = {
          modelId: cfg.contextPrefix ? input.withPrefixModelId : input.noPrefixModelId,
          hybrid: cfg.hybrid,
          rerank: cfg.rerank,
        };
        const scores = yield* Effect.forEach(prepared, (p) => scoreItem(p, cfg, knobs), {
          concurrency: input.concurrency,
        });
        return aggregate(cfg, scores);
      }));

    return { rows, itemCount: items.length } satisfies AblationResult;
  }).pipe(Effect.orDie);
