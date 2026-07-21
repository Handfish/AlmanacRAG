import type {
  Campus,
  DeliveryMode,
  RelationKind,
  RelationSource,
  Status,
  TermSeason,
} from "@catalog/domain/course";
import type {
  ExtractedCourse,
  ExtractedInstructor,
  ExtractedRelation,
} from "@catalog/domain/extraction";
import { parseDateRange } from "../ingest/dates.js";

// ── Derivation: ExtractedCourse (+ the deterministic page_fields) → typed rows ──
//
// The correctness heart of Phase 2 (architecture.md §9). PURE and fully unit-tested
// — one test per §9.2 hazard (derive.test.ts). No AI, no DB: given the model's
// decoded output plus the Phase-1 `page_fields`, produce the exact rows to persist.
//
// Accuracy stance (the "don't let hallucinations bite" requirement): for
// precision-critical fields that Phase 1 already captured deterministically — fee
// AMOUNTS, dates, status — `page_fields` is authoritative and the model's reading is
// only a cross-check (a disagreement is an ALERT, never a silent overwrite). The
// model owns what `page_fields` cannot: splitting concatenated instructors, campus
// from a free-form location, sync-vs-async delivery, prose relations, title facts,
// and footnote deadlines. Enum values were already constrained + decoded upstream
// (domain/extraction.ts); here every remaining derivation is deterministic.

/** The flat `page_fields` jsonb as captured in Phase 1 (fields at the top level). */
export interface StoredPageFields {
  readonly title?: string;
  readonly status?: string;
  readonly courseId?: string;
  readonly sectionId?: string;
  readonly session?: string;
  readonly dates?: string;
  readonly times?: string;
  readonly days?: string;
  readonly format?: string;
  readonly location?: string;
  readonly instructor?: string;
  readonly prerequisites?: string;
  readonly fees?: ReadonlyArray<{ readonly label: string; readonly amount: string; }>;
  readonly [key: string]: unknown;
}

export interface DeriveContext {
  readonly detailUrl: string; // listing.detail_url — the crawled page URL
  readonly groupUrl: string | null; // course.group_url (couID) — from the source page
  readonly registrationUrl?: string | null;
  /** Resolve year-less/relative dates against this instant (default: now). */
  readonly referenceDate?: Date;
}

export interface CourseInsert {
  readonly groupUrl: string | null;
  readonly externalCourseId: string | null;
  readonly courseTitle: string;
  readonly titleNormalized: string;
  readonly track: string | null;
  readonly contactHours: number | null;
  readonly subject: string | null;
  readonly program: string | null;
  readonly description: string | null;
  readonly audience: string | null;
  readonly prerequisiteText: string | null;
  readonly registrationKeyword: string | null;
}

export interface ListingInsert {
  readonly externalSectionId: string | null;
  readonly sessionLabel: string | null;
  readonly term: string | null;
  readonly termYear: number | null;
  readonly termSeason: TermSeason | null;
  readonly startsOn: string | null; // ISO YYYY-MM-DD
  readonly endsOn: string | null;
  readonly scheduleText: string | null;
  readonly isEvening: boolean | null;
  readonly registrationDeadline: string | null; // ISO YYYY-MM-DD
  readonly registrationDeadlineRule: string | null;
  readonly formatText: string | null;
  readonly formatCategory: string | null;
  readonly formatPlatform: string | null;
  readonly deliveryMode: DeliveryMode;
  readonly locationText: string | null;
  readonly locationSite: string | null;
  readonly locationRoom: string | null;
  readonly campus: Campus;
  readonly status: Status;
  readonly isNew: boolean;
  readonly totalFeeCents: number | null;
  readonly detailUrl: string;
  readonly registrationUrl: string | null;
}

export interface FeeInsert {
  readonly ord: number;
  readonly label: string;
  readonly amountCents: number;
  readonly isTotal: boolean;
}

export interface InstructorInsert {
  readonly ord: number;
  readonly lastName: string | null;
  readonly firstName: string | null;
}

export interface RelationInsert {
  readonly rawText: string;
  readonly source: RelationSource;
  readonly kind: RelationKind | null;
}

export interface DerivedRows {
  readonly course: CourseInsert;
  readonly listing: ListingInsert;
  readonly fees: ReadonlyArray<FeeInsert>;
  readonly instructors: ReadonlyArray<InstructorInsert>;
  readonly relations: ReadonlyArray<RelationInsert>;
  /** Non-fatal anomalies to log (status vocabulary, misalignment, date conflicts). */
  readonly alerts: ReadonlyArray<string>;
}

