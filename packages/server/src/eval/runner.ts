import { ListingFilter } from "@catalog/domain/filter";
import { Answerer } from "@catalog/domain/ports/answerer";
import { Judge } from "@catalog/domain/ports/judge";
import { KnowledgeBase } from "@catalog/domain/ports/knowledge-base";
import { Router } from "@catalog/domain/ports/router";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import * as Agent from "../agent/answer-agent.js";
import { filterListings } from "../retrieval/filter-listings.js";
import { canonicalFilter, type FieldDiff, fieldDiffs, filterExact } from "./filter-compare.js";
import type { Shape } from "./golden-set.js";
import { mrr, ndcgAt, recallAt } from "./metrics.js";

// The eval runner (architecture.md §11.3) — `Effect.forEach(items, { concurrency: 5 })`
// over the golden set, writing `eval_run` / `eval_result`. Phase 4 evaluates the two
// components that exist before the chat UI (ADR-009): the ROUTER (query → ListingFilter,
// the `filter_exact` headline) and RETRIEVAL (hybrid RRF + filter_listings, the nDCG/
// recall/MRR trio). `prose_faithful` waits for the Phase-5 answer agent + LlmJudge; the
// refusal axis is measured now from the router's §10.6 signal.
//
// Retrieval is scored per SHAPE so the §11.5 table breaks out cleanly (a single aggregate
// hides the finding):
//   • filtered / availability → the ACTUAL filter's course set (filter_listings). This
//     measures the filter COMPILATION; a broad filter legitimately has low recall@10 but
//     nDCG@10 ≈ 1 when the parse is right — which is exactly §1.1's "retrieval is easy".
//   • lookup / comparative / eligibility → hybrid search over the router's soft query.
//   • temporal / unanswerable → not retrieved; scored on refusal (§11.2).

const K = 20; // retrieve top-K courses; metrics cut at @10.

export interface EvalConfig {
  readonly today: Date;
  readonly gitSha: string;
  readonly routerVersion: string;
  readonly embeddingModel: string;
  readonly termsObserved: number;
  readonly concurrency: number;
  // Phase 5: when true, also run the FULL answer agent + LlmJudge per item to score
  // `prose_faithful` (§11.2). Opt-in (EVAL_PROSE=1) because it adds two LLM calls/item;
  // the CI gate (§11.4) stays on the cheap router+retrieval headlines.
  readonly evalProse: boolean;
}

export interface ItemResult {
  readonly itemId: string;
  readonly question: string;
  readonly shape: Shape;
  readonly band: string | null;
  readonly expectedRefuse: boolean;
  readonly filterExact: boolean | null;
  readonly ndcg10: number | null;
  readonly recallAt10: number | null;
  readonly mrr: number | null;
  readonly refused: boolean;
  readonly latencyMs: number;
  readonly diffs: ReadonlyArray<FieldDiff>;
  readonly proseFaithful: boolean | null; // §11.2 — null unless evalProse ran this item
}

export interface EvalRun {
  readonly runId: string;
  readonly results: ReadonlyArray<ItemResult>;
}

// Column names come back camelCased (pg-config `transformResultNames: snakeToCamel`).
interface ItemRow {
  readonly id: string;
  readonly question: string;
  readonly shape: Shape;
  readonly band: string | null;
  readonly expectedFilter: unknown; // jsonb object, or null
  readonly expectedIds: ReadonlyArray<string>; // bigint[] → string[]
  readonly rubric: string | null;
}

const decodeFilter = Schema.decodeUnknownSync(ListingFilter);
const decodeExpectedFilter = (raw: unknown): ListingFilter | null =>
  raw === null || raw === undefined ? null : decodeFilter(raw);

/** Distinct course ids passing `filter`, in filter_listings order, capped at `k`. */
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
    return ids;
  });

const isSoft = (shape: Shape): boolean =>
  shape === "lookup" || shape === "comparative" || shape === "eligibility";
const isHard = (shape: Shape): boolean => shape === "filtered" || shape === "availability";

const pgIntArray = (ids: ReadonlyArray<string>): string => `{${ids.join(",")}}`;

/** Render the hydrated cards as the judge's grounding CONTEXT (§11.2) — the real facts
 * the answer stands on, so an unsupported prose claim is catchable. */
const renderContext = (result: Agent.AnswerResult): string =>
  result.cards.length === 0
    ? "(no courses retrieved)"
    : result.cards
      .map((c) => {
        const fee = c.totalFeeCents === null ? "" : ` · $${(c.totalFeeCents / 100).toFixed(0)}`;
        const hrs = c.contactHours === null ? "" : ` · ${c.contactHours}h`;
        return `- ${c.courseTitle} [${c.status}] · ${c.campus} · ${c.deliveryMode}${hrs}${fee}`;
      })
      .join("\n");

/** Run the full answer agent + LlmJudge for one item and return `prose_faithful` (§11.2).
 * Independent of the retrieval scoring above — it measures the ANSWER, not the router. */
const scoreProse = (question: string, today: Date) =>
  Effect.gen(function*() {
    const result = yield* Agent.run(question, today);
    const judge = yield* Judge;
    const verdict = yield* judge.judge(question, result.answer.prose, renderContext(result));
    return verdict.faithful;
  }).pipe(
    // A judge/agent fault must not sink the whole run — score it null and move on.
    Effect.catchCause(() => Effect.succeed<boolean | null>(null)),
  );

