import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { AnswerError } from "../errors.js";

// The generation seam (Anthropic, §8/§10). The Phase-5 adapter runs the router +
// Toolkit loop and emits the structured `Answer` (whose schema has no price/date/
// status field, so the model *cannot* emit a fact — ADR-008). Streaming lives in
// the adapter; this port is the minimal contract.

export type AnswererShape = {
  readonly answer: (prompt: string) => Effect.Effect<string, AnswerError>;
};

export class Answerer extends Context.Service<Answerer, AnswererShape>()("catalog/Answerer") {}
