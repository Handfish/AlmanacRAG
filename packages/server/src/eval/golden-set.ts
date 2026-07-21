import { ListingFilter } from "@catalog/domain/filter";

// The golden set (architecture.md §11.1) — the ground truth `filter_exact`, nDCG@10, and
// refusal are scored against. Every item is authored against the REAL 731-course corpus
// (course titles, campuses, fee bands, terms are all things that exist in the DB), so the
// labels are correct by construction rather than aspirational. Stratified by SHAPE per the
// §11.1 target shares; the field-presence band (§2.1) is computed per target course at
// seed time (`seed.ts`) rather than guessed here.
//
// `expected_ids` is not stored inline — it is RESOLVED at seed time so it stays correct as
// the corpus drifts (a re-crawl adds a section, a sweep retires one). `resolve` says how:
//   • filter — expected_ids = the courses whose live listings pass `expectedFilter`
//     (`filter_listings`). Used for `filtered`/`availability`: correct by construction, and
//     the retrieval metric then measures the FILTER compilation, not a soft search.
//   • title  — expected_ids = the courses whose title matches any pattern (ILIKE). Used for
//     the soft shapes (`lookup`/`comparative`/`eligibility`), where the answer is a
//     specific known course and retrieval is a hybrid search.
//   • none   — expected_ids = ∅. The item's correct answer is a REFUSAL (§10.6): the
//     `unanswerable` slice and the "I don't know yet" tail of `temporal` (no history tool).
//
// Relative dates ("before September") are resolved against a FIXED `EVAL_TODAY` so the set
// is reproducible (§11.3) — `eval_run.config` records it. The `filtered`/`availability`
// `expectedFilter`s encode the exact §8 mappings the router prompt teaches; `filter_exact`
// measures whether the model reproduces them. A `filtered` item may also carry a soft topic
// in its wording (the motivating query, §1) — that drives `filter_exact` only; its retrieval
// is still scored on the hard filter, which is what `filter_listings` is responsible for.

/** The fixed "now" for the golden set — the project's current date (§11.3 reproducibility). */
export const EVAL_TODAY = new Date("2026-07-21T00:00:00.000Z");

export type Shape =
  | "lookup"
  | "filtered"
  | "availability"
  | "comparative"
  | "eligibility"
  | "temporal"
  | "unanswerable";

export type Resolve =
  | { readonly kind: "filter"; }
  | { readonly kind: "title"; readonly patterns: ReadonlyArray<string>; }
  | { readonly kind: "none"; };

export interface GoldenItem {
  readonly question: string;
  readonly shape: Shape;
  readonly expectedFilter: ListingFilter | null;
  readonly resolve: Resolve;
  readonly rubric: string;
}

const f = (o: ConstructorParameters<typeof ListingFilter>[0]): ListingFilter =>
  new ListingFilter(o);
const title = (...patterns: Array<string>): Resolve => ({ kind: "title", patterns });
const byFilter: Resolve = { kind: "filter" };
const none: Resolve = { kind: "none" };

// Dates resolved against EVAL_TODAY (2026-07-21): the next occurrence in the future.
const SEP_1 = new Date("2026-09-01T00:00:00.000Z");
const OCT_1 = new Date("2026-10-01T00:00:00.000Z");
const DEC_1 = new Date("2026-12-01T00:00:00.000Z");

