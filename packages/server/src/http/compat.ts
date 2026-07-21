import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { randomUUID } from "node:crypto";
import * as Agent from "../agent/answer-agent.js";

// The secondary surface (architecture.md §10.5): an OpenAI-compatible
// `/v1/chat/completions` (+ `/v1/models`) so Open WebUI, LibreChat, or a bare `curl`
// can point at the catalog with zero UI code — "an interop and dogfooding surface, not
// the product." It runs the SAME answer agent as the Astro surface, so the §1 guarantee
// still holds: facts are hydrated from Postgres, the model authored only prose + `why`.
//
// The honest limitation (§10.5): this transport cannot render CARDS. It degrades to a
// markdown TABLE — the presentation is forfeited, but the DATA is still live-hydrated
// (status/fees read at render, §10.4). Register buttons become the real path (a keyword
// to search or a detail link), never an invented affordance (§10.1/ADR-008).
//
// Stateless by design: unlike `/chat`, there is no session lock or transcript — each
// request is independent (the OpenAI client owns its own history), so this file needs
// only the agent ports, not the chat repo.

// ── OpenAI wire envelopes (pure) ──────────────────────────────────────────────────
const MODEL_ID = "almanac-catalog";

interface OaMessage {
  readonly role: string;
  readonly content: string;
}

/** The last user turn is the question (an OpenAI client sends the whole history; the
 * agent is stateless, so only the latest user message drives this turn). Falls back to
 * the last message of any role, then empty. */
export const lastUserMessage = (messages: ReadonlyArray<OaMessage>): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m !== undefined && m.role === "user" && typeof m.content === "string") return m.content;
  }
  const last = messages[messages.length - 1];
  return last !== undefined && typeof last.content === "string" ? last.content : "";
};

const feeStr = (cents: number | null): string =>
  cents === null ? "—" : `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

const dateStr = (card: Agent.AnswerResult["cards"][number]): string =>
  card.startsOn === null
    ? "—"
    : card.endsOn === null
    ? card.startsOn
    : `${card.startsOn}–${card.endsOn}`;

/** A markdown cell: escape pipes/newlines so the table stays well-formed. */
const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();

/** The §1 guarantee as markdown (§10.5): prose, then a live-hydrated table of the
 * cards (no fabricated fields — every value read from Postgres), then the observation
 * window. Cards degrade to rows; the "View details" link is the real path (§10.1). */
export const renderAnswerMarkdown = (result: Agent.AnswerResult): string => {
  const parts: Array<string> = [];
  if (result.answer.prose.trim().length > 0) parts.push(result.answer.prose.trim());

  if (result.cards.length > 0) {
    const header = "| Course | Term | Campus | Mode | Status | Fee | Dates | Details |";
    const sep = "| --- | --- | --- | --- | --- | --- | --- | --- |";
    const rows = result.cards.map((c) => {
      const link = c.registrationUrl ?? c.detailUrl;
      const details = c.registrationKeyword !== null
        ? `search “${cell(c.registrationKeyword)}”`
        : `[view](${link})`;
      return `| ${cell(c.courseTitle)} | ${cell(c.term ?? "—")} | ${cell(c.campus)} | ${
        cell(c.deliveryMode)
      } | ${cell(c.status)} | ${feeStr(c.totalFeeCents)} | ${cell(dateStr(c))} | ${details} |`;
    });
    parts.push([header, sep, ...rows].join("\n"));
  }

  const w = result.window;
  parts.push(
    `_Observing this catalog since ${w.observingSince} (${w.termsObserved} term${
      w.termsObserved === 1 ? "" : "s"
    } seen). Facts read live from the catalog database — the assistant does not retype them._`,
  );
  return parts.join("\n\n");
};

/** A non-streaming `chat.completion` envelope. */
export const completionEnvelope = (
  content: string,
  model: string,
  created: number,
  id: string,
): unknown => ({
  id,
  object: "chat.completion",
  created,
  model,
  choices: [{
    index: 0,
    message: { role: "assistant", content },
    finish_reason: "stop",
  }],
  usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
});

/** One streaming `chat.completion.chunk` envelope. */
export const chunkEnvelope = (
  delta: Record<string, unknown>,
  model: string,
  created: number,
  id: string,
  finishReason: string | null,
): unknown => ({
  id,
  object: "chat.completion.chunk",
  created,
  model,
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});

/** Chunk a markdown string into a handful of streamed content deltas (§10.5 streams
 * prose as text deltas). Splits on lines to keep the markdown table intact per frame. */
const contentDeltas = (content: string): ReadonlyArray<string> => {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  const out: Array<string> = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(i === lines.length - 1 ? lines[i]! : `${lines[i]!}\n`);
  }
  return out;
};

// ── request parsing (raw route — no schema decode in the path) ────────────────────
interface ParsedRequest {
  readonly question: string;
  readonly stream: boolean;
  readonly model: string;
}

const parseRequest = (text: string): ParsedRequest => {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    const messages = Array.isArray(o.messages) ? (o.messages as ReadonlyArray<OaMessage>) : [];
    return {
      question: lastUserMessage(messages),
      stream: o.stream === true,
      model: typeof o.model === "string" ? o.model : MODEL_ID,
    };
  } catch {
    return { question: "", stream: false, model: MODEL_ID };
  }
};

const utf8 = new TextEncoder();
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

// ── routes ────────────────────────────────────────────────────────────────────────
const completionsHandler = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const body = yield* request.text.pipe(Effect.catchCause(() => Effect.succeed("{}")));
  const { model, question, stream } = parseRequest(body);
  const id = `chatcmpl-${randomUUID()}`;
  const created = nowSeconds();

  if (question.trim().length === 0) {
    return HttpServerResponse.text("missing user message", { status: 400 });
  }

  // Run the same agent as the Astro surface; a fault degrades to an apology completion
  // (a valid envelope) rather than an HTTP 500, so OpenAI clients never break mid-stream.
  const content = yield* Agent.run(question, new Date()).pipe(
    Effect.map(renderAnswerMarkdown),
    Effect.catchCause(() =>
      Effect.succeed("The assistant is temporarily unavailable — please retry.")
    ),
  );

  if (!stream) {
    return HttpServerResponse.jsonUnsafe(completionEnvelope(content, model, created, id));
  }

  // Streaming: role frame → content deltas → stop frame → [DONE].
  const frames: Array<string> = [];
  const push = (v: unknown) => frames.push(`data: ${JSON.stringify(v)}\n\n`);
  push(chunkEnvelope({ role: "assistant" }, model, created, id, null));
  for (const delta of contentDeltas(content)) {
    push(chunkEnvelope({ content: delta }, model, created, id, null));
  }
  push(chunkEnvelope({}, model, created, id, "stop"));
  frames.push("data: [DONE]\n\n");

  const bytes = Stream.fromIterable(frames).pipe(Stream.map((f) => utf8.encode(f)));
  return HttpServerResponse.stream(bytes, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
});

// `GET /v1/models` — Open WebUI queries this on connect to populate its model picker.
const modelsResponse = {
  object: "list",
  data: [{ id: MODEL_ID, object: "model", created: 0, owned_by: "almanac" }],
};

/** The compat routes as a layer, merged into the served router by `main.ts`. Requires the
 * agent ports (provided there); `HttpRouter` comes from `HttpRouter.serve`. */
export const CompatRoutesLive = Layer.mergeAll(
  HttpRouter.add("POST", "/v1/chat/completions", completionsHandler),
  HttpRouter.add("GET", "/v1/models", HttpServerResponse.jsonUnsafe(modelsResponse)),
);
