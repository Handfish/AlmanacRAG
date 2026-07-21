import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { generateText } from "../adapters/ai-gemini.js";
import type { CourseChunkSource } from "./chunk-text.js";

// Contextual retrieval (architecture.md §7.3): before embedding, a cheap model writes
// a one-sentence situating prefix per chunk — "Continuing-education course in the
// Effective School Practices unit on teaching numeracy across content areas, offered
// online." — stored in `chunk.context_prefix` and prepended for BOTH the embedding and
// the `tsv`. Under a dollar for the whole corpus; a clean single-variable §11.5
// ablation row. It NEVER blocks indexing: any failure (or a missing key) degrades to a
// null prefix, and the chunk still embeds + indexes off its `text` alone.

export const CONTEXT_SYSTEM =
  `You write ONE short sentence that situates a continuing-education course for search retrieval. Name the subject area, the audience/program if given, and the delivery context. Output only the sentence — no preamble, no quotes, no list. Maximum 40 words.`;

export const buildContextPrompt = (course: CourseChunkSource): string =>
  [
    `Title: ${course.courseTitle}`,
    `Program: ${course.program ?? "—"}`,
    `Subject: ${course.subject ?? "—"}`,
    `Track: ${course.track ?? "—"}`,
    `Audience: ${course.audience ?? "—"}`,
    `Description: ${(course.description ?? "—").slice(0, 700)}`,
  ].join("\n");

/**
 * A situating prefix for one course, or null if generation is unavailable/failed.
 * Total function on the success channel — the caller treats null as "no prefix".
 */
export const generateContextPrefix = (
  apiKey: Redacted.Redacted<string>,
  model: string,
  course: CourseChunkSource,
): Effect.Effect<string | null> =>
  generateText(apiKey, model, CONTEXT_SYSTEM, buildContextPrompt(course)).pipe(
    Effect.map((text) => {
      if (text === null) return null;
      const cleaned = text.replace(/\s+/g, " ").trim();
      return cleaned.length > 0 ? cleaned.slice(0, 500) : null;
    }),
    // Never block indexing on a prefix miss: any transport/model failure → no prefix.
    Effect.catchTag("GeminiBatchError", () => Effect.succeed(null)),
  );
