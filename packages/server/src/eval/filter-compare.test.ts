import { ListingFilter } from "@catalog/domain/filter";
import { describe, expect, it } from "@effect/vitest";
import { canonicalFilter, fieldDiffs, filterExact } from "./filter-compare.js";

// Pure tests for `filter_exact` (§11.2). The load-bearing cases: null vs empty are
// distinct; key order and Date/ISO representation don't matter; and the off-by-100 fee
// miss is caught and labelled as its own diff kind (the "silent and catastrophic" one).

describe("canonicalFilter", () => {
  it("null (pure lookup) and empty filter are distinct canonical forms", () => {
    expect(canonicalFilter(null)).toBe("");
    expect(canonicalFilter(new ListingFilter({}))).toBe("{}");
  });

  it("is insensitive to key order", () => {
    const a = new ListingFilter({ campus: "Newark", maxFeeCents: 200000 });
    const b = new ListingFilter({ maxFeeCents: 200000, campus: "Newark" });
    expect(canonicalFilter(a)).toBe(canonicalFilter(b));
  });

  it("normalises a Date to its ISO wire form", () => {
    const viaDate = new ListingFilter({ startsBefore: new Date("2026-09-01") });
    expect(canonicalFilter(viaDate)).toContain("2026-09-01");
  });
});

describe("filterExact", () => {
  it("matches identical filters regardless of construction order", () => {
    const expected = new ListingFilter({ status: "open", campus: "Newark" });
    const actual = new ListingFilter({ campus: "Newark", status: "open" });
    expect(filterExact(actual, expected)).toBe(true);
  });

  it("fails on the off-by-100 fee miss", () => {
    const expected = new ListingFilter({ maxFeeCents: 200000 }); // $2,000
    const actual = new ListingFilter({ maxFeeCents: 2000 }); // parsed as 2000 cents
    expect(filterExact(actual, expected)).toBe(false);
  });

  it("a pure-lookup expectation (null) fails when the router invents a filter", () => {
    expect(filterExact(new ListingFilter({ campus: "Online" }), null)).toBe(false);
  });
});

describe("fieldDiffs", () => {
  it("labels the fee off-by-100 as fee_x100", () => {
    const diffs = fieldDiffs(
      new ListingFilter({ maxFeeCents: 2000 }),
      new ListingFilter({ maxFeeCents: 200000 }),
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toMatchObject({ field: "maxFeeCents", kind: "fee_x100" });
  });

  it("flags a missing predicate (router under-read) and an extra one (over-filter)", () => {
    // expected campus=Newark + status=open; router set only deliveryMode
    const diffs = fieldDiffs(
      new ListingFilter({ deliveryMode: "online_async" }),
      new ListingFilter({ campus: "Newark", status: "open" }),
    );
    const byField = Object.fromEntries(diffs.map((d) => [d.field, d.kind]));
    expect(byField).toEqual({
      campus: "missing",
      status: "missing",
      deliveryMode: "extra",
    });
  });

  it("is empty for equal filters", () => {
    const f = new ListingFilter({ term: "Summer 2026" });
    expect(fieldDiffs(f, new ListingFilter({ term: "Summer 2026" }))).toHaveLength(0);
  });
});