// ── lookup (≈25%) — a specific course; the router must NOT invent a filter ────────
const lookup: ReadonlyArray<GoldenItem> = [
  ["How many contact hours is the PMP Certification Program?", "PMP Certification Program"],
  ["How long is the LSAT Test Prep Live-Online course?", "LSAT Test Prep Live-Online"],
  ["How many hours is the GRE Test Prep Live-Online?", "GRE Test Prep Live-Online"],
  ["Tell me about the Certified Public Manager program.", "Certified Public Manager"],
  ["Describe the Full Stack Software Developer course.", "Full Stack Software Developer"],
  ["What does the Certified Ethical Hacker course cover?", "Certified Ethical Hacker"],
  ["How many hours is the Six Sigma Green Belt certification?", "Six Sigma Green Belt"],
  ["Tell me about the Professional Grant Writing course.", "Professional Grant Writing"],
  ["What is the Medical Billing and Coding course?", "Medical Billing and Coding"],
  ["How long is the Human Resources Professional program?", "Human Resources Professional"],
  ["What is the Freight Broker/Agent Training?", "Freight Broker/Agent"],
  ["Tell me about the Certified Wedding Planner course.", "Certified Wedding Planner"],
  ["What is the Data Analytics Course about?", "Data Analytics Course"],
  ["How many hours is the Front-End Web Developer course?", "Front-End Web Developer"],
  ["Tell me about the Certified Supply Chain Professional.", "Certified Supply Chain Professional"],
  ["What is the CompTIA A+ Certification Training?", "CompTIA A+"],
  [
    "How long is the Leadership Coaching for Organizational Performance course?",
    "Leadership Coaching for Organizational Performance",
  ],
  [
    "What is the Certified Residential Interior Designer course?",
    "Certified Residential Interior Designer",
  ],
  ["How many hours is the Sales Manager course?", "Sales Manager"],
  [
    "What is the Digital Court Reporting with Legal Transcription course?",
    "Digital Court Reporting",
  ],
  ["Tell me about the Alternate Route 50-Hour Pre-Service Course.", "Alternate Route 50"],
  ["What is the Certified Java Developer course?", "Certified Java Developer"],
].map(([question, pat]): GoldenItem => ({
  question: question!,
  shape: "lookup",
  expectedFilter: null,
  resolve: title(pat!),
  rubric:
    `Answer about the specific course "${pat}". No hard filter — the router must leave filter null and route the title to search. Facts come from the hydrated card, not prose (§1).`,
}));

// ── filtered (≈30%) — hard predicates → ListingFilter; the filter_exact headline ──
const filtered: ReadonlyArray<GoldenItem> = [
  {
    question: "What courses are offered in Newark?",
    expectedFilter: f({ campus: "Newark" }),
    rubric: "campus → Newark.",
  },
  {
    question: "Show me courses in Camden.",
    expectedFilter: f({ campus: "Camden" }),
    rubric: "campus → Camden.",
  },
  {
    question: "Which courses are in New Brunswick?",
    expectedFilter: f({ campus: "New Brunswick" }),
    rubric: "campus → New Brunswick.",
  },
  {
    question: "Show me online courses.",
    expectedFilter: f({ campus: "Online" }),
    rubric: "plain 'online' → campus Online.",
  },
  {
    question: "What in-person courses do you have?",
    expectedFilter: f({ deliveryMode: "in_person" }),
    rubric: "'in person' → deliveryMode in_person.",
  },
  {
    question: "Are there any hybrid courses?",
    expectedFilter: f({ deliveryMode: "hybrid" }),
    rubric: "'hybrid' → deliveryMode hybrid.",
  },
  {
    question: "Show me evening courses.",
    expectedFilter: f({ isEvening: true }),
    rubric: "'evening' → isEvening true; must not exclude NULLs silently upstream (§8).",
  },
  {
    question: "What evening classes are in New Brunswick?",
    expectedFilter: f({ campus: "New Brunswick", isEvening: true }),
    rubric: "campus + isEvening.",
  },
  {
    question: "Which courses cost less than $500?",
    expectedFilter: f({ maxFeeCents: 50000 }),
    rubric: "$500 → 50000 cents (×100).",
  },
  {
    question: "What courses are under $2,000?",
    expectedFilter: f({ maxFeeCents: 200000 }),
    rubric: "$2,000 → 200000 cents. Off-by-100 is silent and catastrophic (§11.2).",
  },
  {
    question: "Show me courses over $1,000.",
    expectedFilter: f({ minFeeCents: 100000 }),
    rubric: "'over $1,000' → minFeeCents 100000.",
  },
  {
    question: "Courses between $500 and $2,000.",
    expectedFilter: f({ minFeeCents: 50000, maxFeeCents: 200000 }),
    rubric: "a fee band → both bounds, both ×100.",
  },
  {
    question: "Cybersecurity courses in Newark under $2,000.",
    expectedFilter: f({ campus: "Newark", maxFeeCents: 200000 }),
    rubric:
      "The motivating query (§1): soft topic → search; hard predicates campus + fee → filter. filter_exact scores the hard half.",
  },
  {
    question: "Evening courses under $500.",
    expectedFilter: f({ isEvening: true, maxFeeCents: 50000 }),
    rubric: "isEvening + maxFee.",
  },
  {
    question: "Show me Fall 2026 courses.",
    expectedFilter: f({ term: "Fall 2026" }),
    rubric: "a named term → term string.",
  },
  {
    question: "What courses run in Summer 2026?",
    expectedFilter: f({ term: "Summer 2026" }),
    rubric: "term → Summer 2026.",
  },
  {
    question: "Courses in Winter 2026.",
    expectedFilter: f({ term: "Winter 2026" }),
    rubric: "term → Winter 2026.",
  },
  {
    question: "Courses starting before September.",
    expectedFilter: f({ startsBefore: SEP_1 }),
    rubric: "relative date → next Sep 1 from EVAL_TODAY (2026-09-01).",
  },
  {
    question: "Show me courses that start in October or later.",
    expectedFilter: f({ startsAfter: OCT_1 }),
    rubric:
      "relative date → on/after 2026-10-01 (phrased to avoid the 'after October' start-vs-end ambiguity).",
  },
  {
    question: "Courses that begin before December.",
    expectedFilter: f({ startsBefore: DEC_1 }),
    rubric: "relative date → 2026-12-01.",
  },
  {
    question: "Short courses under 10 contact hours.",
    expectedFilter: f({ maxHours: 10 }),
    rubric: "'under 10 hours' → maxHours 10.",
  },
  {
    question: "Courses with at least 40 contact hours.",
    expectedFilter: f({ minHours: 40 }),
    rubric: "'at least 40 hours' → minHours 40.",
  },
  {
    question: "Online courses under $1,000.",
    expectedFilter: f({ campus: "Online", maxFeeCents: 100000 }),
    rubric: "campus Online + fee.",
  },
  {
    question: "In-person courses in Camden.",
    expectedFilter: f({ campus: "Camden", deliveryMode: "in_person" }),
    rubric: "campus + deliveryMode.",
  },
  {
    question: "Fall 2026 courses in Camden.",
    expectedFilter: f({ campus: "Camden", term: "Fall 2026" }),
    rubric: "term + campus.",
  },
  {
    question: "Newark courses under $1,000.",
    expectedFilter: f({ campus: "Newark", maxFeeCents: 100000 }),
    rubric: "campus + fee (narrow set).",
  },
].map((x) => ({ ...x, shape: "filtered" as const, resolve: byFilter }));

