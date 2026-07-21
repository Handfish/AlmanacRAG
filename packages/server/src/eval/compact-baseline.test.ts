import { describe, expect, it } from "@effect/vitest";
import { compactLine, parseBaselineAnswer, roughTokens } from "./compact-baseline.js";

// Pure tests for the compact-index baseline (§1.1) building blocks: the ~50-token line, the
// uncapped token estimate (the whole-catalog figure must NOT clip at smallint), and the
// tolerant answer parser (a malformed pick reads as an empty refusal, never a throw).

const listing = {
  courseId: "42",
  courseTitle: "Grant Writing",
  campus: "Newark",
  deliveryMode: "online_async",
  status: "Registration Available",
  term: "Fall 2026",
  totalFeeCents: 149900,
  contactHours: 12,
  isEvening: true,
};

describe("compactLine", () => {
  it("tags the course_id and renders fee in dollars", () => {
    const line = compactLine(listing);
    expect(line.startsWith("[42] Grant Writing")).toBe(true);
    expect(line).toContain("$1499");
    expect(line).toContain("12h");
    expect(line).toContain("eve");
  });

  it("omits missing fields rather than printing null", () => {
    const line = compactLine({
      ...listing,
      totalFeeCents: null,
      contactHours: null,
      isEvening: null,
    });
    expect(line).not.toContain("$");
    expect(line).not.toContain("null");
    expect(line).not.toContain("eve");
  });
});

describe("roughTokens", () => {
  it("is char/4 and NOT clipped to smallint (the ~870k catalog figure)", () => {
    expect(roughTokens("abcd")).toBe(1);
    expect(roughTokens("x".repeat(4_000_000))).toBe(1_000_000); // would clip at 32767 if capped
  });
});

describe("parseBaselineAnswer", () => {
  it("keeps numeric course ids and reads refuse", () => {
    expect(parseBaselineAnswer(`{"courseIds":["1","2","x"],"refuse":false}`)).toEqual({
      courseIds: ["1", "2"],
      refuse: false,
    });
  });

  it("treats null / bad JSON as an empty refusal", () => {
    expect(parseBaselineAnswer(null)).toEqual({ courseIds: [], refuse: true });
    expect(parseBaselineAnswer("not json")).toEqual({ courseIds: [], refuse: true });
  });
});
