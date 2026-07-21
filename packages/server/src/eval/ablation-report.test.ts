import { describe, expect, it } from "@effect/vitest";
import { estimateCostUsd, formatAblationTable } from "./ablation-report.js";
import type { AblationRow } from "./ablation.js";

// Pure tests for the §11.5 table renderer. The load-bearing rendering rules: filter routing
// off ⇒ filter_exact is "—" (not 0%), Memory reflects the history knob, and the two baseline
// rows (compact index + "does not fit") are appended.

const row = (over: Partial<AblationRow>): AblationRow => ({
  key: "k",
  label: "row",
  filterRouting: false,
  filterExactPct: null,
  ndcgLookup: 0.8,
  ndcgFiltered: 0.3,
  refusalPct: null,
  memory: false,
  p95Ms: 12,
  n: 87,
  ...over,
});

describe("estimateCostUsd", () => {
  it("prices input + output at flash-lite rates", () => {
    expect(estimateCostUsd(1_000_000, 0)).toBeCloseTo(0.1);
    expect(estimateCostUsd(0, 1_000_000)).toBeCloseTo(0.4);
  });
});

describe("formatAblationTable", () => {
  it("renders '—' for filter_exact when routing is off, a % when on", () => {
    const md = formatAblationTable({
      rows: [
        row({ label: "vec", filterRouting: false, filterExactPct: null }),
        row({ label: "filter", filterRouting: true, filterExactPct: 100, refusalPct: 100 }),
      ],
      baseline: null,
      crossover: null,
      freshMaxHours: 3,
      itemCount: 87,
      gitSha: "abc1234",
    });
    expect(md).toContain("| vec | — |");
    expect(md).toContain("| filter | 100% |");
    expect(md).toContain("✓ ≤3h");
  });

  it("appends the compact-index and does-not-fit baseline rows", () => {
    const md = formatAblationTable({
      rows: [row({})],
      baseline: {
        label: "baseline: compact index (~54k tok, cached)",
        model: "gemini-3.1-flash-lite",
        indexLines: 993,
        indexTokens: 54000,
        ndcgLookup: 0.85,
        ndcgFiltered: 0.4,
        refusalPct: 50,
        p95Ms: 900,
        avgInputTokens: 54000,
        avgOutputTokens: 40,
        wholeCatalogTokens: 870000,
        itemCount: 87,
      },
      crossover: null,
      freshMaxHours: null,
      itemCount: 87,
      gitSha: "abc1234",
    });
    expect(md).toContain("compact index");
    expect(md).toContain("✗ impossible");
    expect(md).toContain("does not fit — ~870k tok");
  });
});
