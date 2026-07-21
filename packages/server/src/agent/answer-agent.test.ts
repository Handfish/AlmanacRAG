import { Answer, type Card, CardRef } from "@catalog/domain/answer";
import type { CourseHistory } from "@catalog/domain/history";
import type { CourseId, ListingId } from "@catalog/domain/ids";
import { type AnswerCandidate, Answerer } from "@catalog/domain/ports/answerer";
import { type FilteredListing, KnowledgeBase } from "@catalog/domain/ports/knowledge-base";
import { RouteDecision, Router } from "@catalog/domain/ports/router";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Agent from "./answer-agent.js";

// The answer agent (§8/§10) wired over MOCK ports — the loop without a provider or a DB
// (the plan's most valuable test idiom). Asserts the two contracts: (1) grounded refusal
// is an empty-cards result, and (2) on the happy path the model authors only `why` while
// every card FACT is whatever `hydrate` returned (ADR-008) — the answerer never touches
// the returned facts.

const listing = (id: string, courseId: string, title: string): FilteredListing => ({
  listingId: id as ListingId,
  courseId: courseId as CourseId,
  courseTitle: title,
  term: "Summer 2026",
  campus: "Newark",
  deliveryMode: "online_sync",
  status: "open",
  isEvening: null,
  startsOn: "2026-07-20",
  endsOn: "2026-08-03",
  totalFeeCents: 41500,
  contactHours: 45,
  detailUrl: `https://x/${id}`,
  registrationUrl: null,
});

const card = (id: string, courseId: string, title: string, fee: number): Card => ({
  listingId: id as ListingId,
  courseId: courseId as CourseId,
  courseTitle: title,
  externalCourseId: null,
  track: null,
  contactHours: 45,
  deliveryMode: "online_sync",
  campus: "Newark",
  term: "Summer 2026",
  startsOn: "2026-07-20",
  endsOn: "2026-08-03",
  isEvening: null,
  scheduleText: null,
  status: "open",
  totalFeeCents: fee,
  fees: [{ label: "Total Fees", amountCents: fee, isTotal: true }],
  registrationDeadline: null,
  registrationDeadlineRule: null,
  registrationUrl: null,
  registrationKeyword: null,
  detailUrl: `https://x/${id}`,
  checkedAt: "2026-07-21T00:00:00Z",
  why: "", // hydrate leaves this blank; the agent attaches the model's why
});

const MockRouter = (decision: RouteDecision) =>
  Layer.sync(Router, () => ({ route: () => Effect.succeed(decision) }));

const MockAnswerer = (make: (candidates: ReadonlyArray<AnswerCandidate>) => Answer) =>
  Layer.sync(Answerer, () => ({ answer: (_q, candidates) => Effect.succeed(make(candidates)) }));

const MockKb = (opts: {
  readonly search?: ReadonlyArray<string>;
  readonly listings?: ReadonlyArray<FilteredListing>;
  readonly cards?: ReadonlyArray<Card>;
  readonly history?: CourseHistory | null;
}) =>
  Layer.sync(KnowledgeBase, () => ({
    search: () =>
      Effect.succeed(
        (opts.search ?? []).map((id) => ({
          courseId: id as CourseId,
          score: 1,
          courseTitle: null,
        })),
      ),
    filterListings: () => Effect.succeed(opts.listings ?? []),
    relaxFilter: () => Effect.succeed({ total: 0, relaxations: [] }),
    // Respect the requested course ids (in input order) — so discovery's anchor-exclusion
    // is observable in the returned candidates, like the real adapter.
    listingsForCourses: (courseIds) =>
      Effect.succeed(
        courseIds.flatMap((id) =>
          (opts.listings ?? []).filter((l) => (l.courseId as string) === (id as string))
        ),
      ),
    hydrate: (ids) =>
      Effect.succeed(
        (opts.cards ?? []).filter((c) =>
          ids.map((i) => i as string).includes(c.listingId as string)
        ),
      ),
    observationWindow: () => Effect.succeed({ observingSince: "2026-07-16", termsObserved: 1 }),
    courseHistory: () => Effect.succeed(opts.history ?? null),
  }));

