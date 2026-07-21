import { describe, expect, it } from "@effect/vitest";
import { parseDateRange, parseStartEnd } from "./dates.js";

// The ported chrono-node parser (reference-scraper). Assertions pin UTC
// components with a zero offset so they don't drift with the runner's timezone.
const opts = { timezoneOffsetMinutes: 0, referenceDate: new Date("2026-01-01T00:00:00Z") };

describe("dates", () => {
  it("parses a single date (start === end day)", () => {
    const r = parseDateRange("Thursday, October 29, 2026", opts);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.start.getUTCFullYear()).toBe(2026);
      expect(r.start.getUTCMonth()).toBe(9); // October
      expect(r.start.getUTCDate()).toBe(29);
      expect(r.end.getUTCDate()).toBe(29);
    }
  });

  it("parses a hyphen range", () => {
    const r = parseDateRange("7/20/2026 - 8/03/2026", opts);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.start.getUTCMonth()).toBe(6); // July
      expect(r.start.getUTCDate()).toBe(20);
      expect(r.end.getUTCMonth()).toBe(7); // August
      expect(r.end.getUTCDate()).toBe(3);
    }
  });

  it("parses an ampersand enumeration, borrowing the stated year for both ends", () => {
    const r = parseDateRange("October 17 & 18, 2024", opts);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.start.getUTCFullYear()).toBe(2024);
      expect(r.start.getUTCDate()).toBe(17);
      expect(r.end.getUTCFullYear()).toBe(2024);
      expect(r.end.getUTCDate()).toBe(18);
    }
  });

  it("classifies non-dates as typed failures, not the epoch", () => {
    expect(parseDateRange("", opts)).toMatchObject({ ok: false, reason: "empty" });
    expect(parseDateRange("TBD", opts)).toMatchObject({ ok: false, reason: "tbd" });
    expect(parseDateRange("Cancelled", opts)).toMatchObject({ ok: false, reason: "cancelled" });
    expect(parseDateRange("no date here", opts)).toMatchObject({
      ok: false,
      reason: "unparseable",
    });
  });

  it("parseStartEnd joins two cells into one range", () => {
    const r = parseStartEnd("7/20/2026", "8/03/2026", opts);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.start.getUTCDate()).toBe(20);
      expect(r.end.getUTCDate()).toBe(3);
    }
  });
});
