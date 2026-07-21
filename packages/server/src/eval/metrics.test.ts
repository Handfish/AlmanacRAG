import { describe, expect, it } from "@effect/vitest";
import { meanOrNull, mrr, ndcgAt, recallAt } from "./metrics.js";

// Pure tests for the §11.2 retrieval metrics. Binary relevance over a ranked course-id
// list; the interesting cases are rank sensitivity (nDCG), the empty-relevant guard
// (refusal items score NULL, not 0/0), and MRR picking the FIRST hit.

const set = (...ids: Array<string>) => new Set(ids);

describe("ndcgAt", () => {
  it("is 1 when every relevant doc is ranked first", () => {
    expect(ndcgAt(["a", "b", "c"], set("a", "b"), 10)).toBeCloseTo(1);
  });

  it("rewards a higher rank for the same hit", () => {
    const early = ndcgAt(["a", "x", "y"], set("a"), 10); // hit at rank 1
    const late = ndcgAt(["x", "y", "a"], set("a"), 10); // hit at rank 3
    expect(early).toBeGreaterThan(late);
    expect(early).toBeCloseTo(1); // single relevant, ranked first → ideal
    expect(late).toBeCloseTo(1 / (Math.log(4) / Math.log(2))); // 1/log2(4) = 0.5
  });

  it("respects the cutoff k — a hit past k contributes nothing", () => {
    expect(ndcgAt(["x", "y", "z", "a"], set("a"), 3)).toBe(0);
  });

  it("is 0 for an empty relevant set (refusal item)", () => {
    expect(ndcgAt(["a", "b"], set(), 10)).toBe(0);
  });
});

describe("recallAt", () => {
  it("counts the fraction of relevant found in the top k", () => {
    expect(recallAt(["a", "z", "b"], set("a", "b", "c"), 10)).toBeCloseTo(2 / 3);
  });
  it("honours the cutoff", () => {
    expect(recallAt(["a", "z", "b"], set("a", "b"), 1)).toBeCloseTo(1 / 2);
  });
  it("is 0 for an empty relevant set", () => {
    expect(recallAt(["a"], set(), 10)).toBe(0);
  });
});

describe("mrr", () => {
  it("is the reciprocal rank of the first relevant hit", () => {
    expect(mrr(["x", "y", "a", "b"], set("a", "b"))).toBeCloseTo(1 / 3);
  });
  it("is 0 when nothing relevant is retrieved", () => {
    expect(mrr(["x", "y"], set("a"))).toBe(0);
  });
});

describe("meanOrNull", () => {
  it("averages a non-empty list", () => {
    expect(meanOrNull([1, 2, 3])).toBe(2);
  });
  it("is null for an empty slice", () => {
    expect(meanOrNull([])).toBeNull();
  });
});
