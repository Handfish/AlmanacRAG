import type { CourseHistory, TermRun } from "@catalog/domain/history";
import type { CourseId } from "@catalog/domain/ids";
import { describe, expect, it } from "@effect/vitest";
import { composeHistory } from "./format-history.js";

// The §10.6 honesty logic as a pure function — the deliverable at the centre of Phase 7.
// Both branches: with ≥2 observed terms it reports what it saw (grounded); with ≤1 it says
// "I don't know yet" (insufficient) and never implies a schedule. `not_found` when the
// course couldn't be resolved. Every fact is derived from the structure — nothing invented.

const term = (
  season: TermRun["season"],
  year: number,
  fee: number | null,
  stillListed = false,
): TermRun => ({
  term: season !== null && year !== null ? `${season} ${year}` : "undated",
  season,
  year,
  rank: (year ?? 0) * 10 + 4,
  sections: 1,
  minFeeCents: fee,
  maxFeeCents: fee,
  statuses: ["closed"],
  stillListed,
});

const hist = (
  termsSeen: number,
  terms: ReadonlyArray<TermRun>,
  since = "2024-09-05",
): CourseHistory => ({
  courseId: "1" as CourseId,
  courseTitle: "PMP Certification Program",
  terms,
  changes: [],
  termsSeen,
  window: { observingSince: since, termsObserved: terms.length },
});

describe("composeHistory", () => {
  it("not_found: no history for a course that couldn't be resolved", () => {
    const a = composeHistory(null, "underwater basket weaving");
    expect(a.verdict).toBe("not_found");
    expect(a.prose).toContain("underwater basket weaving");
  });

  it("insufficient: a single live term → 'I've only seen it once', bounded by the window", () => {
    const a = composeHistory(hist(1, [term("Fall", 2026, 45000, true)]), "PMP");
    expect(a.verdict).toBe("insufficient");
    expect(a.prose).toMatch(/only seen the PMP Certification Program once/i);
    expect(a.prose).toContain("Fall 2026");
    expect(a.prose).toContain("September 2024"); // observingSince, humanized
    // never asserts a recurrence
    expect(a.prose).not.toMatch(/every (year|fall|summer)/i);
  });

  it("insufficient: a single term now GONE → 'last seen …, hasn't appeared since'", () => {
    const a = composeHistory(hist(1, [term("Fall", 2023, 39500, false)]), "PMP");
    expect(a.verdict).toBe("insufficient");
    expect(a.prose).toMatch(/hasn't appeared since/i);
    expect(a.prose).toContain("Fall 2023");
  });

  it("insufficient: no dated term at all → can't place it on the calendar", () => {
    const a = composeHistory(hist(0, [term(null, 0 as unknown as number, 39500)]), "PMP");
    expect(a.verdict).toBe("insufficient");
    expect(a.prose).toMatch(/don't have a dated term/i);
  });

  it("grounded: ≥2 terms with a rising fee → reports terms + trajectory, hedged to the window", () => {
    const a = composeHistory(
      hist(3, [
        term("Fall", 2024, 39500),
        term("Fall", 2025, 41500),
        term("Fall", 2026, 45000, true),
      ]),
      "PMP",
    );
    expect(a.verdict).toBe("grounded");
    expect(a.prose).toContain("3 terms");
    expect(a.prose).toMatch(/Fall 2024, Fall 2025, and Fall 2026/);
    expect(a.prose).toMatch(/risen from \$395 in Fall 2024 to \$450 in Fall 2026/);
    expect(a.prose).toMatch(/currently listed for Fall 2026/);
    expect(a.prose).toContain("since September 2024"); // the window bound
    // still no absolute recurrence claim
    expect(a.prose).not.toMatch(/every (year|fall)/i);
  });

  it("grounded: a steady fee reads 'held steady'; a course no longer listed says so", () => {
    const a = composeHistory(
      hist(2, [term("Summer", 2025, 20000), term("Summer", 2026, 20000, false)]),
      "PMP",
    );
    expect(a.verdict).toBe("grounded");
    expect(a.prose).toMatch(/held steady at \$200/);
    expect(a.prose).toMatch(/isn't currently listed/);
  });
});
