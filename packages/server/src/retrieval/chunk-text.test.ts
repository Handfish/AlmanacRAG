import { describe, expect, it } from "@effect/vitest";
import { buildChunkText, type CourseChunkSource, estimateTokens } from "./chunk-text.js";

// Pure tests for the chunk-text builder (§5.4): the embeddable surface is the course's
// prose, not per-listing facts, and absent fields simply drop out.

const base: CourseChunkSource = {
  courseTitle: "Grant Writing for Nonprofits",
  subject: null,
  track: null,
  program: null,
  audience: null,
  description: null,
  prerequisiteText: null,
  contactHours: null,
};

describe("buildChunkText", () => {
  it("title-only course yields just the title", () => {
    expect(buildChunkText(base)).toBe("Grant Writing for Nonprofits");
  });

  it("folds subject/program/hours into a single meta line and appends prose", () => {
    const text = buildChunkText({
      ...base,
      subject: "Fundraising",
      program: "Nonprofit Management",
      contactHours: 12,
      description: "Learn to write competitive grant proposals.",
      audience: "Development staff",
      prerequisiteText: "Basic writing skills",
    });
    expect(text).toContain("Grant Writing for Nonprofits");
    expect(text).toContain(
      "Subject: Fundraising · Program: Nonprofit Management · Contact hours: 12",
    );
    expect(text).toContain("Learn to write competitive grant proposals.");
    expect(text).toContain("Audience: Development staff");
    expect(text).toContain("Prerequisites: Basic writing skills");
  });

  it("omits the meta line entirely when no meta fields are present", () => {
    const text = buildChunkText({ ...base, description: "A course." });
    expect(text).toBe("Grant Writing for Nonprofits\nA course.");
  });

  it("estimateTokens is ~chars/4 and clamped to the smallint column", () => {
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(40))).toBe(10);
    expect(estimateTokens("a".repeat(1_000_000))).toBe(32767);
  });
});
