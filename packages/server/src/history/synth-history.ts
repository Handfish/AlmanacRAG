import type { Status, TermSeason } from "@catalog/domain/course";

// The synthetic-history generator (Phase 7, the "clever" bit). The real corpus is n=1: one
// crawl, so every course has a single dated term and NOTHING exercises the POSITIVE branch
// of §10.6 — the branch that reports a real multi-term history ("seen in Fall '24/'25/'26,
// fee rose $395→$450"). This module is a deterministic test double for the temporal layer,
// the analogue of the mock-`LanguageModel` harness: it fabricates plausible PRIOR terms so
// both branches of the honesty logic can be tested.
//
// The one iron rule (architecture.md §5.3, §5.3.4, §10.6): history CANNOT be backfilled, and
// the whole product point is that the system must not invent a pattern from insufficient
// observation. So synthetic history is a TEST/SCRATCH fixture only. This generator is PURE
// and additive — it emits prior-term siblings to load into a testcontainer or a clearly
// marked scratch DB (load-synth.ts writes a `synthetic_history` marker); it never runs
// against, and is self-identifying apart from, the real observed catalog.
//
// Deterministic by construction (no Date.now / Math.random): archetype and drift are hashed
// off the course id, and the anchor year is passed in. Same input → same plan, every run.

export type Archetype =
  | "recurring" // +2 consecutive prior-year same-season terms → 3 total, verdict "grounded"
  | "returning" // +1 prior term two years back (a gap) → 2 total, verdict "grounded"
  | "current_only"; // +0 — left at n=1 so the honesty branch is testable inside a multi-term DB

/** A real, live course to synthesize prior terms for (the fields the generator needs). */
export interface SeedCourse {
  readonly courseId: string;
  readonly courseTitle: string;
  readonly season: TermSeason; // the current term's season (the anchor)
  readonly year: number; // the current term's year
  readonly feeCents: number | null; // the current total fee — past terms drift below it
  readonly campus: string | null;
  readonly deliveryMode: string | null;
}

export interface SynthChange {
  readonly field: string;
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly observedAt: string; // ISO
}

/** One fabricated prior-term listing to insert (all past, all `disappeared`). */
export interface SynthListing {
  readonly courseId: string;
  readonly sourcePageId: string; // deterministic synthetic uuid
  readonly detailUrl: string; // term-suffixed, unique (a different URL per term — like the real site)
  readonly term: string; // "Fall 2024"
  readonly termSeason: TermSeason;
  readonly termYear: number;
  readonly status: Status;
  readonly campus: string | null;
  readonly deliveryMode: string | null;
  readonly totalFeeCents: number | null;
  readonly startsOn: string; // ISO date
  readonly endsOn: string;
  readonly firstSeenAt: string; // ISO — backdated to that term
  readonly lastSeenAt: string;
  readonly disappearedAt: string; // ISO — a past term is not currently listed
  readonly changes: ReadonlyArray<SynthChange>;
}

export interface SynthPlan {
  readonly listings: ReadonlyArray<SynthListing>;
  readonly observingSince: string; // ISO date — moved back to the earliest synthetic term
  readonly assignments: ReadonlyArray<{ courseId: string; archetype: Archetype; }>;
}

// ── deterministic helpers (no clock, no randomness) ──────────────────────────────
/** FNV-1a over the string → an unsigned 32-bit int. Stable across runs and machines. */
const hash = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