// ── §9.2 hazard #1: sentinel nulls ──────────────────────────────────────────
// "N/A", "-", "n/a", "TBD", "None", "" mean absence. Untreated they pass schema
// validation as strings and poison filters.
const SENTINELS: ReadonlySet<string> = new Set([
  "",
  "n/a",
  "na",
  "n\\a",
  "-",
  "--",
  "tbd",
  "tba",
  "none",
  "null",
]);

export const sentinelToNull = (value: string | null | undefined): string | null => {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" || SENTINELS.has(trimmed.toLowerCase()) ? null : trimmed;
};

// ── §9.2 hazard #3: fee breakdown ────────────────────────────────────────────
// Every line to a row; the "Total Fees" line is itself a row (`isTotal`). Never
// parse the first dollar figure and call it "the price". Amounts come from the
// deterministic `page_fields.fees` — a "$ 415" is parsed to integer cents.
export const parseFeeCents = (amount: string): number | null => {
  const digits = amount.replace(/[^0-9.]/g, "");
  if (digits === "" || digits === ".") return null;
  const value = Number.parseFloat(digits);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
};

const isTotalLabel = (label: string): boolean => /\btotal\b/i.test(label);

export const deriveFees = (
  fees: ReadonlyArray<{ readonly label: string; readonly amount: string; }>,
): { rows: ReadonlyArray<FeeInsert>; alerts: ReadonlyArray<string>; } => {
  const rows: Array<FeeInsert> = [];
  const alerts: Array<string> = [];
  fees.forEach((fee, ord) => {
    const cents = parseFeeCents(fee.amount);
    if (cents === null) {
      alerts.push(
        `unparseable fee amount ${JSON.stringify(fee.amount)} for ${JSON.stringify(fee.label)}`,
      );
    }
    rows.push({
      ord,
      label: fee.label.trim(),
      amountCents: cents ?? 0,
      isTotal: isTotalLabel(fee.label),
    });
  });
  return { rows, alerts };
};

/** listing.total_fee_cents — the "Total Fees" line if present, else the largest line. */
export const deriveTotalFeeCents = (rows: ReadonlyArray<FeeInsert>): number | null => {
  if (rows.length === 0) return null;
  const total = rows.find((row) => row.isTotal);
  if (total) return total.amountCents;
  return rows.reduce((max, row) => Math.max(max, row.amountCents), 0);
};

// ── §9.2 hazard #7: status vocabulary ────────────────────────────────────────
// Enumerate from the data (the four real strings); an unmatched value is `unknown`
// PLUS an alert, never a silent default.
const STATUS_MAP: ReadonlyMap<string, Status> = new Map([
  ["registration available", "open"],
  ["course full", "full"],
  ["waiting list available", "waitlist"],
  ["registration not available", "closed"],
]);

export const mapStatus = (
  raw: string | null | undefined,
): { status: Status; alert: string | null; } => {
  const key = (raw ?? "").trim().toLowerCase();
  const mapped = STATUS_MAP.get(key);
  return mapped
    ? { status: mapped, alert: null }
    : { status: "unknown", alert: `unknown status ${JSON.stringify(raw)} → unknown` };
};

// ── §9.2 hazards #4 & #13: entangled/compound Format ─────────────────────────
// "Distance Education: Online Scheduled" → {category}: {platform}; a leading "-"
// is real ("-Online: Instructor Led"). Keep the verbatim text alongside.
export const splitFormat = (
  formatText: string | null,
): { category: string | null; platform: string | null; } => {
  const cleaned = sentinelToNull(formatText);
  if (cleaned === null) return { category: null, platform: null };
  const stripped = cleaned.replace(/^-+\s*/, "").trim();
  const idx = stripped.indexOf(":");
  if (idx === -1) return { category: stripped || null, platform: null };
  return {
    category: stripped.slice(0, idx).trim() || null,
    platform: stripped.slice(idx + 1).trim() || null,
  };
};

