import { RouterError } from "@catalog/domain/errors";
import { Router } from "@catalog/domain/ports/router";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GeminiApiKey, generateJson } from "./ai-gemini.js";
import { decodeRoute, ROUTER_RESPONSE_SCHEMA, routerUserPrompt, SYSTEM } from "./router-prompt.js";

// The Gemini router adapter (architecture.md §8) — the query-understanding seam behind
// the `filter_exact` headline. Same REST surface, key, and structured-output path as the
// extractor (ai-gemini.ts), so the ablation compares models cleanly. Temperature 0 (in
// `generateJson`) + a constrained response schema make the parse deterministic; the
// domain `ListingFilter` decode in `decodeRoute` is the real guardrail. Every failure —
// transport, empty response, unparseable JSON — folds into one typed `RouterError`.

/** The router model. Same cheap tier as extraction by default (the restricted
 * 2.5-flash-lite → 3.1-flash-lite, per the project's provider note). Override to run the
 * §11.5 ablation "router model" row. */
export const RouterModel = Config.string("ROUTER_MODEL").pipe(
  Config.withDefault("gemini-3.1-flash-lite"),
);

export const RouterGeminiLive = Layer.effect(
  Router,
  Effect.gen(function*() {
    const apiKey = yield* GeminiApiKey;
    const model = yield* RouterModel;

    return {
      route: (question, today) =>
        generateJson(
          apiKey,
          model,
          SYSTEM,
          routerUserPrompt(question, today),
          ROUTER_RESPONSE_SCHEMA,
        ).pipe(
          Effect.flatMap((res) => {
            if (res.text === null) {
              return Effect.fail(new RouterError({ message: "empty router response" }));
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(res.text);
            } catch (cause) {
              return Effect.fail(new RouterError({ message: "router JSON parse failed", cause }));
            }
            return Effect.succeed(decodeRoute(parsed));
          }),
          Effect.catchTag("GeminiBatchError", (cause) =>
            Effect.fail(new RouterError({ message: "router call failed", cause }))),
        ),
    };
  }),
);
