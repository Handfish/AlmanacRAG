import type { Answer, Card, ObservationWindow } from "@catalog/domain/answer";
import { Answer as AnswerClass, CardRef } from "@catalog/domain/answer";
import type { AnswerError, KnowledgeBaseError, RouterError } from "@catalog/domain/errors";
import type { ListingFilter } from "@catalog/domain/filter";
import type { CourseHistory } from "@catalog/domain/history";
import type { CourseId, ListingId } from "@catalog/domain/ids";
import type { AnswerCandidate } from "@catalog/domain/ports/answerer";
import { Answerer } from "@catalog/domain/ports/answerer";
import type { FilteredListing } from "@catalog/domain/ports/knowledge-base";
import { KnowledgeBase } from "@catalog/domain/ports/knowledge-base";
import { Router } from "@catalog/domain/ports/router";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { composeHistory, type HistoryVerdict } from "../history/format-history.js";

// The answer agent (§8/§10, Phase 5) — the router in front of retrieval in front of the
// generation seam, exactly as §8 draws it: hard predicates → filter_listings, soft
// predicate → search_catalog, intersect on course_id, "the naive plan is fine". It owns
// the whole path so the HTTP layer (JSON + SSE) and the eval runner share one
// implementation.
//
// The §1 guarantee lives in the ORDER of operations: the model only ever sees candidate
// listingIds + compact summaries and only ever emits listingIds + prose (ADR-008); every
// fact on the returned cards is read from Postgres by `hydrate` AFTER generation (§10.4).
// The router's filter is echoed as the answer's chips (§10.2), never re-derived by the
// answerer. A grounded refusal (§10.6) is a normal result with empty cards.

const CANDIDATE_LIMIT = 8; // cards offered to the model / returned (§10.1 — a short list)
const SEARCH_K = 12; // soft-search course hits before intersect

export interface AnswerResult {
  readonly refused: boolean;
  readonly answer: Answer; // prose, card refs, echoed filter, followups
  readonly cards: ReadonlyArray<Card>; // hydrated live, with the model's `why` attached
  readonly window: ObservationWindow;
  readonly history: CourseHistory | null; // Phase 7 — set on a temporal (course_history) answer
}

export type AgentR = Router | KnowledgeBase | Answerer;
export type AgentE = RouterError | KnowledgeBaseError | AnswerError;

