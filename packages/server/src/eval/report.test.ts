import { describe, expect, it } from "@effect/vitest";
import type { Shape } from "./golden-set.js";
import { summarize } from "./report.js";
import type { ItemResult } from "./runner.js";

// Pure tests for the §11.2 aggregation: filter_exact over items with a filter target,
// refusal accuracy over the refusal slice (with a false-refusal counted separately), and
// the fee_x100 near-miss surfaced from the diffs.

const item = (over: Partial<ItemResult>): ItemResult => ({
  itemId: "1",
  question: "q",
  shape: "filtered" as Shape,
  band: null,
  expectedRefuse: false,
  filterExact: null,
  ndcg10: null,
  recallAt10: null,
  mrr: null,
  refused: false,
  latencyMs: 100,
  diffs: [],
  ...over,
});

describe("summarize", () => {
  it("computes filter_exact only over items with a filter target", () => {
    const s = summarize([
      item({ filterExact: true }),
      item({ filterExact: true }),
      item({ filterExact: false }),
      item({ shape: "unanswerable", expectedRefuse: true, refused: true, filterExact: null }),
    ]);
    // 2 of 3 with a target → 66.7%; the refusal item is excluded from the denominator
    expect(s.filterExact.n).toBe(3);
    expect(s.filterExact.pct).toBeCloseTo(66.667, 1);
  });

  it("scores refusal accuracy over the refusal slice and counts false refusals", () => {
    const s = summarize([
      item({ shape: "unanswerable", expectedRefuse: true, refused: true }),
      item({ shape: "temporal", expectedRefuse: true, refused: false }), // missed refusal
      item({ shape: "lookup", expectedRefuse: false, refused: true, filterExact: false }), // false refusal
    ]);
    expect(s.refusal.sliceN).toBe(2);
    expect(s.refusal.accuracyPct).toBeCloseTo(50);
    expect(s.refusal.falseRefusals).toBe(1);
  });

  it("surfaces the fee off-by-100 from the diffs", () => {
    const s = summarize([
      item({
        filterExact: false,
        diffs: [{ field: "maxFeeCents", actual: 2000, expected: 200000, kind: "fee_x100" }],
      }),
    ]);
    expect(s.feeX100).toBe(1);
    expect(s.fieldMiss).toEqual([["maxFeeCents", 1]]);
  });

  it("reports the gate snapshot in percentage points", () => {
    const s = summarize([item({ filterExact: true, ndcg10: 0.9 })]);
    expect(s.snapshot.filterExactPct).toBe(100);
    expect(s.snapshot.ndcg10Pct).toBeCloseTo(90);
  });
});
