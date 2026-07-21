import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { JudgeError } from "../errors.js";

// Eval-only LLM judge (frontier model, §11.3). Scores prose faithfulness so a
// factual claim unsupported by the retrieved rows is caught (§11.2).

export type Verdict = {
  readonly score: number;
  readonly rationale: string;
};

export type JudgeShape = {
  readonly judge: (question: string, answer: string) => Effect.Effect<Verdict, JudgeError>;
};

export class Judge extends Context.Service<Judge, JudgeShape>()("catalog/Judge") {}