const dollars = (cents: number | null): string =>
  cents === null ? "" : ` · $${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

/** Compact one-line facts for the model to REASON over (never echoed — the schema has no
 * fact field, and the hydrate step is the source of truth). */
const summarize = (l: FilteredListing): string => {
  const parts = [
    l.term ?? "term n/a",
    l.campus,
    l.deliveryMode,
    l.status,
    l.isEvening === true ? "evening" : null,
    l.contactHours !== null ? `${l.contactHours}h` : null,
  ].filter((p): p is string => p !== null && p !== "");
  return `${parts.join(" · ")}${dollars(l.totalFeeCents)}`;
};

const toCandidate = (l: FilteredListing): AnswerCandidate => ({
  listingId: l.listingId,
  courseId: l.courseId as string,
  courseTitle: l.courseTitle,
  summary: summarize(l),
});

/** §8 decomposition: run the two independent halves and intersect on course_id. Returns
 * candidate listings, best-first, capped. */
const retrieve = (
  filter: ListingFilter | null,
  searchQuery: string | null,
): Effect.Effect<ReadonlyArray<FilteredListing>, KnowledgeBaseError, KnowledgeBase> =>
  Effect.gen(function*() {
    const kb = yield* KnowledgeBase;

    const filtered = filter !== null ? yield* kb.filterListings(filter, 400) : [];

    let searched: ReadonlyArray<FilteredListing> = [];
    let searchOrder: ReadonlyArray<string> = [];
    if (searchQuery !== null) {
      const hits = yield* kb.search(searchQuery, SEARCH_K);
      searchOrder = hits.map((h) => h.courseId as string);
      searched = yield* kb.listingsForCourses(hits.map((h) => h.courseId as CourseId), 1);
    }

    // Combine per §8. Both halves → intersect on course_id (search order wins); if the
    // intersection is empty, fall back to the hard filter (the binding constraint) so a
    // slightly-off soft query doesn't erase a valid structured result.
    let combined: ReadonlyArray<FilteredListing>;
    if (filter !== null && searchQuery !== null) {
      const searchSet = new Set(searchOrder);
      const rank = new Map(searchOrder.map((id, i) => [id, i]));
      const both = filtered
        .filter((l) => searchSet.has(l.courseId as string))
        .sort((a, b) =>
          (rank.get(a.courseId as string) ?? 0) - (rank.get(b.courseId as string) ?? 0)
        );
      combined = both.length > 0 ? both : filtered;
    } else if (filter !== null) {
      combined = filtered;
    } else {
      combined = searched;
    }

    // Distinct by listing, capped.
    const seen = new Set<string>();
    const out: Array<FilteredListing> = [];
    for (const l of combined) {
      const id = l.listingId as string;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(l);
      if (out.length >= CANDIDATE_LIMIT) break;
    }
    return out as ReadonlyArray<FilteredListing>;
  });

// ── History (§8.1 / §5.3.5 / §10.6, Phase 7) ─────────────────────────────────────
export interface HistoryResult {
  readonly history: CourseHistory | null;
  readonly verdict: HistoryVerdict;
  readonly prose: string;
  readonly followups: ReadonlyArray<string>;
  readonly courseId: CourseId | null;
}

/** Resolve a temporal question to a course and compose the honesty-bounded answer. The
 * prose is DETERMINISTIC (composeHistory) — never model-authored — so a recurrence pattern
 * can't be hallucinated from insufficient observation (§10.6). Requires only KnowledgeBase
 * (no Answerer), so the eval can score temporal honesty cheaply and the answer never spends
 * an LLM call on facts the database already knows. */
export const answerHistory = (
  historyQuery: string,
): Effect.Effect<HistoryResult, KnowledgeBaseError, KnowledgeBase> =>
  Effect.gen(function*() {
    const kb = yield* KnowledgeBase;
    // A history question names a specific course; the best hybrid hit is the target.
    const hits = yield* kb.search(historyQuery, 1);
    const courseId = hits[0]?.courseId ?? null;
    const history = courseId === null ? null : yield* kb.courseHistory(courseId);
    const composed = composeHistory(history, historyQuery);
    return {
      history,
      verdict: composed.verdict,
      prose: composed.prose,
      followups: composed.followups,
      courseId,
    };
  });

/** Run the full agent for one question. `today` is passed explicitly (not read from the
 * clock) so relative dates resolve deterministically and the eval is reproducible (§11.3). */
export const run = (
  question: string,
  today: Date,
): Effect.Effect<AnswerResult, AgentE, AgentR> =>
  Effect.gen(function*() {
    const router = yield* Router;
    const answerer = yield* Answerer;
    const kb = yield* KnowledgeBase;

    const route = yield* router.route(question, today);

    // ── Temporal route (§8.1): answer from course_history, bounded by the observation
    // window (§10.6). The prose is deterministic; a live current-offering card (if any)
    // rides along, its facts hydrated live like any other card (ADR-008).
    if (route.historyQuery !== null) {
      const h = yield* answerHistory(route.historyQuery);
      let cards: ReadonlyArray<Card> = [];
      let cardRefs: ReadonlyArray<CardRef> = [];
      if (h.courseId !== null) {
        const live = yield* kb.listingsForCourses([h.courseId], 1);
        const hydrated = yield* kb.hydrate(live.map((l) => l.listingId as ListingId));
        cards = hydrated.map((c): Card => ({ ...c, why: "the current offering" }));
        cardRefs = cards.map((c) => new CardRef({ listingId: c.listingId, why: c.why }));
      }
      const answer = new AnswerClass({
        prose: h.prose,
        cards: cardRefs,
        filter: null,
        followups: h.followups,
      });
      const window = h.history?.window ?? (yield* kb.observationWindow());
      return {
        refused: h.verdict === "not_found",
        answer,
        cards,
        window,
        history: h.history,
      } satisfies AnswerResult;
    }

    const candidates = route.refuse
      ? []
      : (yield* retrieve(route.filter, route.searchQuery)).map(toCandidate);

    const composed = yield* answerer.answer(question, candidates);
    // Echo the router's filter as the chips (§10.2) — authoritative, not the answerer's.
    const answer = new AnswerClass({
      prose: composed.prose,
      cards: composed.cards,
      filter: route.filter,
      followups: composed.followups,
    });

    // Hydrate the chosen cards LIVE and attach the model's one-line `why` (§10.4/§4.2).
    const whyByListing = new Map(answer.cards.map((c) => [c.listingId as string, c.why]));
    const chosenIds = answer.cards.map((c) => c.listingId as ListingId);
    const hydrated = yield* kb.hydrate(chosenIds);
    const cards = hydrated.map((c): Card => ({ ...c, why: whyByListing.get(c.listingId) ?? "" }));

    const window = yield* kb.observationWindow();

    return { refused: route.refuse, answer, cards, window, history: null } satisfies AnswerResult;
  });

// ── Streaming (§10.3) — the typed SSE event union ────────────────────────────────
export type AnswerEvent =
  | { readonly _tag: "filter"; readonly filter: ListingFilter | null; }
  | { readonly _tag: "prose"; readonly delta: string; }
  | { readonly _tag: "card"; readonly card: Card; }
  | { readonly _tag: "history"; readonly history: CourseHistory; } // Phase 7 — the term timeline
  | { readonly _tag: "window"; readonly window: ObservationWindow; }
  | { readonly _tag: "done"; readonly refused: boolean; readonly cardCount: number; };

/** Chunk prose into a few word-grouped deltas so the SSE surface streams text (§10.3)
 * rather than delivering one blob. (Genuine token streaming is a Phase-6 UX refinement;
 * the event contract is what Phase 5 pins down.) */
const proseDeltas = (prose: string): ReadonlyArray<string> => {
  if (prose.length === 0) return [];
  const words = prose.split(/(\s+)/); // keep whitespace tokens so re-joining is lossless
  const deltas: Array<string> = [];
  let buf = "";
  let wordCount = 0;
  for (const tok of words) {
    buf += tok;
    if (/\S/.test(tok)) wordCount++;
    if (wordCount >= 6) {
      deltas.push(buf);
      buf = "";
      wordCount = 0;
    }
  }
  if (buf.length > 0) deltas.push(buf);
  return deltas;
};

/** The ordered §10.3 event sequence for a computed result — shared by `runStream` and
 * the SSE handler (which computes + persists the result first, then streams it). */
export const answerEvents = (result: AnswerResult): ReadonlyArray<AnswerEvent> => [
  { _tag: "filter", filter: result.answer.filter },
  ...proseDeltas(result.answer.prose).map((delta): AnswerEvent => ({ _tag: "prose", delta })),
  ...result.cards.map((card): AnswerEvent => ({ _tag: "card", card })),
  ...(result.history !== null
    ? [{ _tag: "history", history: result.history } as AnswerEvent]
    : []),
  { _tag: "window", window: result.window },
  { _tag: "done", refused: result.refused, cardCount: result.cards.length },
];

/** The agent as a stream of typed §10.3 events. Computes the answer, then emits
 * `filter` → `prose` deltas → `card`s → `window` → `done`. */
export const runStream = (
  question: string,
  today: Date,
): Stream.Stream<AnswerEvent, AgentE, AgentR> =>
  Stream.unwrap(run(question, today).pipe(Effect.map((r) => Stream.fromIterable(answerEvents(r)))));
