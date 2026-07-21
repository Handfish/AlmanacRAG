import { BadRequest } from "@catalog/domain/errors";
import { ListingFilter } from "@catalog/domain/filter";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { encoder as sseEncoder } from "effect/unstable/encoding/Sse";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import type { SqlClient } from "effect/unstable/sql/SqlClient";
import { randomUUID } from "node:crypto";
import * as Agent from "../agent/answer-agent.js";
import {
  acquireRun,
  ensureSession,
  insertAssistantMessage,
  insertFeedback,
  insertUserMessage,
  promoteFeedbackToEval,
  releaseRun,
} from "../db/repos/chat.js";
import { canonicalFilter } from "../eval/filter-compare.js";

// The chat surface (§10, Phase 5). Two transports over ONE agent (agent/answer-agent.ts):
//   • POST /chat        — JSON: the whole hydrated answer at once (the programmatic /
//     Astro-friendly surface; §10.5 primary).
//   • POST /chat/stream — SSE: the typed §10.3 event sequence (filter/prose/card/window/
//     done). A raw HttpRouter route, since HttpApi models one typed body, not a stream.
//   • POST /feedback    — thumbs up/down → `feedback` (§5.5, the eval-promotion loop).
//
// Both answer transports go through `answerAndPersist`, which holds the single-active-run
// lock (plan §10) and writes the transcript as `card_ids` (never card contents — replay
// re-hydrates live, §5.5). Cards on the wire carry live facts read from Postgres AFTER
// generation; the model authored only `why` (ADR-008).

// ── wire schemas ─────────────────────────────────────────────────────────────────
const CardFeeWire = Schema.Struct({
  label: Schema.String,
  amountCents: Schema.Int,
  isTotal: Schema.Boolean,
});

export const CardWire = Schema.Struct({
  listingId: Schema.String,
  courseId: Schema.String,
  courseTitle: Schema.String,
  externalCourseId: Schema.NullOr(Schema.String),
  track: Schema.NullOr(Schema.String),
  contactHours: Schema.NullOr(Schema.Number),
  deliveryMode: Schema.String,
  campus: Schema.String,
  term: Schema.NullOr(Schema.String),
  startsOn: Schema.NullOr(Schema.String),
  endsOn: Schema.NullOr(Schema.String),
  isEvening: Schema.NullOr(Schema.Boolean),
  scheduleText: Schema.NullOr(Schema.String),
  status: Schema.String,
  totalFeeCents: Schema.NullOr(Schema.Int),
  fees: Schema.Array(CardFeeWire),
  registrationDeadline: Schema.NullOr(Schema.String),
  registrationDeadlineRule: Schema.NullOr(Schema.String),
  registrationUrl: Schema.NullOr(Schema.String),
  registrationKeyword: Schema.NullOr(Schema.String),
  detailUrl: Schema.String,
  checkedAt: Schema.String,
  why: Schema.String,
});

const WindowWire = Schema.Struct({
  observingSince: Schema.String,
  termsObserved: Schema.Int,
});

const ChatRequest = Schema.Struct({
  question: Schema.String,
  sessionId: Schema.optional(Schema.String),
});

const ChatResponse = Schema.Struct({
  sessionId: Schema.String,
  messageId: Schema.String,
  refused: Schema.Boolean,
  prose: Schema.String,
  filter: Schema.NullOr(ListingFilter),
  cards: Schema.Array(CardWire),
  followups: Schema.Array(Schema.String),
  window: WindowWire,
});

const FeedbackRequest = Schema.Struct({
  messageId: Schema.String,
  rating: Schema.Literals([1, -1]),
  note: Schema.optional(Schema.String),
});

const FeedbackResponse = Schema.Struct({
  ok: Schema.Literal(true),
  // §5.5: a thumbs-down promotes the question to a candidate eval_item; the id is
  // returned so the surface can show "added to the review queue". Null for a thumbs-up
  // or when there is no answerable question to promote.
  promotedEvalItemId: Schema.NullOr(Schema.String),
});

// ── groups ───────────────────────────────────────────────────────────────────────
export class ChatGroup extends HttpApiGroup.make("chat").add(
  HttpApiEndpoint.post("chat", "/chat", {
    payload: ChatRequest,
    success: ChatResponse,
    error: BadRequest, // single-active-run: a busy session (§10)
  }),
) {}

export class FeedbackGroup extends HttpApiGroup.make("feedback").add(
  HttpApiEndpoint.post("feedback", "/feedback", {
    payload: FeedbackRequest,
    success: FeedbackResponse,
  }),
) {}

// ── the shared answer-and-persist effect (lock + transcript) ──────────────────────
export interface Persisted {
  readonly sessionId: string;
  readonly messageId: string;
  readonly result: Agent.AnswerResult;
}

/** Answer one turn under the single-active-run lock (plan §10). Fails with `BadRequest`
 * if another request already holds this session's lock; agent/SQL faults `orDie` (500).
 * `today` is the wall clock (relative dates resolve to "now" for the live surface). */
const answerAndPersist = (
  question: string,
  sessionIdOpt: string | undefined,
): Effect.Effect<
  Persisted,
  BadRequest,
  Agent.AgentR | SqlClient