// delivery_mode needs two sources (§5.2.3): the Format field is silent on sync vs
// async; the description settles it. We map the Format deterministically and fall
// back to the model's read (from the description) when Format is uninformative.
export const deriveDeliveryMode = (
  formatText: string | null,
  modelHint: DeliveryMode,
): DeliveryMode => {
  const t = (formatText ?? "").toLowerCase();
  if (t === "") return modelHint;
  if (t.includes("hybrid")) return "hybrid";
  if (t.includes("classroom") || t.includes("in person") || t.includes("in-person")) {
    return "in_person";
  }
  const online = t.includes("online") || t.includes("distance") || t.includes("e-college")
    || t.includes("virtual");
  const asyncMarker = t.includes("asynchronous") || t.includes("self paced")
    || t.includes("self-paced");
  const syncMarker = t.includes("instructor led") || t.includes("instructor-led")
    || t.includes("scheduled") || t.includes("synchronous");
  if (asyncMarker && !syncMarker) return "online_async";
  if (online) return syncMarker || !asyncMarker ? "online_sync" : "online_async";
  return modelHint; // "Lecture" / "Seminar" / "Hands-On" — let the model's read stand
};

// ── §9.2 hazard #4/#13: Location → campus / site / room ───────────────────────
const CAMPUS_KEYWORDS: ReadonlyArray<readonly [RegExp, Campus]> = [
  [/\bonline\b|\bon-line\b|distance education/i, "Online"],
  [/\bnewark\b/i, "Newark"],
  [/\bcamden\b/i, "Camden"],
  [
    /\bnew brunswick\b|\bpiscataway\b|\bbusch\b|\bcook\b|\blivingston\b|\bcollege ave|\bdouglass\b|rockafeller|100 rock/i,
    "New Brunswick",
  ],
];
// A trailing ", XX" state code that isn't NJ ⇒ out of state ⇒ Other.
const OUT_OF_STATE = /,\s*(?!NJ\b)[A-Z]{2}\b/;

export const deriveCampus = (locationText: string | null, modelHint: Campus): Campus => {
  const cleaned = sentinelToNull(locationText);
  if (cleaned === null) return modelHint;
  for (const [re, campus] of CAMPUS_KEYWORDS) {
    if (re.test(cleaned)) return campus;
  }
  if (OUT_OF_STATE.test(cleaned)) return "Other";
  return modelHint;
};

export const splitLocation = (
  locationText: string | null,
): { site: string | null; room: string | null; } => {
  const cleaned = sentinelToNull(locationText);
  if (cleaned === null) return { site: null, room: null };
  const roomMatch = cleaned.match(/\b(?:room|rm)\.?\s*([A-Za-z]?\d[\w-]*)/i);
  const room = roomMatch ? roomMatch[1]! : null;
  const site = sentinelToNull(cleaned.split(",")[0] ?? null);
  return { site, room };
};

// ── §9.2 hazard #2: dates (structured wins; parse to typed) + term derivation ──
const SEASON_BY_MONTH: ReadonlyArray<TermSeason> = [
  "Winter", // Jan
  "Winter", // Feb
  "Spring", // Mar
  "Spring", // Apr
  "Spring", // May
  "Summer", // Jun
  "Summer", // Jul
  "Summer", // Aug
  "Fall", // Sep
  "Fall", // Oct
  "Fall", // Nov
  "Winter", // Dec
];

const toIsoDate = (date: Date): string => {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

export const deriveDates = (
  datesText: string | null,
  referenceDate?: Date,
): { startsOn: string | null; endsOn: string | null; } => {
  const cleaned = sentinelToNull(datesText);
  if (cleaned === null) return { startsOn: null, endsOn: null };
  const parsed = parseDateRange(cleaned, referenceDate ? { referenceDate } : {});
  if (!parsed.ok) return { startsOn: null, endsOn: null };
  return { startsOn: toIsoDate(parsed.start), endsOn: toIsoDate(parsed.end) };
};

// term_season / term_year come from the START of the dates range, NOT `session`
// (which is a cohort label in the real data — docs/real-data-findings-1.md).
export const deriveTerm = (
  startsOn: string | null,
): { year: number | null; season: TermSeason | null; label: string | null; } => {
  if (startsOn === null) return { year: null, season: null, label: null };
  const [yStr, mStr] = startsOn.split("-");
  const year = Number(yStr);
  const month = Number(mStr);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return { year: null, season: null, label: null };
  }
  const season = SEASON_BY_MONTH[month - 1]!;
  return { year, season, label: `${season} ${year}` };
};

// ── §9.2 hazards #6 & #12: is_evening (NULL when there is no clock time) ──────
// The Format field can also flag it ("Instructor Led: Evening & Weekend").
export const deriveIsEvening = (
  timesText: string | null,
  formatText: string | null,
  modelHint: boolean | null,
): boolean | null => {
  if (/\bevening\b/i.test(formatText ?? "")) return true;
  const cleaned = sentinelToNull(timesText);
  if (cleaned === null) return modelHint; // async has no time of day → typically NULL
  const match = cleaned.match(/(\d{1,2}):(\d{2})\s*(am|pm)/i);
  if (match === null) return modelHint;
  const hour12 = Number(match[1]) % 12;
  const startHour = /pm/i.test(match[3]!) ? hour12 + 12 : hour12;
  return startHour >= 17; // starts 5pm or later
};

