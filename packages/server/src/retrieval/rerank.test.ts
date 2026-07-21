import { describe, expect, it } from "@effect/vitest";
import { identityScores, reorderByScores } from "./rerank.js";

// Pure tests for the reranking utilities (§11.6). The load-bearing property is that identity
// scores are a TRUE no-op reordering (the degrade-to-identity guarantee, §14) and that the
// sort is STABLE on ties, so equal scores keep their fusion order.

describe("identityScores", () => {
  it("descends so index 0 is highest (preserves order under a desc sort)", () => {
    expect(identityScores(3)).toEqual([3, 2, 1]);
  });
  it("is empty for 0", () => {
    expect(identityScores(0)).toEqual([]);
  });
});

describe("reorderByScores", () => {
  it("is a no-op under identity scores", () => {
    const items = ["a", "b", "c", "d"];
    expect(reorderByScores(items, identityScores(items.length))).toEqual(items);
  });

  it("reorders highest score first", () => {
    expect(reorderByScores(["a", "b", "c"], [0.1, 0.9, 0.5])).toEqual(["b", "c", "a"]);
  });

  it("is stable on ties — equal scores keep input order", () => {
    expect(reorderByScores(["a", "b", "c", "d"], [1, 1, 1, 1])).toEqual(["a", "b", "c", "d"]);
  });

  it("sends a missing score (short array) to the back", () => {
    // "c" has no score → NEGATIVE_INFINITY → last, "a"/"b" ordered by score.
    expect(reorderByScores(["a", "b", "c"], [0.2, 0.8])).toEqual(["b", "a", "c"]);
  });
});