// ── availability (≈10%) — status / openForReg, the "still open?" family ───────────
const availability: ReadonlyArray<GoldenItem> = [
  {
    question: "What courses are still open?",
    expectedFilter: f({ status: "open" }),
    rubric: "'still open' → status open (a seat property, not semantic — §8).",
  },
  {
    question: "What's full right now?",
    expectedFilter: f({ status: "full" }),
    rubric: "'full' → status full.",
  },
  {
    question: "Show me courses with a waitlist.",
    expectedFilter: f({ status: "waitlist" }),
    rubric: "'waitlist' → status waitlist.",
  },
  {
    question: "What's still open for summer?",
    expectedFilter: f({ status: "open", term: "Summer 2026" }),
    rubric: "availability + term → status open + Summer 2026.",
  },
  {
    question: "Which Fall 2026 courses are open?",
    expectedFilter: f({ status: "open", term: "Fall 2026" }),
    rubric: "status + term.",
  },
  {
    question: "Show me open courses in New Brunswick.",
    expectedFilter: f({ status: "open", campus: "New Brunswick" }),
    rubric: "status + campus.",
  },
  {
    question: "What open online courses are there?",
    expectedFilter: f({ status: "open", campus: "Online" }),
    rubric: "status + campus Online.",
  },
  {
    question: "Are there open evening courses?",
    expectedFilter: f({ status: "open", isEvening: true }),
    rubric: "status + isEvening.",
  },
].map((x) => ({ ...x, shape: "availability" as const, resolve: byFilter }));

