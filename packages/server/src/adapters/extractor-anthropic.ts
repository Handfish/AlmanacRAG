import { ExtractError } from "@catalog/domain/errors";
import { ExtractedCourse } from "@catalog/domain/extraction";
import { Extractor } from "@catalog/domain/ports/extractor";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import type * as Prompt from "effect/unstable/ai/Prompt";
import { SYSTEM } from "../extraction/prompt.js";
import { LanguageModelLive } from "./ai-anthropic.js";

// The Extractor adapter (architecture.md §9, ADR-I1) — one `generateObject` call
// against the single `ExtractedCourse` schema, decoded by the framework before it
// returns. A decode failure surfaces as `ExtractError` (the orchestration turns it
// into a typed `schema_error` extraction row — never a silent null).
//
// Prompt text + version live in `../extraction/prompt.js`, shared verbatim with the
// Gemini batch path so an ablation compares models, not prompts. Re-exported so
// `extract-page.ts` keeps its existing import site.
export { PROMPT_VERSION } from "../extraction/prompt.js";

const makePrompt = (rawMarkdown: string): ReadonlyArray<Prompt.MessageEncoded> => [
  { role: "system", content: SYSTEM },
  { role: "user", content: `Extract the course from this catalog page:\n\n${rawMarkdown}` },
];

export const ExtractorAnthropicLive = Layer.effect(
  Extractor,
  Effect.gen(function*() {
    // Capture the LanguageModel here (satisfied by LanguageModelLive) and inject it
    // into each call — the adapter closure carries the model, not its callers.
    const languageModel = yield* LanguageModel.LanguageModel;
    return {
      extract: ({ rawMarkdown }) =>
        LanguageModel.generateObject({
          schema: ExtractedCourse,
          objectName: "course_listing",
          prompt: makePrompt(rawMarkdown),
        }).pipe(
          Effect.provideService(LanguageModel.LanguageModel, languageModel),
          Effect.map((response) => response.value),
          Effect.mapError((cause) =>
            new ExtractError({ message: "structured extraction failed", cause })
          ),
        ),
    };
  }),
).pipe(Layer.provide(LanguageModelLive));
