import type { CourseHistory, TermRun } from "@catalog/domain/history";

// The observation-window honesty logic (architecture.md §5.3.4, §10.6), as a PURE function
// of the `course_history` structure. This is the whole point of Phase 7 and the reason the
// history prose is NOT model-composed (D-Phase7): a recurrence pattern must never be
// invented from insufficient observation, so the answer is derived deterministically from
// database facts. Every number here comes from `CourseHistory`; the function adds only the
// honesty framing.
//
// The rule (§10.6): a recurrence claim is bounded by TWO facts that travel together —
//   • the GLOBAL window: "I've only been watching this catalog since <observingSince>";
//   • the PER-COURSE evidence `termsSeen`: one sighting is not a schedule.
// So a course seen in a single dated term yields "insufficient" — the explicit "I don't
// know yet" — even in a database that holds years of other history. A course seen across
// several terms yields "grounded": we report the terms we observed and the fee trajectory,
// always hedged to the window, and never with an absolute ("every year", "always").

export type HistoryVerdict =
  | "grounded" // ≥2 dated terms observed — we can describe what we saw, bounded by the window
  | "insufficient" // ≤1 dated term — the honest answer is "I don't know yet" (§10.6)
  | "not_found"; // the course could not be resolved

export interface HistoryAnswer {
  readonly verdict: HistoryVerdict;
  readonly prose: string;
  readonly followups: ReadonlyArray<string>;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "2026-07-16" → "July 2026". Pure — parses the ISO string, no Date/clock. Falls back to
 * the raw value for anything unparseable ("unknown"). */
const monthYear = (iso: string): string => {
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(iso);
  if (m === null) return iso;
  const month = MONTHS[Number(m[2]) - 1];
  return month === undefined ? iso : `${month} ${m[1]}`;
};

const dollars = (cents: number | null): string | null =>
  cents === null ? null : `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

/** Join ["a","b","c"] as "a, b, and c" (Oxford). */
const andList = (xs: ReadonlyArray<string>): string => {
  if (xs.length === 0) return "";
  if (xs.length === 1) return xs[0]!;
  if (xs.length === 2) return `${xs[0]} and ${xs[1]}`;
  return `${xs.slice(0, -1).join(", ")}, and ${xs[xs.length - 1]}`;
};

/** Only the terms with a known season+year, oldest→newest — the ones that count as evidence. */
const datedTerms = (history: CourseHistory): ReadonlyArray<TermRun> =>
  history.terms.filter((t) => t.season !== null && t.year !== null);

/** The fee-trajectory clause, from each dated term's minimum total fee (§5.3.5 q2). Null
 * when fewer than two terms carry a fee (nothing to compare). */
const feeTrajectory = (terms: ReadonlyArray<TermRun>): string | null => {
  const withFee = terms.filter((t) => t.minFeeCents !== null);
  if (withFee.length < 2) return null;
  const first = withFee[0]!;
  const last = withFee[withFee.length - 1]!;
  const a = first.minFeeCents!;
  const b = last.minFeeCents!;
  const $a = dollars(a)!;
  const $b = dollars(b)!;
  if (a === b) return `The fee has held steady at ${$a} across those terms.`;
  const dir = b > a ? "risen" : "come down";
  return `The fee has ${dir} from ${$a} in ${first.term} to ${$b} in ${last.term}.`;
};

const HISTORY_FOLLOWUPS: ReadonlyArray<string> = [
  "Show me the current offering",
  "What does the course cover?",
];

/**
 * Compose an honest temporal answer from a `course_history` result. `courseName` is what the
 * user asked about, used in the not-found and single-term prose. Pure and total.
 */
export const composeHistory = (
  history: CourseHistory | null,
  courseName: string,
): HistoryAnswer => {
  if (history === null) {
    return {
      verdict: "not_found",
      prose:
        `I couldn't find a course matching "${courseName}" in the catalog, so I have no history to share for it.`,
      followups: [],
    };
  }

  const since = monthYear(history.window.observingSince);
  const dated = datedTerms(history);

  // ── Insufficient evidence (§10.6): ≤1 dated term. The subtle refusal — a single
  // sighting is not a schedule, and we say so explicitly rather than imply a pattern.
  if (history.termsSeen <= 1) {
    if (dated.length === 1) {
      const t = dated[0]!;
      const seenClause = t.stillListed
        ? `I've only seen the ${history.courseTitle} once — it's listed for ${t.term}`
        : `The only time I've seen the ${history.courseTitle} was ${t.term}, and it hasn't appeared since`;
      return {
        verdict: "insufficient",
        prose:
          `${seenClause}. I've only been watching this catalog since ${since}, so I can't yet tell you whether it runs regularly or when it will next be offered.`,
        followups: HISTORY_FOLLOWUPS,
      };
    }
    // No dated term at all — we can't even place it on the calendar.
    return {
      verdict: "insufficient",
      prose:
        `I don't have a dated term on record for the ${history.courseTitle}, and I've only been watching this catalog since ${since} — so I can't tell you how often it runs or when it's next offered.`,
      followups: HISTORY_FOLLOWUPS,
    };
  }

  // ── Grounded (§5.3.5): ≥2 dated terms. Report what we OBSERVED, bounded by the window;
  // never an absolute ("every year") — only the terms actually seen.
  const termLabels = dated.map((t) => t.term);
  const latest = dated[dated.length - 1]!;
  const parts: Array<string> = [];
  parts.push(
    `Since ${since} I've seen the ${history.courseTitle} in ${dated.length} terms: ${
      andList(termLabels)
    }.`,
  );
  const trajectory = feeTrajectory(dated);
  if (trajectory !== null) parts.push(trajectory);
  parts.push(
    latest.stillListed
      ? `It's currently listed for ${latest.term}.`
      : `It isn't currently listed — the most recent term I saw was ${latest.term}.`,
  );
  parts.push(
    `That's only what I've observed since ${since}; I can't see the catalog's history before then.`,
  );

  return {
    verdict: "grounded",
    prose: parts.join(" "),
    followups: HISTORY_FOLLOWUPS,
  };
};
