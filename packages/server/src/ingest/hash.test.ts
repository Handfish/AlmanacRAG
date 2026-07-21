import { describe, expect, it } from "@effect/vitest";
import { contentHashOf, hashSegment, normalizeForHash, sha256Hex } from "./hash.js";

describe("hash", () => {
  it("sha256Hex is 64 lowercase hex chars and stable", () => {
    const h = sha256Hex("hello");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("hello")).toBe(h);
  });

  it("normalizeForHash collapses whitespace but preserves case", () => {
    expect(normalizeForHash("  a\n\t b   c ")).toBe("a b c");
    expect(normalizeForHash("Open")).not.toBe(normalizeForHash("open"));
  });

  it("hashSegment ignores reflow, tracks real edits", () => {
    expect(hashSegment("Status: Open")).toBe(hashSegment("Status:   Open  \n"));
    expect(hashSegment("Status: Open")).not.toBe(hashSegment("Status: Full"));
  });

  it("contentHashOf keys distinct content distinctly", () => {
    expect(contentHashOf("page-a")).toBe(contentHashOf("page-a"));
    expect(contentHashOf("page-a")).not.toBe(contentHashOf("page-b"));
  });
});
