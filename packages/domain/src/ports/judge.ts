import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { JudgeError } from "../errors.js";

// Eval-only LLM judge (frontier model, §11.3). Scores prose faithfulness (§11.2): does
// the answer's prose assert anything the RETRIEVED rows don't support? Because our prose
// is deliberately fact-free (facts live on hydrated cards, ADR-008), the judge checks the
// connective prose + each card's one-line `why` against the facts actually retrieved —
// catching a claim like "the cheapest option" when it isn't, or a course attribute the
// rows don't show. `context` is the retrieved facts rendered as text; an answer that
// invents a course or a property scores `faithful: false`.

export type Verdict = {
  readonly faithful: boolean;
  readonly score: number; // 0..1
  readonly rationale: string;
};

export type JudgeShape = {
  readonly judge: (
    question: string,
    prose: string,
    context: string,
  ) => Effect.Effect<Verdict, JudgeError>;
};

export class Judge extends Context.Service<Judge, JudgeShape>()("catalog/Judge") {}