const TODAY = new Date("2026-07-21");

describe("answer-agent", () => {
  it.effect("a refusal produces an empty-cards result and never retrieves", () =>
    Effect.gen(function*() {
      const result = yield* Agent.run("get me a PhD in astrophysics", TODAY);
      expect(result.refused).toBe(true);
      expect(result.cards).toEqual([]);
      expect(result.answer.filter).toBe(null);
    }).pipe(
      Effect.provide(
        MockRouter(
          new RouteDecision({
            filter: null,
            searchQuery: null,
            historyQuery: null,
            refuse: true,
          }),
        ),
      ),
      Effect.provide(
        MockAnswerer(() =>
          new Answer({ prose: "Not in this catalog.", cards: [], filter: null, followups: [] })
        ),
      ),
      Effect.provide(MockKb({})),
    ));

  it.effect("happy path: model authors only `why`; card facts come from hydrate (ADR-008)", () =>
    Effect.gen(function*() {
      const result = yield* Agent.run("grant writing courses", TODAY);
      expect(result.refused).toBe(false);
      expect(result.cards.length).toBe(1);
      const c = result.cards[0]!;
      // The FACTS are the hydrated ones (from the DB mock), regardless of what the model saw.
      expect(c.totalFeeCents).toBe(41500);
      expect(c.status).toBe("open");
      expect(c.courseTitle).toBe("Grant Writing I");
      // The only model-authored text on the card is `why`.
      expect(c.why).toBe("matches your grant-writing topic");
      // Router's filter (null here) is echoed, not the answerer's.
      expect(result.answer.filter).toBe(null);
      // Follow-ups are self-contained and each go somewhere NEW (a facet the card lacks, or
      // other courses) — NOT the model's, and never a same-card re-render.
      expect(result.answer.followups).toEqual([
        "How often has the Grant Writing I run?",
        "Show me courses similar to Grant Writing I",
      ]);
    }).pipe(
      Effect.provide(
        MockRouter(
          new RouteDecision({
            filter: null,
            searchQuery: "grant writing",
            historyQuery: null,
            refuse: false,
          }),
        ),
      ),
      Effect.provide(MockAnswerer((candidates) =>
        new Answer({
          prose: "One match.",
          cards: candidates.slice(0, 1).map((cand) =>
            new CardRef({ listingId: cand.listingId, why: "matches your grant-writing topic" })
          ),
          filter: null,
          followups: [],
        })
      )),
      Effect.provide(MockKb({
        search: ["7"],
        listings: [listing("100", "7", "Grant Writing I")],
        cards: [card("100", "7", "Grant Writing I", 41500)],
      })),
    ));

  it.effect("a 'similar to' discovery query drops the anchor course → OTHER courses surface", () =>
    Effect.gen(function*() {
      // Search ranks the named course (7) first, then neighbours (8, 9). Discovery must
      // exclude 7 so the follow-up lands somewhere new, not on the same card.
      const result = yield* Agent.run("Show me courses similar to Grant Writing I", TODAY);
      const courseIds = new Set(result.cards.map((c) => c.courseId as string));
      expect(courseIds.has("7")).toBe(false); // the anchor is gone
      expect(courseIds.has("8")).toBe(true); // a neighbour surfaces
    }).pipe(
      Effect.provide(
        MockRouter(
          new RouteDecision({
            filter: null,
            searchQuery: "Grant Writing I",
            historyQuery: null,
            refuse: false,
          }),
        ),
      ),
      Effect.provide(MockAnswerer((candidates) =>
        new Answer({
          prose: "Related options:",
          cards: candidates.map((c) => new CardRef({ listingId: c.listingId, why: "related" })),
          filter: null,
          followups: [],
        })
      )),
      Effect.provide(MockKb({
        search: ["7", "8", "9"], // 7 is the anchor (top hit for the named course)
        listings: [
          listing("100", "7", "Grant Writing I"),
          listing("200", "8", "Grant Writing II"),
          listing("300", "9", "Fundraising Basics"),
        ],
        cards: [
          card("100", "7", "Grant Writing I", 1000),
          card("200", "8", "Grant Writing II", 2000),
          card("300", "9", "Fundraising Basics", 3000),
        ],
      })),
    ));

  it("answerEvents emits filter → prose → card → window → done in order", () => {
    const result: Agent.AnswerResult = {
      refused: false,
      answer: new Answer({
        prose: "one two three four five six seven",
        cards: [new CardRef({ listingId: "100" as ListingId, why: "w" })],
        filter: null,
        followups: [],
      }),
      cards: [card("100", "7", "Grant Writing I", 41500)],
      window: { observingSince: "2026-07-16", termsObserved: 1 },
      history: null,
    };
    const tags = Agent.answerEvents(result).map((e) => e._tag);
    expect(tags[0]).toBe("filter");
    expect(tags[tags.length - 1]).toBe("done");
    expect(tags).toContain("prose");
    expect(tags).toContain("card");
    expect(tags).toContain("window");
  });

  // ── Phase 7: the temporal (history) route ────────────────────────────────────
  const history = (termsSeen: number, terms: CourseHistory["terms"]): CourseHistory => ({
    courseId: "7" as CourseId,
    courseTitle: "PMP Certification Program",
    terms,
    changes: [],
    termsSeen,
    window: { observingSince: "2024-09-05", termsObserved: 3 },
  });

  const term = (season: CourseHistory["terms"][number]["season"], year: number, fee: number) => ({
    term: `${season} ${year}`,
    season,
    year,
    rank: year * 10 + 4,
    sections: 1,
    minFeeCents: fee,
    maxFeeCents: fee,
    statuses: ["closed"] as ReadonlyArray<Card["status"]>,
    stillListed: year === 2026,
  });

  const HistoryRoute = MockRouter(
    new RouteDecision({
      filter: null,
      searchQuery: null,
      historyQuery: "PMP Certification Program",
      refuse: false,
    }),
  );

  it.effect("temporal route with ≥2 terms answers grounded, carries the history + timeline", () =>
    Effect.gen(function*() {
      const result = yield* Agent.run("has the PMP program gotten more expensive?", TODAY);
      expect(result.refused).toBe(false);
      expect(result.history).not.toBeNull();
      expect(result.history!.termsSeen).toBe(3);
      // deterministic prose reports the trajectory; the model authored none of it
      expect(result.answer.prose).toContain("PMP Certification Program");
      expect(result.answer.prose).toMatch(/risen from \$395/);
      // the history event rides the SSE sequence, before window
      const tags = Agent.answerEvents(result).map((e) => e._tag);
      expect(tags).toContain("history");
      expect(tags.indexOf("history")).toBeLessThan(tags.indexOf("window"));
      // the temporal facet is already answered — the only follow-up jumps to OTHER courses
      expect(result.answer.followups).toEqual([
        "Show me courses similar to PMP Certification Program",
      ]);
    }).pipe(
      Effect.provide(HistoryRoute),
      Effect.provide(
        MockAnswerer(() => new Answer({ prose: "unused", cards: [], filter: null, followups: [] })),
      ),
      Effect.provide(MockKb({
        search: ["7"],
        history: history(3, [
          term("Fall", 2024, 39500),
          term("Fall", 2025, 41500),
          term("Fall", 2026, 45000),
        ]),
      })),
    ));

  it.effect("temporal route with 1 term answers 'I don't know yet' (§10.6), never refuses", () =>
    Effect.gen(function*() {
      const result = yield* Agent.run("does the PMP program run every year?", TODAY);
      expect(result.refused).toBe(false); // an honest answer, NOT a refusal
      expect(result.history!.termsSeen).toBe(1);
      expect(result.answer.prose).toMatch(/only seen the PMP Certification Program once/i);
      expect(result.answer.prose).toContain("September 2024"); // the observation window bound
    }).pipe(
      Effect.provide(HistoryRoute),
      Effect.provide(
        MockAnswerer(() => new Answer({ prose: "unused", cards: [], filter: null, followups: [] })),
      ),
      Effect.provide(MockKb({
        search: ["7"],
        history: history(1, [term("Fall", 2026, 45000)]),
      })),
    ));
});
