import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { GeminiApiKey, generateJson } from "../adapters/ai-gemini.js";
import type { Shape } from "./golden-set.js";
import { meanOrNull, ndcgAt } from "./metrics.js";

// The compact-index baseline (architecture.md §1.1 / §11.5) — "the honest competitor". Not
// naive prompt-stuffing (the whole catalog is ~870k tokens and does not fit), but one
// ~50-token line per live section, ~54k tokens, in-window and cacheable. The model reads the
// entire compact index and picks the matching sections by ATTENTION — no WHERE clause, no
// hydration, no memory. §1.1's explicit prediction: competitive on lookup/comparative, loses
// on filtered (attention misses rows), and CANNOT do temporal at all (last term isn't in the
// prompt). This row exists to hold that prediction to a number — "a permanent row in §11.5,
// not a strawman".
//
// It is deliberately a SEPARATE path from the ladder: it never touches retrieval, filters, or
// hydration. filter_exact is n/a (it emits no ListingFilter); Fresh is ✗ (prompt text is as
// stale as the last rebuild); Memory is ✗ (impossible at any price, §1.1). It is scored on the
// SAME retrieval metrics (nDCG by shape, refusal) as the ladder.

/** Plain char/4 token estimate — NOT the smallint-capped `chunk-text.estimateTokens`, so the
 * whole-catalog figure (~870k) isn't clipped to 32767. */
export const roughTokens = (text: string): number => Math.ceil(text.length / 4);

/** Model behind the baseline. Defaults to the same flash-lite the router/answerer use, so the
 * comparison is our-pipeline vs same-model-prompt-stuffing (the fair contrast), not a
 * model-tier confound. Override via BASELINE_MODEL. */
export const BaselineModel = Config.string("BASELINE_MODEL").pipe(
  Config.withDefault("gemini-3.1-flash-lite"),
);

// ── the compact index line (§1.1 "~50-token line per listing") ───────────────
export interface CompactListing {
  readonly courseId: string;
  readonly courseTitle: string;
  readonly campus: string | null;
  readonly deliveryMode: string | null;
  readonly status: string;
  readonly term: string | null;
  readonly totalFeeCents: number | null;
  readonly contactHours: number | null;
  readonly isEvening: boolean | null;
}

/** One compact line, tagged with its course_id so the model's picks map back to the ground
 * truth (`expected_ids` is a course set). ~50 tokens by construction. */
export const compactLine = (l: CompactListing): string => {
  const fee = l.totalFeeCents === null ? "" : ` $${(l.totalFeeCents / 100).toFixed(0)}`;
  const hrs = l.contactHours === null ? "" : ` ${l.contactHours}h`;
  const parts = [
    l.campus ?? "?",
    l.deliveryMode ?? "?",
    l.status,
    l.term ?? "?",
    l.isEvening === true ? "eve" : "",
  ].filter((p) => p !== "");
  return `[${l.courseId}] ${l.courseTitle} | ${parts.join(" ")}${fee}${hrs}`;
};

export const BASELINE_SYSTEM =
  `You are a course-catalog assistant. Below is the ENTIRE catalog as a compact index — one line per section, tagged [course_id]. Answer using ONLY these lines; never invent a course. When the request is out of scope for this catalog (e.g. a degree it doesn't offer) or too vague to match, refuse.`;

const buildUserPrompt = (question: string, index: string): string =>
  `CATALOG INDEX (one line per section):\n${index}\n\n`
  + `QUESTION: ${question}\n\n`
  + `Return the course_ids of every matching section, most relevant first. If nothing matches `
  + `or the request is out of scope, set refuse=true and courseIds=[].`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    courseIds: { type: "ARRAY", items: { type: "STRING" }, nullable: false },
    refuse: { type: "BOOLEAN", nullable: false },
  },
  required: ["courseIds", "refuse"],
  propertyOrdering: ["courseIds", "refuse"],
  nullable: false,
} as const;

/** Parse the model's JSON pick. Tolerant: bad JSON or a missing field reads as a refusal
 * with no ids (so a malformed answer scores as "found nothing", never throws). Pure. */
export const parseBaselineAnswer = (
  text: string | null,
): { courseIds: ReadonlyArray<string>; refuse: boolean; } => {
  if (text === null) return { courseIds: [], refuse: true };
  try {
    const parsed = JSON.parse(text) as { courseIds?: unknown; refuse?: unknown; };
    const ids = Array.isArray(parsed.courseIds)
      ? parsed.courseIds.filter((x): x is string => typeof x === "string" && /^\d+$/.test(x))
      : [];
    return { courseIds: ids, refuse: parsed.refuse === true };
  } catch {
    return { courseIds: [], refuse: true };
  }
};

interface ItemRow {
  readonly id: string;
  readonly question: string;
  readonly shape: Shape;
  readonly expectedFilter: unknown;
  readonly expectedIds: ReadonlyArray<string>;
}

export interface BaselineResult {
  readonly label: string;
  readonly model: string;
  readonly indexLines: number;
  readonly indexTokens: number;
  readonly ndcgLookup: number | null;
  readonly ndcgFiltered: number | null;
  readonly refusalPct: number | null;
  readonly p95Ms: number;
  readonly avgInputTokens: number | null; // per query — the cacheable ~54k
  readonly avgOutputTokens: number | null;
  readonly wholeCatalogTokens: number; // ~870k — the "does not fit" figure
  readonly itemCount: number;
}

