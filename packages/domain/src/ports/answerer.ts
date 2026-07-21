import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Answer } from "../answer.js";
import type { AnswerError } from "../errors.js";
import type { ListingId } from "../ids.js";

// The generation seam (§8/§10, Phase 5). The adapter composes the final structured
// `Answer` over a set of already-retrieved candidate listings — it does NOT retrieve
// (the agent does that via the router + KnowledgeBase, §8) and it does NOT hydrate
// (the server does, §10.4). Its only job is to choose which candidates answer the
// question, write one line of `why` per card, and connective prose.
//
// The `Answer` schema has no price/date/status field (see answer.ts), so ADR-008 is
// enforced by construction regardless of what the model is shown: the candidate
// summaries below may contain facts for the model to REASON over, but the model can
// only EMIT `listingId`s and prose. A grounded refusal (§10.6) is an `Answer` with
// empty `cards` and honest prose — not an exception.

/** A retrieved listing offered to the model as a candidate answer. The `summary` is a
 * compact fact line (term · campus · mode · status · hours · fee) the model reasons
 * over to pick and explain cards — it is never echoed back verbatim as a fact. */
export type AnswerCandidate = {
  readonly listingId: ListingId;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly summary: string;
};

export type AnswererShape = {
  readonly answer: (
    question: string,
    candidates: ReadonlyArray<AnswerCandidate>,
  ) => Effect.Effect<Answer, AnswerError>;
};

export class Answerer extends Context.Service<Answerer, AnswererShape>()("catalog/Answerer") {}
