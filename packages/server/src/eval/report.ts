import type { MetricSnapshot } from "./gate.js";
import type { Shape } from "./golden-set.js";
import { meanOrNull } from "./metrics.js";
import type { ItemResult } from "./runner.js";

// Turns scored items into the §11.2/§11.5 report: `filter_exact` FIRST (the headline),
// then per-shape retrieval (a single aggregate hides the finding — §11.5), the refusal
// axis over the `unanswerable`+`temporal` slices, per-field near-misses (the silent
// `fee_x100`), and operational latency. Pure — no DB, no Effect — so `summarize` unit-tests.

const SHAPES: ReadonlyArray<Shape> = [
  "lookup",
  "filtered",
  "availability",
  "comparative",
  "eligibility",
  "temporal",
  "unanswerable",
];

export interface ShapeAgg {
  readonly shape: Shape;
  readonly n: number;
  readonly filterExactPct: number | null;
  readonly ndcg10: number | null;
  readonly recallAt10: number | null;
  readonly mrr: number | null;
}

export interface Summary {
  readonly snapshot: MetricSnapshot; // the two gated headlines (§11.4)
  readonly filterExact: { readonly n: number; readonly pct: number; };
  readonly ndcg10: number | null;
  readonly recallAt10: number | null;
  readonly mrr: number | null;
  readonly byShape: ReadonlyArray<ShapeAgg>;
  readonly refusal: {
    readonly sliceN: number;
    readonly accuracyPct: number | null;
    readonly falseRefusals: number;
  };
  readonly latency: { readonly p50: number; readonly p95: number; };
  readonly feeX100: number;
  readonly fieldMiss: ReadonlyArray<readonly [string, number]>;
  // §11.2 prose faithfulness — null when the prose pass didn't run (EVAL_PROSE off).
  readonly proseFaithful: { readonly n: number; readonly pct: number | null; };
}

const pctTrue = (xs: ReadonlyArray<boolean>): number | null =>
  xs.length === 0 ? null : (100 * xs.filter((x) => x).length) / xs.length;

const percentile = (xs: ReadonlyArray<number>, p: number): number => {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
};

export const summarize = (results: ReadonlyArray<ItemResult>): Summary => {
  const feFlags = results.filter((r) => r.filterExact !== null).map((r) => r.filterExact!);
  const filterExactPct = pctTrue(feFlags) ?? 0;

  const ndcgs = results.map((r) => r.ndcg10).filter((x): x is number => x !== null);
  const recalls = results.map((r) => r.recallAt10).filter((x): x is number => x !== null);
  const rrs = results.map((r) => r.mrr).filter((x): x is number => x !== null);
  const ndcg10 = meanOrNull(ndcgs);

  const byShape = SHAPES.map((shape): ShapeAgg => {
    const rows = results.filter((r) => r.shape === shape);
    const fe = rows.filter((r) => r.filterExact !== null).map((r) => r.filterExact!);
    return {
      shape,
      n: rows.length,
      filterExactPct: pctTrue(fe),
      ndcg10: meanOrNull(rows.map((r) => r.ndcg10).filter((x): x is number => x !== null)),
      recallAt10: meanOrNull(rows.map((r) => r.recallAt10).filter((x): x is number => x !== null)),
      mrr: meanOrNull(rows.map((r) => r.mrr).filter((x): x is number => x !== null)),
    };
  }).filter((a) => a.n > 0);

  // Refusal (§11.2): accuracy on the shapes whose correct answer is "I can't tell you"
  // (unanswerable + temporal → expectedRefuse), plus false refusals on answerable items.
  const refusalSlice = results.filter((r) => r.expectedRefuse);
  const falseRefusals = results.filter((r) => !r.expectedRefuse && r.refused).length;

  // Per-field near-misses (§11.2), aggregated; fee_x100 gets its own headline count.
  const fieldCounts = new Map<string, number>();
  let feeX100 = 0;
  for (const r of results) {
    for (const d of r.diffs) {
      fieldCounts.set(d.field, (fieldCounts.get(d.field) ?? 0) + 1);
      if (d.kind === "fee_x100") feeX100 += 1;
    }
  }
  const fieldMiss = [...fieldCounts.entries()].sort((a, b) => b[1] - a[1]);

  const latencies = results.map((r) => r.latencyMs);

  const proseFlags = results
    .map((r) => r.proseFaithful)
    .filter((x): x is boolean => x !== null);

  return {
    snapshot: { filterExactPct, ndcg10Pct: (ndcg10 ?? 0) * 100 },
    filterExact: { n: feFlags.length, pct: filterExactPct },
    ndcg10,
    recallAt10: meanOrNull(recalls),
    mrr: meanOrNull(rrs),
    byShape,
    refusal: {
      sliceN: refusalSlice.length,
      accuracyPct: pctTrue(refusalSlice.map((r) => r.refused)),
      falseRefusals,
    },
    latency: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    feeX100,
    fieldMiss,
    proseFaithful: { n: proseFlags.length, pct: pctTrue(proseFlags) },
  };
};

const pct = (x: number | null): string => (x === null ? "  —  " : `${x.toFixed(1)}%`);
const f2 = (x: number | null): string => (x === null ? " — " : x.toFixed(3));

export const formatReport = (s: Summary, meta: { runId: string; gitSha: string; }): string => {
  const lines: Array<string> = [];
  lines.push(`\n═══ Eval run #${meta.runId} @ ${meta.gitSha.slice(0, 8)} ═══\n`);

  // Headline first (§11.2).
  lines.push(
    `filter_exact  ${pct(s.filterExact.pct)}  (${s.filterExact.n} items with a filter target)`,
  );
  lines.push(
    `nDCG@10       ${f2(s.ndcg10)}     recall@10 ${f2(s.recallAt10)}     MRR ${f2(s.mrr)}`,
  );
  lines.push("");

  // Per-shape (§11.5).
  lines.push("By shape:");
  lines.push("  shape          n   filter_exact   nDCG@10   recall@10   MRR");
  for (const a of s.byShape) {
    lines.push(
      `  ${a.shape.padEnd(13)} ${String(a.n).padStart(2)}   ${
        pct(a.filterExactPct).padStart(8)
      }     `
        + `${f2(a.ndcg10).padStart(5)}     ${f2(a.recallAt10).padStart(5)}     ${
          f2(a.mrr).padStart(5)
        }`,
    );
  }
  lines.push("");

  // Refusal + near-misses + latency.
  lines.push(
    `Refusal (unanswerable+temporal, n=${s.refusal.sliceN}): `
      + `${
        pct(s.refusal.accuracyPct)
      } correct · ${s.refusal.falseRefusals} false refusal(s) on answerable items`,
  );
  lines.push(
    `Per-field misses: ${
      s.fieldMiss.length === 0 ? "none" : s.fieldMiss.map(([f, n]) => `${f}×${n}`).join(", ")
    }`,
  );
  lines.push(`  ⚠ fee off-by-100 (silent & catastrophic, §11.2): ${s.feeX100}`);
  lines.push(
    s.proseFaithful.n === 0
      ? "prose_faithful: — (run with EVAL_PROSE=1 to score the answer agent, §11.2)"
      : `prose_faithful: ${
        pct(s.proseFaithful.pct)
      }  (${s.proseFaithful.n} answered items, LlmJudge)`,
  );
  lines.push(
    `Latency: p50 ${s.latency.p50}ms · p95 ${s.latency.p95}ms   (cost/query: n/a — Phase 5 §12)`,
  );
  return lines.join("\n");
};
