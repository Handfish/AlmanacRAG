import * as chrono from "chrono-node";

// ── Ported verbatim from reference-scraper `src/dates.ts` (plan §4.1 / §5.3).
// The one tested chrono-node range parser worth keeping from the old crawler.
// Only cosmetic changes: double quotes and `node`-free imports for this repo's
// lint/format rules. Behaviour is unchanged.
//
// One place to turn messy, human-authored date text from any scraper into typed
// dates. Nothing downstream should call `new Date(someScrapedString)` directly —
// route it through here so parsing has a single, tested contract.
//
// The two rules that make this robust where the old per-scraper code was not:
//   1. Failure is a *value*, not a silent `new Date(0)` or an `Invalid Date`.
//      Callers must branch on `ok`, so an unparseable string can never
//      masquerade as the epoch.
//   2. chrono-node does the grammar. It already understands ranges
//      ("Oct 17 – Nov 3"), enumerations ("October 17 & 18, 2024"), bare "M/D",
//      weekday phrases, and time-of-day, so we stop reimplementing a date parser
//      with split()/indexOf().

export type UnparseableReason =
  | "empty"
  | "tbd"
  | "cancelled"
  | "unparseable";

export type ParsedRange =
  | { ok: true; start: Date; end: Date; raw: string; }
  | { ok: false; raw: string; reason: UnparseableReason; };

export interface ParseOptions {
  /**
   * The date to resolve relative/year-less text against (e.g. a bare "9/5" with
   * no year). Defaults to now. Pass a fixed value in tests.
   */
  referenceDate?: Date;
  /**
   * Timezone offset in minutes to assume for times that carry no zone (e.g.
   * "8:30 am"). Rutgers is US Eastern; default -240 (EDT). This only affects the
   * wall-clock-to-instant mapping, not the calendar day.
   */
  timezoneOffsetMinutes?: number;
}

// Strings that mean "no real date here" rather than "a date we failed to read".
// Matched case-insensitively as whole words so we don't trip on substrings.
const TBD = /\b(tbd|tba|to be determined|to be announced|coming soon)\b/i;
const CANCELLED = /\b(cancelled|canceled|postponed)\b/i;

function classifyNonDate(raw: string): UnparseableReason | null {
  if (raw.trim() === "") return "empty";
  if (CANCELLED.test(raw)) return "cancelled";
  if (TBD.test(raw)) return "tbd";
  return null;
}

/**
 * Parse a single date/range string into a start and end instant.
 *
 * A lone date yields `start === end`. A range ("Oct 17 – Nov 3") yields both
 * ends. An enumeration ("Oct 17 & 18, 2024") yields the first as start and the
 * last as end, which is the span the sessions table wants.
 */
export function parseDateRange(
  raw: string | null | undefined,
  opts: ParseOptions = {},
): ParsedRange {
  const text = (raw ?? "").trim();
  const { referenceDate, timezoneOffsetMinutes = -240 } = opts;

  const nonDate = classifyNonDate(text);
  if (nonDate) return { ok: false, raw: text, reason: nonDate };

  // chrono stops at "&"/"and", so "October 17 & 18, 2024" would parse as just
  // "October 17" and lose both the second day and the shared year. Rewriting the
  // enumeration separator to "to" makes chrono read it as the range it is.
  const normalized = text.replace(/\s+(?:&|and)\s+/gi, " to ");

  const results = chrono.parse(normalized, referenceDate, {
    forwardDate: true, // a year-less date resolves to the next occurrence, not the past
  });

  if (results.length === 0) {
    return { ok: false, raw: text, reason: "unparseable" };
  }

  // Runtime components are mutable (ParsingComponents); the public result type
  // only exposes the readonly view, so cast to reach assign().
  const components = results
    .flatMap((r) => [r.start, r.end])
    .filter(Boolean) as Array<chrono.ParsingComponents>;

  // Enumerations like "October 17 & 18, 2024" attach the explicit year to only
  // the last item; forwardDate then pushes the yearless "October 17" to a
  // different year. If any component states a year, borrow it for the ones that
  // only inferred one, so the whole span shares the authored year.
  const certainYear = components.find((c) => c.isCertain("year"))?.get("year");
  if (certainYear != null) {
    for (const c of components) {
      if (!c.isCertain("year")) c.assign("year", certainYear);
    }
  }

  // Assume Eastern for any component chrono couldn't pin to a zone, so "8:30 am"
  // doesn't drift by the server's local offset.
  for (const c of components) {
    if (!c.isCertain("timezoneOffset")) {
      c.assign("timezoneOffset", timezoneOffsetMinutes);
    }
  }

  const first = results[0];
  const last = results[results.length - 1];
  if (first === undefined || last === undefined) {
    return { ok: false, raw: text, reason: "unparseable" };
  }

  const start = first.start.date();
  // Prefer an explicit range end on the first result ("Oct 17 – 19"); else the
  // last enumerated date ("Oct 17 & 18"); else a single date (start === end).
  const end = first.end?.date() ?? last.start.date();

  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return { ok: false, raw: text, reason: "unparseable" };
  }

  // Guard against a backwards range from ambiguous year inference.
  return end < start
    ? { ok: true, start, end: start, raw: text }
    : { ok: true, start, end, raw: text };
}

/**
 * Convenience for the common scraper shape: a start cell and a separate end
 * cell, each possibly its own string. Falls back to treating `startText` as a
 * full range when `endText` is absent.
 */
export function parseStartEnd(
  startText: string | null | undefined,
  endText: string | null | undefined,
  opts: ParseOptions = {},
): ParsedRange {
  const startTrim = (startText ?? "").trim();
  const endTrim = (endText ?? "").trim();

  if (!endTrim || endTrim === startTrim) {
    return parseDateRange(startTrim, opts);
  }

  const start = parseDateRange(startTrim, opts);
  if (!start.ok) return start;

  const end = parseDateRange(endTrim, opts);
  if (!end.ok) return end;

  return { ok: true, start: start.start, end: end.end, raw: `${startTrim} – ${endTrim}` };
}
