import { Answer } from "@catalog/domain/answer";
import { AnswerError } from "@catalog/domain/errors";
import { Answerer } from "@catalog/domain/ports/answerer";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CHAT_MAX_OUTPUT_TOKENS, GeminiApiKey, generateJson } from "./ai-gemini.js";
import {
  ANSWER_RESPONSE_SCHEMA,
  answererUserPrompt,
  decodeAnswer,
  SYSTEM,
} from "./answerer-prompt.js";

// The Gemini answerer adapter (§10, ADR-008) — the generation seam. Same REST surface,
// key, and structured-output path as the router/extractor (ai-gemini.ts), so the §11.5
// ablation compares models cleanly. It composes the final `Answer` over candidates the
// agent already retrieved (it does not retrieve or hydrate). The domain `Answer` decode
// + candidate grounding in `decodeAnswer` is the real guardrail: the model can only emit
// `listingId`s from the candidate set and prose — never a fact (the schema has no fact
// field). Every failure — transport, empty response, unparseable JSON — folds into one
// typed `AnswerError`. An empty-candidate call still runs the model so it produces an
// honest grounded refusal (§10.6) rather than a canned string.

/** The answer model. Cheap tier by default (consistent with router/extraction); override
 * to run the §11.5 ablation "answer model" row. */
export const AnswererModel = Config.string("ANSWERER_MODEL").pipe(
  Config.withDefault("gemini-3.1-flash-lite"),
);

export const AnswererGeminiLive = Layer.effect(
  Answerer,
  Effect.gen(function*() {
    const apiKey = yield* GeminiApiKey;
    const model = yield* AnswererModel;

    return {
      answer: (question, candidates) => {
        const allowed = new Set(candidates.map((c) => c.listingId as string));
        return generateJson(
          apiKey,
          model,
          SYSTEM,
          answererUserPrompt(question, candidates),
          ANSWER_RESPONSE_SCHEMA,
          CHAT_MAX_OUTPUT_TOKENS,
        ).pipe(
          Effect.flatMap((res) => {
            if (res.text === null) {
              // No usable generation → an honest empty answer, not a crash (§10.6).
              return Effect.succeed(
                new Answer({ prose: "", cards: [], filter: null, followups: [] }),
              );
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(res.text);
            } catch (cause) {
              return Effect.fail(new AnswerError({ message: "answer JSON parse failed", cause }));
            }
            return Effect.succeed(decodeAnswer(parsed, allowed));
          }),
          Effect.catchTag(
            "GeminiBatchError",
            (cause) => Effect.fail(new AnswerError({ message: "answer call failed", cause })),
          ),
        );
      },
    };
  }),
);
