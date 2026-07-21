import { describe, expect, it } from "@effect/vitest";
import { findHnswCrossover, type SizeResult } from "./crossover.js";

// Pure test for the ADR-004 crossover detector — the "size at which exact stops winning".
// Synthetic latency rows, so no DB. The expected production result is "none in range" (exact
// wins everywhere at these sizes); the detector must also FIND the crossover when it exists.

const size = (n: number, exact: number, hnsw: number): SizeResult => ({
  n,
  dims: 1536,
  methods: [
    {
      method: "exact",
      available: true,
      buildMs: null,
      medianQueryMs: exact,
      recallAt10: 1,
      note: null,
    },
    {
      method: "hnsw",
      available: true,
      buildMs: 5,
      medianQueryMs: hnsw,
      recallAt10: 0.98,
      note: null,
    },
    {
      method: "diskann",
      available: false,
      buildMs: null,
      medianQueryMs: null,
      recallAt10: null,
      note: "unavailable",
    },
  ],
});

describe("findHnswCrossover", () => {
  it("is null when exact wins across the whole range (the ADR-004 result)", () => {
    expect(findHnswCrossover([size(1000, 0.4, 2.1), size(100000, 3.0, 4.0)])).toBeNull();
  });

  it("returns the smallest N where HNSW dips below exact", () => {
    const sizes = [size(1000, 0.4, 2.0), size(100000, 5.0, 4.0), size(1000000, 40, 5)];
    expect(findHnswCrossover(sizes)).toBe(100000);
  });

  it("scans in ascending N regardless of input order", () => {
    const sizes = [size(1000000, 40, 5), size(1000, 0.4, 2.0), size(100000, 5.0, 4.0)];
    expect(findHnswCrossover(sizes)).toBe(100000);
  });
});
