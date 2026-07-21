import { JudgeError } from "@catalog/domain/errors";
import { Judge, type Verdict } from "@catalog/domain/ports/judge";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GeminiApiKey, generateJson } from "./ai-gemini.js";

// The eval LlmJudge (§11.2/§11.3) — prose faithfulness against the retrieved facts. Same
// Gemini REST surface as the router/answerer (ai-gemini.ts). A FRONTIER model by default
// (not the cheap answer tier): the judge must be at least as capable as the thing it
// grades, or it rubber-stamps. Eval-only — never on the answer path.

/** The judge model. §11.3 wants a FRONTIER tier (a grader at least as capable as what it
 * grades), but on this project's key the frontier flash tiers are unavailable — 2.5-flash
 * is restricted for new API projects and 3.5-flash returns a persistent 503 — the same
 * constraint that already put extraction/router/embeddings on flash-lite. So the default
 * is `gemini-3.1-flash-lite`; set JUDGE_MODEL to a frontier tier the moment the key can
 * reach one (a one-env-var swap — this is why the model is config, §11.5). Because our
 * prose is deliberately fact-light (facts live on hydrated cards, ADR-008), a same-tier
 * judge still catches invented courses and unsupported qualitative claims. */
export const JudgeModel = Config.string("JUDGE_MODEL").pipe(
  Config.withDefault("gemini-3.1-flash-lite"),
);

const SYSTEM =
  `You are a strict grader for a course-catalog assistant. You are given a user QUESTION, the assistant's PROSE answer (connective text plus a one-line "why" per recommended course), and the CONTEXT (the actual course rows the system retrieved, with their real facts).

The assistant is designed to keep hard facts (prices, dates, seat status, hours) OUT of its prose — those are rendered separately from the database. So do NOT penalize the prose for omitting numbers. Judge only whether every CLAIM the prose makes is SUPPORTED by the CONTEXT:
- Does it describe courses that are actually in the context? (Inventing a course or a property → unfaithful.)
- Are qualitative claims ("the shortest", "an evening option", "focused on X") consistent with the retrieved facts? (A superlative that the rows contradict → unfaithful.)
- A grounded refusal ("I couldn't find that") over an EMPTY context is FAITHFUL.

Output ONLY JSON: { "faithful": boolean, "score": number (0..1, how well-supported), "rationale": string (one sentence) }.`;

type G = Record<string, unknown>;
const RESPONSE_SCHEMA: G = {
  type: "OBJECT",
  properties: {
    faithful: { type: "BOOLEAN", nullable: false },
    score: { type: "NUMBER", nullable: false },
    rationale: { type: "STRING", nullable: false },
  },
  required: ["faithful", "score", "rationale"],
  propertyOrdering: ["faithful", "score", "rationale"],
  nullable: false,
};

const get = (o: unknown, k: string): unknown =>
  typeof o === "object" && o !== null && k in o ? (o as Record<string, unknown>)[k] : undefined;

const decodeVerdict = (raw: unknown): Verdict => {
  const score = get(raw, "score");
  const n = typeof score === "number" ? Math.max(0, Math.min(1, score)) : 0;
  return {
    faithful: get(raw, "faithful") === true,
    score: n,
    rationale: typeof get(raw, "rationale") === "string" ? (get(raw, "rationale") as string) : "",
  };
};

export const JudgeGeminiLive = Layer.effect(
  Judge,
  Effect.gen(function*() {
    const apiKey = yield* GeminiApiKey;
    const model = yield* JudgeModel;
    return {
      judge: (question, prose, context) =>
        generateJson(
          apiKey,
          model,
          SYSTEM,
          `QUESTION: ${question}\n\nPROSE:\n${prose || "(empty)"}\n\nCONTEXT (retrieved rows):\n${
            context || "(none retrieved)"
          }`,
          RESPONSE_SCHEMA,
        ).pipe(
          Effect.flatMap((res) => {
            if (res.text === null) {
              return Effect.fail(new JudgeError({ message: "empty judge response" }));
            }
            try {
              return Effect.succeed(decodeVerdict(JSON.parse(res.text)));
            } catch (cause) {
              return Effect.fail(new JudgeError({ message: "judge JSON parse failed", cause }));
            }
          }),
          Effect.catchTag("GeminiBatchError", (cause) =>
            Effect.fail(new JudgeError({ message: "judge call failed", cause }))),
        ),
    };
  }),
);