const percentile = (xs: ReadonlyArray<number>, p: number): number => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
};
const pctTrue = (xs: ReadonlyArray<boolean>): number | null =>
  xs.length === 0 ? null : (100 * xs.filter((x) => x).length) / xs.length;

/**
 * Run the compact-index baseline over the reviewed golden set. Builds the index once (its
 * token count is the §1.1 "~54k, cacheable" claim, measured), then one big-context LLM call
 * per item picks matching course_ids by attention. Temporal items are EXCLUDED from scoring —
 * the baseline structurally cannot answer them (no memory) — but the whole-catalog token
 * figure is computed so the "does not fit" row is a measurement, not an assertion.
 */
export const runCompactBaseline = (
  concurrency: number,
): Effect.Effect<BaselineResult, never, SqlClient> =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const apiKey = yield* GeminiApiKey;
    const model = yield* BaselineModel;

    // Build the compact index over LIVE sections (disappeared_at IS NULL) — the freshest
    // snapshot a rebuild could capture. This is the baseline's entire world.
    const listings = yield* sql<CompactListing>`
      SELECT l.course_id::text AS course_id, co.course_title,
             l.campus, l.delivery_mode, l.status, l.term,
             l.total_fee_cents, co.contact_hours::float8 AS contact_hours, l.is_evening
      FROM listing l JOIN course co ON co.id = l.course_id
      WHERE l.disappeared_at IS NULL
      ORDER BY co.course_title, l.id`;
    const index = listings.map(compactLine).join("\n");
    const indexTokens = roughTokens(BASELINE_SYSTEM + index);

    // The whole-catalog figure (§11.5 "does not fit — ~870k tok") — sum of the full page
    // markdown over live sections.
    const wholeRows = yield* sql<{ chars: number; }>`
      SELECT coalesce(sum(length(sp.raw_markdown)), 0)::bigint AS chars
      FROM listing l
      JOIN cecc_course_index_course_listing sp ON sp.id = l.source_page_id
      WHERE l.disappeared_at IS NULL`;
    const wholeCatalogTokens = Math.ceil(Number(wholeRows[0]?.chars ?? 0) / 4);

    const items = yield* sql<ItemRow>`
      SELECT id::text AS id, question, shape, expected_filter,
             expected_ids::text[] AS expected_ids
      FROM eval_item WHERE reviewed_at IS NOT NULL ORDER BY id`;

    const scored = yield* Effect.forEach(items, (row) =>
      Effect.gen(function*() {
        const relevant = new Set(row.expectedIds);
        const isTemporal = row.shape === "temporal";
        const expectedRefuse = !isTemporal && relevant.size === 0
          && (row.expectedFilter === null || row.expectedFilter === undefined);

        const [duration, res] = yield* Effect.timed(
          generateJson(
            apiKey,
            model,
            BASELINE_SYSTEM,
            buildUserPrompt(row.question, index),
            RESPONSE_SCHEMA as never,
          ).pipe(
            Effect.map((r) => ({
              answer: parseBaselineAnswer(r.text),
              inputTokens: r.inputTokens,
              outputTokens: r.outputTokens,
            })),
            // A provider fault scores the item as an empty refusal rather than sinking the run.
            Effect.catchTag("GeminiBatchError", () =>
              Effect.succeed({
                answer: { courseIds: [] as ReadonlyArray<string>, refuse: true },
                inputTokens: null as number | null,
                outputTokens: null as number | null,
              })),
          ),
        );

        const scoredRetrieval = !isTemporal && relevant.size > 0;
        return {
          shape: row.shape,
          ndcg10: scoredRetrieval ? ndcgAt(res.answer.courseIds, relevant, 10) : null,
          refused: res.answer.refuse,
          expectedRefuse,
          isTemporal,
          latencyMs: Math.round(Duration.toMillis(duration)),
          inputTokens: res.inputTokens,
          outputTokens: res.outputTokens,
        };
      }), { concurrency });

    const lookup = scored.filter((s) => s.shape === "lookup").map((s) => s.ndcg10).filter((
      x,
    ): x is number => x !== null);
    const filtered = scored.filter((s) => s.shape === "filtered").map((s) => s.ndcg10).filter((
      x,
    ): x is number => x !== null);
    const refusalSlice = scored.filter((s) => s.expectedRefuse);
    const inTok = scored.map((s) => s.inputTokens).filter((x): x is number => x !== null);
    const outTok = scored.map((s) => s.outputTokens).filter((x): x is number => x !== null);

    return {
      label: "baseline: compact index (~54k tok, cached)",
      model,
      indexLines: listings.length,
      indexTokens,
      ndcgLookup: meanOrNull(lookup),
      ndcgFiltered: meanOrNull(filtered),
      refusalPct: pctTrue(refusalSlice.map((s) => s.refused)),
      p95Ms: percentile(scored.map((s) => s.latencyMs), 0.95),
      avgInputTokens: meanOrNull(inTok),
      avgOutputTokens: meanOrNull(outTok),
      wholeCatalogTokens,
      itemCount: items.length,
    } satisfies BaselineResult;
  }).pipe(Effect.orDie);
