import { ListingFilter } from "@catalog/domain/filter";
import { RouteDecision } from "@catalog/domain/ports/router";
import * as Schema from "effect/Schema";

// The router's prose + schema half (architecture.md §8) — shared by any provider adapter
// so a model swap (§11.5) compares models, not prompts. This is where "the actual
// bottleneck" is fought: turning *"under $2,000"*, *"evenings"*, *"before September"*,
// *"still open"* into a correct typed `ListingFilter`. The SYSTEM prompt states the exact
// mappings the golden set labels against — `filter_exact` (§11.2) measures whether the
// model hits them. Decode is the source of truth (like §9): the generation schema is a
// hint; `decodeRoute` re-validates through the domain `ListingFilter`.

/** Bumped when the prompt or router schema changes; recorded in `eval_run.config`. */
export const ROUTER_VERSION = "router-v3";

export const SYSTEM =
  `You are the query router for a Rutgers continuing-education course catalog. Turn ONE user question into a JSON routing decision. Accuracy over ambition — a wrong filter silently hides the exact course the user wanted.

Decompose the question into two independent halves:
- searchQuery: the TOPIC / subject matter, as a short search phrase ("cybersecurity", "grant writing", "leadership for school administrators"). This is the soft, semantic half. Null if the question is purely structural (e.g. "everything in Newark under $500").
- the FILTER fields below: the HARD, structured predicates. Set a field ONLY when the question explicitly constrains it. Never add a default. Emit null for every field you are not constraining.

Naming ONE course is not filtering. When the question is ABOUT a specific named course ("how many hours is the LSAT Test Prep Live-Online course?", "tell me about the Human Resources Professional program"), put the whole course name in searchQuery and leave EVERY filter field null. Words inside a course's name are not predicates: "Live-Online" in a title is not a delivery/campus filter, and "program"/"course"/"certification" meaning "this offering" is not a \`program\` filter. Only set \`program\` when the user names an offering DEPARTMENT to restrict to.

FILTER field rules (follow exactly):
- Money is in CENTS. "$2,000" → 200000. "under $2,000" / "at most $2,000" / "no more than $2,000" → maxFeeCents 200000. "over $500" / "at least $500" → minFeeCents 50000. Multiply dollars by 100 — an off-by-100 here is catastrophic.
- "evenings" / "at night" / "after work" → isEvening true.
- Campus (a place): "in Newark" / "Newark" → campus "Newark". "New Brunswick" / "NB" / "Piscataway" → campus "New Brunswick". "Camden" → campus "Camden". "online" / "remote" / "virtual" → campus "Online". "out of state" / "elsewhere" → campus "Other".
- Delivery MODE (how it's taught), only when stated as such: "in person" / "on campus" / "on-site" → deliveryMode "in_person". "self-paced" / "asynchronous" → deliveryMode "online_async". "live online" / "synchronous" → deliveryMode "online_sync". "hybrid" → deliveryMode "hybrid". Prefer campus "Online" for a plain "online".
- Seat availability: "open" / "still open" / "available" / "has seats" → status "open". "full" / "sold out" → status "full". "waitlist" → status "waitlist". "closed" → status "closed".
- Registration still open: ONLY when the user mentions registering/signing up — "can I still register" / "registration still open" / "not too late to sign up" → openForReg true. A bare "open" / "still open" / "still available" is SEAT status (status "open") and must NOT also set openForReg (§8).
- Contact hours: "at least 40 hours" / "40+ hours" → minHours 40. "under 10 hours" / "short" → maxHours 10.
- Dates are relative to TODAY (given in the user turn), never to your training data. "before September" → startsBefore the NEXT September on/after today, as "YYYY-MM-DD" (e.g. "2026-09-01"). "after June" / "starting after <month>" → startsAfter that date. Pick the next future occurrence.
- Seasons/terms: "this summer" / "summer courses" → term "Summer <year>"; "in the fall" → term "Fall <year>"; likewise Winter/Spring, using the year of the next such term from today. "in 2027" plus a season → that season's term. A bare "Fall 2026" → term "Fall 2026".
- Never set includeGone unless the user explicitly asks about past/discontinued/history.

These ARE answerable — do NOT refuse them:
- Comparing two or more NAMED courses ("difference between the LSAT and GRE prep", "compare A and B"): set searchQuery to a phrase covering both ("LSAT and GRE prep"), filter null.
- Eligibility / prerequisite questions about a NAMED course ("can I take X without experience?", "do I need anything before Y?", "what are the prerequisites for Z?"): searchQuery is the course name, filter null.

refuse (boolean): set true — and leave searchQuery null and every filter field null — ONLY when:
- the question is outside a continuing-ed catalog (a PhD/undergraduate degree, K-12 tutoring, "a class at Princeton", flying lessons, filing taxes);
- it names no topic and no course and is too vague to route ("the AI class" — ambiguous across many; "a good class"; "something fun");
- it asks WHEN a specific course will next run or recur, or how its price has changed over time ("when does X run again?", "will it be offered next spring?", "has it gotten more expensive?") — that needs course history, which this router cannot answer.
Otherwise refuse is false.

Output ONLY the JSON object. Every field is required; use null (or false for refuse) when it does not apply.`;

