import * as Data from "effect/Data";
import * as Schema from "effect/Schema";

// ── Internal failures (Data.TaggedError) ─────────────────────────────────────
// Live on the Effect error channel inside the app, matched exhaustively with
// Match.typeTags, never serialized. (plan §6.1/§6.3)

export class EmbedError extends Data.TaggedError("EmbedError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ExtractError extends Data.TaggedError("ExtractError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class RerankError extends Data.TaggedError("RerankError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class AnswerError extends Data.TaggedError("AnswerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class PageFetchError extends Data.TaggedError("PageFetchError")<{
  readonly url: string;
  readonly message: string;
  readonly status?: number;
}> {}

export class KnowledgeBaseError extends Data.TaggedError("KnowledgeBaseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class JudgeError extends Data.TaggedError("JudgeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class RouterError extends Data.TaggedError("RouterError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// ── Wire-crossing failures (Schema.TaggedErrorClass) ─────────────────────────
// Serialized across the HTTP boundary so the client can decode them.
// (plan §6.3; effect-ai-chat `ChatNotFoundError` idiom)

export class NotFound extends Schema.TaggedErrorClass<NotFound>()("NotFound", {
  entity: Schema.String,
  id: Schema.String,
}) {}

export class BadRequest extends Schema.TaggedErrorClass<BadRequest>()("BadRequest", {
  message: Schema.String,
}) {}
