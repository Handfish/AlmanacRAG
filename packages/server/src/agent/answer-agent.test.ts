import { Answer, type Card, CardRef } from "@catalog/domain/answer";
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
    listingsForCourses: () => Effect.succeed(opts.listings ?? []),
    hydrate: (ids) =>
      Effect.succeed(
        (opts.cards ?? []).filter((c) =>
          ids.map((i) => i as string).includes(c.listingId as string)
        ),
      ),
    observationWindow: () => Effect.succeed({ observingSince: "2026-07-16", termsObserved: 1 }),
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
        MockRouter(new RouteDecision({ filter: null, searchQuery: null, refuse: true })),
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
    }).pipe(
      Effect.provide(
        MockRouter(
          new RouteDecision({ filter: null, searchQuery: "grant writing", refuse: false }),
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
    };
    const tags = Agent.answerEvents(result).map((e) => e._tag);
    expect(tags[0]).toBe("filter");
    expect(tags[tags.length - 1]).toBe("done");
    expect(tags).toContain("prose");
    expect(tags).toContain("card");
    expect(tags).toContain("window");
  });
});