// ── Gemini OpenAPI-subset response schema (a generation hint; decode is truth) ──
type G = Record<string, unknown>;
const str = (nullable: boolean): G => ({ type: "STRING", nullable });
const num = (nullable: boolean): G => ({ type: "NUMBER", nullable });
const bool = (nullable: boolean): G => ({ type: "BOOLEAN", nullable });
const enm = (values: ReadonlyArray<string>, nullable: boolean): G => ({
  type: "STRING",
  enum: values,
  nullable,
});

// The meaningful (non-"unknown") members of each domain enum — a filter never
// constrains on "unknown". A subset of the domain Literals, so decode always passes.
const CAMPUSES = ["New Brunswick", "Newark", "Camden", "Online", "Other"];
const DELIVERY_MODES = ["in_person", "online_sync", "online_async", "hybrid"];
const STATUSES = ["open", "full", "waitlist", "closed"];

const FILTER_PROPS: Record<string, G> = {
  campus: enm(CAMPUSES, true),
  program: str(true),
  ceccUnit: str(true),
  term: str(true),
  startsBefore: str(true), // "YYYY-MM-DD"
  startsAfter: str(true),
  maxFeeCents: num(true),
  minFeeCents: num(true),
  deliveryMode: enm(DELIVERY_MODES, true),
  isEvening: bool(true),
  status: enm(STATUSES, true),
  openForReg: bool(true),
  minHours: num(true),
  maxHours: num(true),
  includeGone: bool(true),
};

export const ROUTER_RESPONSE_SCHEMA: G = {
  type: "OBJECT",
  properties: {
    refuse: bool(false),
    searchQuery: str(true),
    ...FILTER_PROPS,
  },
  required: ["refuse", "searchQuery", ...Object.keys(FILTER_PROPS)],
  propertyOrdering: ["refuse", "searchQuery", ...Object.keys(FILTER_PROPS)],
  nullable: false,
};

// ── decode (the source of truth) ──────────────────────────────────────────────
const FILTER_KEYS = Object.keys(FILTER_PROPS);

const get = (o: unknown, k: string): unknown =>
  typeof o === "object" && o !== null && k in o ? (o as Record<string, unknown>)[k] : undefined;

const decodeFilter = Schema.decodeUnknownSync(ListingFilter);

/**
 * Turn a raw router response into a typed `RouteDecision`. Null/absent filter fields are
 * dropped (an absent key means "don't constrain", never a NULL match — §4.2); the
 * remaining wire object is re-validated through the domain `ListingFilter`. An all-null
 * filter collapses to `null` (a pure lookup, distinct from an empty constraint). A refusal
 * forces filter/searchQuery null. Total and pure: a malformed filter degrades to `null`
 * rather than throwing, so one bad enum never kills the route.
 */
export const decodeRoute = (raw: unknown): RouteDecision => {
  const refuse = get(raw, "refuse") === true;
  const rawQuery = get(raw, "searchQuery");
  const searchQuery = !refuse && typeof rawQuery === "string" && rawQuery.trim().length > 0
    ? rawQuery.trim()
    : null;

  let filter: ListingFilter | null = null;
  if (!refuse) {
    const wire: Record<string, unknown> = {};
    for (const key of FILTER_KEYS) {
      const v = get(raw, key);
      if (v === null || v === undefined) continue;
      // `includeGone: false` is the default (§4.2) — it carries no constraint, so drop it
      // rather than let it pollute the canonical filter and miss `filter_exact`. Only an
      // explicit `true` (the user asked for history) is a real predicate.
      if (key === "includeGone" && v === false) continue;
      // Fee/hours may arrive as floats; the schema wants integers for cents.
      if ((key === "maxFeeCents" || key === "minFeeCents") && typeof v === "number") {
        wire[key] = Math.round(v);
      } else {
        wire[key] = v;
      }
    }
    if (Object.keys(wire).length > 0) {
      try {
        filter = decodeFilter(wire);
      } catch {
        filter = null;
      }
    }
  }

  return new RouteDecision({ filter, searchQuery, refuse });
};

/** The user turn: the question plus the deterministic `today` for relative-date resolution. */
export const routerUserPrompt = (question: string, today: Date): string =>
  `Today is ${today.toISOString().slice(0, 10)}.\n\nQuestion: ${question}`;