// ── comparative (≈10%) — two named courses; filter stays null ─────────────────────
const comparative: ReadonlyArray<GoldenItem> = [
  ["What's the difference between the LSAT and GRE prep courses?", [
    "LSAT Test Prep",
    "GRE Test Prep",
  ]],
  ["How does the Front-End Web Developer course compare to the Full Stack Software Developer?", [
    "Front-End Web Developer",
    "Full Stack Software Developer",
  ]],
  ["Compare the LSAT In-Person and Live-Online prep options.", [
    "LSAT Test Prep In-Person",
    "LSAT Test Prep Live-Online",
  ]],
  ["What's the difference between the Six Sigma Green Belt and the PMP Certification Program?", [
    "Six Sigma Green Belt",
    "PMP Certification Program",
  ]],
  ["Compare Medical Billing and Coding with the Certified Paralegal course.", [
    "Medical Billing and Coding",
    "Certified Paralegal",
  ]],
  ["GRE versus GMAT prep — how do they differ?", ["GRE Test Prep", "GMAT Test Prep"]],
  ["Difference between the Human Resources Professional and Sales Manager courses?", [
    "Human Resources Professional",
    "Sales Manager",
  ]],
  ["Compare the CompTIA A+ and Cisco CCNA certification trainings.", ["CompTIA A+", "Cisco CCNA"]],
  ["How does Professional Grant Writing compare to the Data Analytics Course?", [
    "Professional Grant Writing",
    "Data Analytics Course",
  ]],
].map(([question, pats]): GoldenItem => ({
  question: question as string,
  shape: "comparative",
  expectedFilter: null,
  resolve: title(...(pats as Array<string>)),
  rubric: "Two named courses — both must surface; no hard filter (§8 decomposition).",
}));

// ── eligibility (≈5%) — prereq-aware; still a specific answerable course ───────────
const eligibility: ReadonlyArray<GoldenItem> = [
  {
    question: "Can I take Microsoft Office Excel Level 2 without any prior Excel experience?",
    pat: "Microsoft Office Excel - Level 2",
    why: "Prereq is Excel Level 1 or equivalent (course_relation).",
  },
  {
    question: "Do I need anything before Preparation of Annual Financial Statements?",
    pat: "Preparation of Annual Financial Statements",
    why: "Prereq is Principles of Financial Management.",
  },
  {
    question: "Am I eligible for the Crisis Communication and Reputation Management Capstone?",
    pat: "Crisis Communication and Reputation Management",
    why: "Prereqs: Fundamentals of Crisis Communications + Crisis Communication Planning.",
  },
  {
    question: "What are the prerequisites for the Certified Electronic Health Records Specialist?",
    pat: "Certified Electronic Health Records",
    why: "Recommends completing Medical Terminology first.",
  },
  {
    question: "Can a total beginner take the Certified Paralegal course?",
    pat: "Certified Paralegal",
    why: "Eligibility question about a specific course; answerable from its description.",
  },
].map(({ question, pat, why }): GoldenItem => ({
  question,
  shape: "eligibility",
  expectedFilter: null,
  resolve: title(pat),
  rubric:
    `Eligibility for "${pat}". Answerable (not a refusal): route the title to search, filter null. ${why}`,
}));

// ── temporal (≈5%) — recurrence / price-history; no history tool yet → refuse ──────
const temporal: ReadonlyArray<GoldenItem> = [
  "When does the LSAT prep course run again?",
  "Will the Certified Paralegal course be offered next spring?",
  "Has the PMP Certification Program gotten more expensive over time?",
  "When was the last time GRE prep was offered?",
  "Is the Data Analytics Course coming back next year?",
].map((question): GoldenItem => ({
  question,
  shape: "temporal",
  expectedFilter: null,
  resolve: none,
  rubric:
    "Recurrence / price-history needs the course_history tool (§8), absent in Phase 4. Correct answer is a bounded 'I can't tell you that yet' → refuse.",
}));

// ── unanswerable (≈15%) — out of scope or too vague; refuse (§10.6) ───────────────
const unanswerable: ReadonlyArray<GoldenItem> = [
  "Do you offer a PhD in astrophysics?",
  "Can I get a bachelor's degree here?",
  "Do you have K-12 tutoring?",
  "I want to take the AI class.",
  "What's a good class to take?",
  "Do you offer courses at Princeton?",
  "Can you help me file my taxes?",
  "Do you offer flying lessons?",
  "Sign me up for something fun.",
  "Do you offer a medical residency?",
  "What's the weather like on campus today?",
  "Do you sell textbooks?",
].map((question): GoldenItem => ({
  question,
  shape: "unanswerable",
  expectedFilter: null,
  resolve: none,
  rubric:
    "Outside a continuing-ed catalog, or too vague to route to one intent (§8: 'the AI class'). Correct answer is a refusal.",
}));

export const GOLDEN_SET: ReadonlyArray<GoldenItem> = [
  ...lookup,
  ...filtered,
  ...availability,
  ...comparative,
  ...eligibility,
  ...temporal,
  ...unanswerable,
];