// ── §9.2 hazard #9: facts inside the title ───────────────────────────────────
// "…45 - Hour…" → 45. The model parses track/subject; this is the deterministic
// fallback/validator for contact_hours.
export const parseContactHours = (title: string | null): number | null => {
  if (title === null) return null;
  const match = title.match(/(\d+(?:\.\d+)?)\s*-?\s*hours?\b/i);
  return match ? Number(match[1]) : null;
};

export const normalizeTitle = (title: string): string =>
  title.toLowerCase().replace(/[\s-]+/g, " ").trim();

// ── §9.2 hazard #10: rules inside footnotes → registration_deadline ──────────
// "*The deadline … is two business days prior to the start of the course" → a date.
// Keep the verbatim rule for display; derive the date from the start when the rule
// is the common "N (business) days prior to the start" shape.
const WORD_NUMBERS: ReadonlyMap<string, number> = new Map([
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["seven", 7],
  ["ten", 10],
]);

const businessDaysBefore = (isoDate: string, days: number): string => {
  const date = new Date(`${isoDate}T00:00:00Z`);
  let remaining = days;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() - 1);
    const dow = date.getUTCDay();
    if (dow !== 0 && dow !== 6) remaining -= 1; // skip Sun/Sat
  }
  return toIsoDate(date);
};

export const deriveDeadline = (
  ruleText: string | null,
  startsOn: string | null,
): { date: string | null; rule: string | null; } => {
  const rule = sentinelToNull(ruleText);
  if (rule === null) return { date: null, rule: null };
  if (startsOn === null) return { date: null, rule };
  const match = rule.match(
    /(\d+|one|two|three|four|five|seven|ten)\s+(business\s+)?days?\s+prior/i,
  );
  if (match === null) return { date: null, rule };
  const n = WORD_NUMBERS.get(match[1]!.toLowerCase()) ?? Number(match[1]);
  if (!Number.isInteger(n) || n <= 0) return { date: null, rule };
  const date = match[2] ? businessDaysBefore(startsOn, n) : subtractDays(startsOn, n);
  return { date, rule };
};

const subtractDays = (isoDate: string, days: number): string => {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return toIsoDate(date);
};

// ── §9.2 hazard #11: relations from prose AND the prereq field ────────────────
// Dedupe by raw text; drop the "None"/sentinel rows the field is full of.
const NON_NAME = /\b(asynchronous|self\s*paced|self-paced|online|distance|tbd|staff|n\/?a)\b/i;

export const deriveRelations = (
  relations: ReadonlyArray<ExtractedRelation>,
): ReadonlyArray<RelationInsert> => {
  const seen = new Set<string>();
  const out: Array<RelationInsert> = [];
  for (const relation of relations) {
    const raw = sentinelToNull(relation.rawText);
    if (raw === null || seen.has(raw)) continue;
    seen.add(raw);
    out.push({ rawText: raw, source: relation.source, kind: relation.kind });
  }
  return out;
};

// ── §9.2 hazard #13: instructors — split "Last, First" pairs, drop non-names ──
export const deriveInstructors = (
  instructors: ReadonlyArray<ExtractedInstructor>,
): ReadonlyArray<InstructorInsert> => {
  const out: Array<InstructorInsert> = [];
  for (const person of instructors) {
    const lastName = sentinelToNull(person.lastName);
    const firstName = sentinelToNull(person.firstName);
    if (lastName === null && firstName === null) continue; // both sentinel → not a person
    if (NON_NAME.test(`${lastName ?? ""} ${firstName ?? ""}`)) continue; // format leak, not a name
    out.push({ ord: out.length, lastName, firstName });
  }
  return out;
};

// ── §9.2 hazard #8: label/value misalignment ─────────────────────────────────
// The scrape shifts values by one row: `page_fields` can put the course code in the
// section slot. The model reads the whole page and realigns; if the deterministic
// capture disagrees, trust the model and flag it.
export const detectMisalignment = (
  extractedCourseId: string | null,
  pageFields: StoredPageFields,
): string | null => {
  const pfCourse = sentinelToNull(pageFields.courseId);
  const pfSection = sentinelToNull(pageFields.sectionId);
  const modelCourse = sentinelToNull(extractedCourseId);
  if (modelCourse !== null && pfCourse === null && pfSection === modelCourse) {
    return `label/value misalignment: page_fields.courseId empty but the course code ${
      JSON.stringify(modelCourse)
    } appears in the sectionId slot — using the model's realigned reading`;
  }
  return null;
};

