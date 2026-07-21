import { describe, expect, it } from "@effect/vitest";
import { parseRerankResponse } from "./reranker-bge.js";

// Pure tests for the §11.6 bge `/rerank` response parser — the alignment layer between TEI's
// score-sorted `[{index, score}]` and the port's contract (one score per INPUT document, by
// index). The failure modes that matter: a partial response (some docs omitted) and an
// unrecognized shape (→ null, so the adapter degrades to identity rather than mis-ranking).

describe("parseRerankResponse", () => {
  it("aligns a bare [{index, score}] array back to input order", () => {
    const scores = parseRerankResponse([{ index: 2, score: 0.9 }, { index: 0, score: 0.3 }], 3);
    expect(scores).not.toBeNull();
    expect(scores![0]).toBe(0.3);
    expect(scores![2]).toBe(0.9);
    expect(scores![1]).toBe(Number.NEGATIVE_INFINITY); // omitted → sorts last
  });

  it("accepts a {results:[…]} envelope and relevance_score", () => {
    const scores = parseRerankResponse({ results: [{ index: 0, relevance_score: 0.5 }] }, 1);
    expect(scores).toEqual([0.5]);
  });

  it("ignores out-of-range indices", () => {
    expect(parseRerankResponse([{ index: 9, score: 1 }], 2)).toBeNull(); // no in-range match
  });

  it("returns null for an unrecognized shape (→ identity fallback)", () => {
    expect(parseRerankResponse({ nope: true }, 3)).toBeNull();
    expect(parseRerankResponse("garbage", 3)).toBeNull();
  });
});
