// The CI gate (architecture.md §11.4): "A PR that drops `filter_exact` or nDCG@10 by
// more than 2 points against `main` fails. Retrieval quality becomes a build artifact."
// Pure comparison so it unit-tests with no DB. Both metrics are expressed in PERCENTAGE
// POINTS (filter_exact as a percent, nDCG@10 ×100) so "2 points" means the same on each.
// The baseline is a committed snapshot (`eval/baseline.json`) refreshed from a green
// main run; the runner passes the just-finished run's headline numbers as `current`.

export interface MetricSnapshot {
  /** filter_exact as a percentage of items with a labelled filter, 0..100. */
  readonly filterExactPct: number;
  /** mean nDCG@10 over items with a relevant set, ×100 → 0..100. */
  readonly ndcg10Pct: number;
}

export interface GateResult {
  readonly passed: boolean;
  readonly regressions: ReadonlyArray<string>;
}

export const DEFAULT_TOLERANCE = 2;

export const gate = (
  current: MetricSnapshot,
  baseline: MetricSnapshot,
  tolerance: number = DEFAULT_TOLERANCE,
): GateResult => {
  const regressions: Array<string> = [];
  const check = (name: string, cur: number, base: number) => {
    if (cur < base - tolerance) {
      regressions.push(
        `${name}: ${cur.toFixed(1)} < baseline ${base.toFixed(1)} − ${tolerance} tolerance`,
      );
    }
  };
  check("filter_exact", current.filterExactPct, baseline.filterExactPct);
  check("nDCG@10", current.ndcg10Pct, baseline.ndcg10Pct);
  return { passed: regressions.length === 0, regressions };
};