/** A deterministic, valid-looking v4 uuid derived from a seed string (Postgres `uuid`). */
export const synthUuid = (seed: string): string => {
  // Four decorrelated 32-bit words from the seed, rendered as 32 hex digits with the
  // version (4) and variant (8) nibbles fixed so the string parses as a uuid.
  const words = [hash(seed), hash(`${seed}:1`), hash(`${seed}:2`), hash(`${seed}:3`)];
  const hex = words.map((w) => w.toString(16).padStart(8, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${
    hex.slice(20, 32)
  }`;
};

/** Archetype for a course, hashed off its id so the assignment is stable and reproducible.
 * All three occur across any reasonably sized corpus; `pickArchetypes` guarantees coverage
 * for a small fixture. */
export const archetypeFor = (courseId: string): Archetype => {
  switch (hash(`arch:${courseId}`) % 3) {
    case 0:
      return "recurring";
    case 1:
      return "returning";
    default:
      return "current_only";
  }
};

/** Month a season's term starts in (mirrors the real derivation: dates → season). */
const seasonStartMonth = (season: TermSeason): number =>
  season === "Winter" ? 1 : season === "Spring" ? 4 : season === "Summer" ? 6 : 9;

const iso = (year: number, month: number, day: number): string =>
  `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${
    day.toString().padStart(2, "0")
  }`;
const isoTs = (dateIso: string): string => `${dateIso}T12:00:00Z`;

/** How many prior terms a given archetype adds, and how many years back each sits. */
const priorOffsets = (archetype: Archetype): ReadonlyArray<number> => {
  switch (archetype) {
    case "recurring":
      return [1, 2]; // last year and the year before
    case "returning":
      return [2]; // two years ago, then a gap until now
    case "current_only":
      return [];
  }
};

/** A past term's fee: below the current fee, ~4% per year back, rounded to whole dollars —
 * so "has it gotten more expensive?" has a real, monotone answer. Deterministic. */
const pastFeeCents = (currentFee: number | null, yearsBack: number): number | null => {
  if (currentFee === null) return null;
  const factor = 1 - 0.04 * yearsBack;
  return Math.max(0, Math.round((currentFee * factor) / 100)) * 100;
};

/** The prior-term listings for one seed course. Empty for `current_only`. */
const listingsFor = (course: SeedCourse, archetype: Archetype): ReadonlyArray<SynthListing> =>
  priorOffsets(archetype).map((yearsBack): SynthListing => {
    const year = course.year - yearsBack;
    const month = seasonStartMonth(course.season);
    const startsOn = iso(year, month, 5);
    const endsOn = iso(year, month + 1, 15);
    const term = `${course.season} ${year}`;
    const fee = pastFeeCents(course.feeCents, yearsBack);
    const sourcePageId = synthUuid(`${course.courseId}:${term}`);
    // A past term ended full or closed; the change log records the run's status arc and,
    // where a fee is known, the increase into the next term the user can see.
    const observedAt = isoTs(endsOn);
    const changes: Array<SynthChange> = [
      { field: "status", oldValue: "open", newValue: "full", observedAt: isoTs(startsOn) },
      { field: "status", oldValue: "full", newValue: "closed", observedAt },
    ];
    if (fee !== null && course.feeCents !== null && course.feeCents !== fee) {
      changes.push({
        field: "total_fee_cents",
        oldValue: String(fee),
        newValue: String(course.feeCents),
        observedAt,
      });
    }
    return {
      courseId: course.courseId,
      sourcePageId,
      detailUrl: `synthetic://history/${course.courseId}/${course.season}-${year}`,
      term,
      termSeason: course.season,
      termYear: year,
      status: "closed",
      campus: course.campus,
      deliveryMode: course.deliveryMode,
      totalFeeCents: fee,
      startsOn,
      endsOn,
      firstSeenAt: isoTs(startsOn),
      lastSeenAt: observedAt,
      disappearedAt: observedAt,
      changes,
    };
  });

/**
 * Build a deterministic synthetic-history plan for a set of live courses. Purely additive:
 * it fabricates PRIOR-term siblings; it never mutates the real current listings. The plan's
 * `observingSince` is moved back to the earliest fabricated term so a scratch DB loaded with
 * it reports a truthful (fabricated-but-consistent) observation window.
 *
 * `assignArchetype` is injectable so a fixture can force specific archetypes; it defaults to
 * the hashed assignment (`archetypeFor`), which is stable and covers all three at scale.
 */
export const planSyntheticHistory = (
  courses: ReadonlyArray<SeedCourse>,
  options: { readonly assignArchetype?: (courseId: string) => Archetype; } = {},
): SynthPlan => {
  const assign = options.assignArchetype ?? archetypeFor;
  const assignments = courses.map((c) => ({ courseId: c.courseId, archetype: assign(c.courseId) }));
  const listings = courses.flatMap((c) => listingsFor(c, assign(c.courseId)));

  // The window starts at the earliest fabricated term (or, if nothing was added, stays at
  // the anchor's first term — a no-op for a current_only-only set).
  const earliest = listings.reduce<string | null>(
    (min, l) => (min === null || l.startsOn < min ? l.startsOn : min),
    null,
  );
  const observingSince = earliest
    ?? (courses[0]
      ? iso(courses[0].year, seasonStartMonth(courses[0].season), 5)
      : "2026-01-01");

  return { listings, observingSince, assignments };
};

/**
 * Force a fixture of exactly the three archetypes, deterministically, over the first three
 * courses (padding by repeating the last archetype). Used by the integration test and the
 * CLI's `--balanced` mode so every archetype is guaranteed present regardless of the hash.
 */
export const balancedArchetype = (
  orderedCourseIds: ReadonlyArray<string>,
): (courseId: string) => Archetype => {
  const order: ReadonlyArray<Archetype> = ["recurring", "returning", "current_only"];
  const byId = new Map<string, Archetype>();
  orderedCourseIds.forEach((id, i) => byId.set(id, order[i % order.length]!));
  return (courseId: string) => byId.get(courseId) ?? "current_only";
};
