import {
  AnswerError,
  EmbedError,
  ExtractError,
  JudgeError,
  KnowledgeBaseError,
  PageFetchError,
  RerankError,
} from "@catalog/domain/errors";
import * as Match from "effect/Match";

// The union of internal (non-wire) failures the app can surface, and an
// exhaustive human-readable formatter — the ccpd `Match.typeTags` idiom (§6.3).
// Add a member here and the compiler forces a new formatter branch.
export type AppError =
  | EmbedError
  | ExtractError
  | RerankError
  | AnswerError
  | PageFetchError
  | KnowledgeBaseError
  | JudgeError;

export const formatError = Match.typeTags<AppError>()({
  EmbedError: (e) => `Embedding failed: ${e.message}`,
  ExtractError: (e) => `Extraction failed: ${e.message}`,
  RerankError: (e) => `Rerank failed: ${e.message}`,
  AnswerError: (e) => `Answer generation failed: ${e.message}`,
  PageFetchError: (e) => `Fetch failed for ${e.url}: ${e.message}`,
  KnowledgeBaseError: (e) => `Knowledge base error: ${e.message}`,
  JudgeError: (e) => `Judge failed: ${e.message}`,
});
