import { describe, expect, it } from "@effect/vitest";
import { gate } from "./gate.js";

// Pure tests for the §11.4 CI gate. Within tolerance passes (noise is not a regression);
// a drop beyond 2 points on either headline fails and names the offender; an improvement
// always passes.

describe("gate", () => {
  const base = { filterExactPct: 80, ndcg10Pct: 75 };

  it("passes when both metrics are within tolerance", () => {
    expect(gate({ filterExactPct: 79, ndcg10Pct: 74 }, base)).toEqual({
      passed: true,
      regressions: [],
    });
  });

  it("fails and names filter_exact when it drops more than 2 points", () => {
    const r = gate({ filterExactPct: 77, ndcg10Pct: 75 }, base);
    expect(r.passed).toBe(false);
    expect(r.regressions).toHaveLength(1);
    expect(r.regressions[0]).toContain("filter_exact");
  });

  it("fails on an nDCG regression", () => {
    const r = gate({ filterExactPct: 80, ndcg10Pct: 72 }, base);
    expect(r.passed).toBe(false);
    expect(r.regressions[0]).toContain("nDCG@10");
  });

  it("reports both regressions at once", () => {
    expect(gate({ filterExactPct: 70, ndcg10Pct: 60 }, base).regressions).toHaveLength(2);
  });

  it("passes on improvement", () => {
    expect(gate({ filterExactPct: 90, ndcg10Pct: 85 }, base).passed).toBe(true);
  });
});