const scoreOne = (row: ItemRow, cfg: EvalConfig) =>
  Effect.gen(function*() {
    const router = yield* Router;
    const kb = yield* KnowledgeBase;

    const expectedFilter = decodeExpectedFilter(row.expectedFilter);
    const relevant = new Set(row.expectedIds);
    const expectedRefuse = relevant.size === 0 && expectedFilter === null;

    const [duration, outcome] = yield* Effect.timed(Effect.gen(function*() {
      const decision = yield* router.route(row.question, cfg.today);

      // Retrieval, keyed on the item's shape (see header).
      let retrieved: ReadonlyArray<string> = [];
      if (!decision.refuse) {
        if (isHard(row.shape) && decision.filter !== null) {
          retrieved = yield* filterCourses(decision.filter, K);
        } else if (isSoft(row.shape) && decision.searchQuery !== null) {
          const hits = yield* kb.search(decision.searchQuery, K);
          retrieved = hits.map((h) => h.courseId as string);
        }
      }
      return { decision, retrieved };
    }));

    const { decision, retrieved } = outcome;
    const scored = relevant.size > 0;

    // §11.2 prose faithfulness — only when opted in (two extra LLM calls per item).
    const proseFaithful = cfg.evalProse
      ? yield* scoreProse(row.question, cfg.today)
      : null;

    return {
      itemId: row.id,
      question: row.question,
      shape: row.shape,
      band: row.band,
      expectedRefuse,
      // filter_exact is n/a for a refusal item (there is no correct filter to hit).
      filterExact: expectedRefuse ? null : filterExact(decision.filter, expectedFilter),
      ndcg10: scored ? ndcgAt(retrieved, relevant, 10) : null,
      recallAt10: scored ? recallAt(retrieved, relevant, 10) : null,
      mrr: scored ? mrr(retrieved, relevant) : null,
      refused: decision.refuse,
      latencyMs: Math.round(Duration.toMillis(duration)),
      diffs: expectedRefuse ? [] : fieldDiffs(decision.filter, expectedFilter),
      proseFaithful,
      retrievedIds: retrieved,
      // The canonical wire form of what the router actually asked for — persisted for
      // post-hoc inspection (a thumbs-down debugs against the exact filter, §12).
      actualFilterJson: canonicalFilter(decision.filter) || null,
    };
  });

/** Run the whole golden set, persist `eval_run` + `eval_result`, return the scored results. */
export const runEval = (
  cfg: EvalConfig,
): Effect.Effect<EvalRun, never, SqlClient | Router | KnowledgeBase | Answerer | Judge> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;

    // Only GRADED items (reviewed_at set) — feedback-promoted candidates (§5.5) stay
    // reviewed_at NULL until a human curates them, so they can never move the §11.4 gate.
    const items = yield* sql<ItemRow>`
      SELECT id::text AS id, question, shape, band, expected_filter,
             expected_ids::text[] AS expected_ids, rubric
      FROM eval_item WHERE reviewed_at IS NOT NULL ORDER BY id`;

    const config = {
      today: cfg.today.toISOString().slice(0, 10),
      routerVersion: cfg.routerVersion,
      embeddingModel: cfg.embeddingModel,
      termsObserved: cfg.termsObserved,
      k: K,
      evalProse: cfg.evalProse,
      note: cfg.evalProse
        ? "Phase 5: router + retrieval + answer agent + LlmJudge (prose_faithful)."
        : "router + retrieval; prose_faithful skipped (EVAL_PROSE=1 to enable).",
    };
    const runRows = yield* sql<{ id: string; }>`
      INSERT INTO eval_run (git_sha, config)
      VALUES (${cfg.gitSha}, ${JSON.stringify(config)}::jsonb)
      RETURNING id::text AS id`;
    const runId = runRows[0]!.id;

    const scored = yield* Effect.forEach(items, (row) => scoreOne(row, cfg), {
      concurrency: cfg.concurrency,
    });

    yield* Effect.forEach(scored, (r) =>
      sql`
        INSERT INTO eval_result
          (run_id, item_id, actual_filter, filter_exact, retrieved_ids,
           ndcg_10, recall_at_10, mrr, prose_faithful, refused, latency_ms, cost_micros)
        VALUES (
          ${runId}, ${r.itemId}, ${r.actualFilterJson}::jsonb,
          ${r.filterExact}, ${pgIntArray(r.retrievedIds)}::bigint[],
          ${r.ndcg10}, ${r.recallAt10}, ${r.mrr}, ${r.proseFaithful}, ${r.refused},
          ${r.latencyMs}, ${null})`, { concurrency: cfg.concurrency });

    yield* sql`UPDATE eval_run SET finished_at = now() WHERE id = ${runId}`;

    const results: ReadonlyArray<ItemResult> = scored.map((r) => ({
      itemId: r.itemId,
      question: r.question,
      shape: r.shape,
      band: r.band,
      expectedRefuse: r.expectedRefuse,
      filterExact: r.filterExact,
      ndcg10: r.ndcg10,
      recallAt10: r.recallAt10,
      mrr: r.mrr,
      refused: r.refused,
      latencyMs: r.latencyMs,
      diffs: r.diffs,
      proseFaithful: r.proseFaithful,
    }));
    return { runId, results };
  }).pipe(Effect.orDie);