// ── Top level ─────────────────────────────────────────────────────────────────
export const deriveRows = (
  extracted: ExtractedCourse,
  pageFields: StoredPageFields,
  ctx: DeriveContext,
): DerivedRows => {
  const alerts: Array<string> = [];

  // Status — deterministic from page_fields, cross-checked against the model.
  const statusResult = mapStatus(pageFields.status ?? extracted.statusRaw);
  if (statusResult.alert) alerts.push(statusResult.alert);

  // Fees — deterministic amounts from page_fields (never the model's numbers).
  const fee = deriveFees(pageFields.fees ?? []);
  alerts.push(...fee.alerts);

  // Dates → term (from the start month, not `session`).
  const dates = deriveDates(pageFields.dates ?? extracted.datesText, ctx.referenceDate);
  const term = deriveTerm(dates.startsOn);

  // Cross-check: the model's date reading vs the structured field.
  const modelDates = deriveDates(extracted.datesText, ctx.referenceDate);
  if (
    modelDates.startsOn !== null && dates.startsOn !== null
    && modelDates.startsOn !== dates.startsOn
  ) {
    alerts.push(
      `date conflict: page_fields ${dates.startsOn} vs model ${modelDates.startsOn} — using page_fields`,
    );
  }

  const format = splitFormat(extracted.formatText ?? pageFields.format ?? null);
  const location = splitLocation(extracted.locationText ?? pageFields.location ?? null);
  const deadline = deriveDeadline(extracted.registrationDeadlineText, dates.startsOn);

  const misalignment = detectMisalignment(extracted.externalCourseId, pageFields);
  if (misalignment) alerts.push(misalignment);

  const course: CourseInsert = {
    groupUrl: ctx.groupUrl,
    externalCourseId: sentinelToNull(extracted.externalCourseId),
    courseTitle: extracted.courseTitle,
    titleNormalized: normalizeTitle(extracted.courseTitle),
    track: sentinelToNull(extracted.track),
    contactHours: extracted.contactHours ?? parseContactHours(extracted.courseTitle),
    subject: sentinelToNull(extracted.subject),
    program: sentinelToNull(extracted.program),
    description: sentinelToNull(extracted.description),
    audience: sentinelToNull(extracted.audience),
    prerequisiteText: sentinelToNull(extracted.prerequisiteText),
    registrationKeyword: sentinelToNull(extracted.registrationKeyword),
  };

  const listing: ListingInsert = {
    externalSectionId: sentinelToNull(extracted.externalSectionId ?? pageFields.sectionId ?? null),
    sessionLabel: sentinelToNull(extracted.sessionLabel ?? pageFields.session ?? null),
    term: term.label,
    termYear: term.year,
    termSeason: term.season,
    startsOn: dates.startsOn,
    endsOn: dates.endsOn,
    scheduleText: sentinelToNull(extracted.scheduleText),
    isEvening: deriveIsEvening(
      extracted.timesText ?? pageFields.times ?? null,
      extracted.formatText ?? pageFields.format ?? null,
      extracted.isEvening,
    ),
    registrationDeadline: deadline.date,
    registrationDeadlineRule: deadline.rule,
    formatText: sentinelToNull(extracted.formatText ?? pageFields.format ?? null),
    formatCategory: format.category,
    formatPlatform: format.platform,
    deliveryMode: deriveDeliveryMode(
      extracted.formatText ?? pageFields.format ?? null,
      extracted.deliveryMode,
    ),
    locationText: sentinelToNull(extracted.locationText ?? pageFields.location ?? null),
    locationSite: location.site,
    locationRoom: location.room,
    campus: deriveCampus(extracted.locationText ?? pageFields.location ?? null, extracted.campus),
    status: statusResult.status,
    isNew: extracted.isNew,
    totalFeeCents: deriveTotalFeeCents(fee.rows),
    detailUrl: ctx.detailUrl,
    registrationUrl: ctx.registrationUrl ?? null,
  };

  return {
    course,
    listing,
    fees: fee.rows,
    instructors: deriveInstructors(extracted.instructors),
    relations: deriveRelations(extracted.relations),
    alerts,
  };
};