> =>
  Effect.gen(function*() {
    const sessionId = sessionIdOpt ?? randomUUID();
    yield* ensureSession(sessionId).pipe(Effect.orDie);
    const runToken = randomUUID();
    const held = yield* acquireRun(sessionId, runToken).pipe(Effect.orDie);
    if (Option.isNone(held)) {
      return yield* Effect.fail(
        new BadRequest({ message: "session busy — a previous turn is still answering" }),
      );
    }
    return yield* Effect.gen(function*() {
      yield* insertUserMessage(sessionId, question).pipe(Effect.orDie);
      const result = yield* Agent.run(question, new Date()).pipe(Effect.orDie);
      const traceId = randomUUID();
      const messageId = yield* insertAssistantMessage(
        sessionId,
        result.answer,
        result.cards,
        result.refused,
        traceId,
      ).pipe(Effect.orDie);
      return { sessionId, messageId, result } satisfies Persisted;
    }).pipe(Effect.ensuring(releaseRun(sessionId, runToken).pipe(Effect.orDie)));
  });

// ── typed handler effects (wired into the api by http/api.ts) ─────────────────────
// The group handlers are built in http/api.ts where `CatalogApi` is concrete; these are
// the effects they run. Keeping them here keeps the agent/persistence wiring next to the
// schemas and out of api.ts.

/** POST /chat — the JSON handler effect. */
export const chatEffect = (payload: typeof ChatRequest.Type) =>
  Effect.gen(function*() {
    const { messageId, result, sessionId } = yield* answerAndPersist(
      payload.question,
      payload.sessionId,
    );
    return {
      sessionId,
      messageId,
      refused: result.refused,
      prose: result.answer.prose,
      filter: result.answer.filter,
      cards: result.cards,
      followups: result.answer.followups,
      window: result.window,
    };
  });

/** POST /feedback — record thumbs up/down (§5.5). A thumbs-down (`rating === -1`) also
 * promotes the question to a candidate `eval_item` (the §5.5 loop). SQL faults `orDie`. */
export const feedbackEffect = (payload: typeof FeedbackRequest.Type) =>
  Effect.gen(function*() {
    yield* insertFeedback(payload.messageId, payload.rating, payload.note ?? null).pipe(
      Effect.orDie,
    );
    const promoted = payload.rating === -1
      ? yield* promoteFeedbackToEval(payload.messageId, payload.note ?? null).pipe(Effect.orDie)
      : Option.none<string>();
    return { ok: true as const, promotedEvalItemId: Option.getOrNull(promoted) };
  });

// ── SSE route (§10.3) — raw, because HttpApi models one typed body, not a stream ──
const utf8 = new TextEncoder();

/** One typed §10.3 event → an SSE frame. `filter`/`window`/`done` carry JSON; `prose`
 * carries a text delta; `card` carries the fully hydrated card (live facts). */
const encodeEvent = (event: Agent.AnswerEvent): string => {
  const data = (() => {
    switch (event._tag) {
      case "filter":
        return event.filter === null ? "null" : canonicalFilter(event.filter);
      case "prose":
        return JSON.stringify({ delta: event.delta });
      case "card":
        return JSON.stringify(event.card);
      case "history":
        return JSON.stringify(event.history);
      case "window":
        return JSON.stringify(event.window);
      case "done":
        return JSON.stringify({ refused: event.refused, cardCount: event.cardCount });
    }
  })();
  return sseEncoder.write({ _tag: "Event", event: event._tag, id: undefined, data });
};

/** Parse the SSE request body defensively (a raw route — no schema decode in the path). */
const parseBody = (text: string): { question: string; sessionId: string | undefined; } => {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    return {
      question: typeof o.question === "string" ? o.question : "",
      sessionId: typeof o.sessionId === "string" ? o.sessionId : undefined,
    };
  } catch {
    return { question: "", sessionId: undefined };
  }
};

const sseHandler = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const text = yield* request.text.pipe(Effect.catchCause(() => Effect.succeed("{}")));
  const body = parseBody(text);
  if (body.question.trim().length === 0) {
    return HttpServerResponse.text("missing question", { status: 400 });
  }
  // Compute + persist the whole answer, then stream its events. (The client gets typed
  // §10.3 events; token-by-token generation is a Phase-6 UX refinement.) Any failure —
  // a busy session (`BadRequest`) or a transient provider fault (an orDie'd defect, e.g.
  // a Gemini 503) — degrades to a graceful error `prose` + `done` rather than an empty
  // 500 mid-stream, so the client always sees a well-formed SSE sequence.
  const errorEvents = (message: string): ReadonlyArray<Agent.AnswerEvent> => [
    { _tag: "prose", delta: message },
    { _tag: "done", refused: true, cardCount: 0 },
  ];
  const events: ReadonlyArray<Agent.AnswerEvent> = yield* answerAndPersist(
    body.question,
    body.sessionId,
  ).pipe(
    Effect.map((p) => Agent.answerEvents(p.result)),
    Effect.catchTag("BadRequest", (e) => Effect.succeed(errorEvents(e.message))),
    Effect.catchCause(() =>
      Effect.succeed(errorEvents("The assistant is temporarily unavailable — please retry."))
    ),
  );
  const bytes = Stream.fromIterable(events).pipe(
    Stream.map((e) => utf8.encode(encodeEvent(e))),
  );
  return HttpServerResponse.stream(bytes, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
});

/** The SSE route as a layer, merged into the served router by `main.ts`. Requires the
 * agent ports + SqlClient (provided there); `HttpRouter` is provided by `HttpRouter.serve`. */
export const ChatSseRouteLive = HttpRouter.add("POST", "/chat/stream", sseHandler);
