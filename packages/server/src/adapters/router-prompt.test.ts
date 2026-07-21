import { describe, expect, it } from "@effect/vitest";
import { decodeRoute } from "./router-prompt.js";

// Pure tests for `decodeRoute` (§8) — the boundary between a raw model response and the
// typed `RouteDecision`. The generation schema emits every field with an explicit null;
// decode must drop the nulls, keep the constraints, collapse an all-null filter to `null`
// (a pure lookup, not an empty filter), coerce fee floats to int cents, and honour refuse.

// A full response with every field present (nulls for the unconstrained ones).
const full = (over: Record<string, unknown>): Record<string, unknown> => ({
  refuse: false,
  searchQuery: null,
  campus: null,
  program: null,
  ceccUnit: null,
  term: null,
  startsBefore: null,
  startsAfter: null,
  maxFeeCents: null,
  minFeeCents: null,
  deliveryMode: null,
  isEvening: null,
  status: null,
  openForReg: null,
  minHours: null,
  maxHours: null,
  includeGone: null,
  ...over,
});

describe("decodeRoute", () => {
  it("drops null fields and keeps the real constraints", () => {
    const d = decodeRoute(
      full({ searchQuery: "cybersecurity", campus: "Newark", maxFeeCents: 200000 }),
    );
    expect(d.searchQuery).toBe("cybersecurity");
    expect(d.filter?.campus).toBe("Newark");
    expect(d.filter?.maxFeeCents).toBe(200000);
    expect(d.refuse).toBe(false);
  });

  it("collapses an all-null filter to null (pure lookup)", () => {
    const d = decodeRoute(full({ searchQuery: "how many hours is the PMP program" }));
    expect(d.filter).toBeNull();
    expect(d.searchQuery).toContain("PMP");
  });

  it("parses an ISO date into a Date filter field", () => {
    const d = decodeRoute(full({ startsBefore: "2026-09-01" }));
    expect(d.filter?.startsBefore).toBeInstanceOf(Date);
    expect(d.filter?.startsBefore?.toISOString()).toContain("2026-09-01");
  });

  it("rounds fee floats to integer cents", () => {
    const d = decodeRoute(full({ maxFeeCents: 200000.0, minFeeCents: 49999.6 }));
    expect(d.filter?.maxFeeCents).toBe(200000);
    expect(d.filter?.minFeeCents).toBe(50000);
  });

  it("a refusal nulls both the filter and the search query", () => {
    const d = decodeRoute(
      full({ refuse: true, searchQuery: "a PhD in astrophysics", campus: "Newark" }),
    );
    expect(d.refuse).toBe(true);
    expect(d.filter).toBeNull();
    expect(d.searchQuery).toBeNull();
  });

  it("degrades a malformed filter value to null rather than throwing", () => {
    const d = decodeRoute(full({ campus: "Mars", searchQuery: "geology" }));
    expect(d.filter).toBeNull(); // "Mars" is not a Campus → whole filter drops
    expect(d.searchQuery).toBe("geology"); // the soft half survives
  });
});
