import type { Card } from "@catalog/domain/answer";
import { Answer } from "@catalog/domain/answer";
import type { CourseId, ListingId } from "@catalog/domain/ids";
import { describe, expect, it } from "vitest";
import type * as Agent from "../agent/answer-agent.js";
import {
  chunkEnvelope,
  completionEnvelope,
  lastUserMessage,
  renderAnswerMarkdown,
} from "./compat.js";

// The OpenAI-compatible surface (§10.5): a markdown TABLE instead of cards (the honest
// degradation), but every FACT still hydrated from Postgres — the model never retypes a
// number. These are pure-function tests of the rendering + envelope shapes.

const card = (over: Partial<Card>): Card => ({
  listingId: "10" as ListingId,
  courseId: "1" as CourseId,
  courseTitle: "Grant Writing",
  externalCourseId: null,
  track: null,
  contactHours: null,
  deliveryMode: "online_async",
  campus: "Newark",
  term: "Fall 2026",
  startsOn: "2026-09-01",
  endsOn: "2026-10-01",
  isEvening: null,
  scheduleText: null,
  status: "open",
  totalFeeCents: 41500,
  fees: [],
  registrationDeadline: null,
  registrationDeadlineRule: null,
  registrationUrl: null,
  registrationKeyword: null,
  detailUrl: "https://ce-catalog.rutgers.edu/courseDisplay.cfm?schID=10",
  checkedAt: "2026-07-21T00:00:00Z",
  why: "matches grant writing",
  ...over,
});

const result = (cards: ReadonlyArray<Card>, prose: string): Agent.AnswerResult => ({
  refused: false,
  answer: new Answer({ prose, cards: [], filter: null, followups: [] }),
  cards,
  window: { observingSince: "2026-07-16", termsObserved: 1 },
  history: null,
});

describe("compat §10.5", () => {
  it("lastUserMessage picks the newest user turn", () => {
    expect(
      lastUserMessage([
        { role: "user", content: "first" },
        { role: "assistant", content: "reply" },
        { role: "user", content: "second" },
      ]),
    ).toBe("second");
    expect(lastUserMessage([])).toBe("");
  });

  it("renders a markdown table with live-hydrated facts and the observation window", () => {
    const md = renderAnswerMarkdown(result([card({})], "One course matches."));
    expect(md).toContain("One course matches.");
    // table header + a fact row read from the card (not the model)
    expect(md).toContain("| Course | Term | Campus | Mode | Status | Fee | Dates | Details |");
    expect(md).toContain("Grant Writing");
    expect(md).toContain("$415"); // 41500 cents rendered from the fee, not retyped
    expect(md).toContain("2026-09-01–2026-10-01");
    expect(md).toContain("Observing this catalog since 2026-07-16 (1 term seen)");
  });

  it("registration keyword becomes the real path, not an invented button (§10.1)", () => {
    const md = renderAnswerMarkdown(result([card({ registrationKeyword: "Grant" })], "x"));
    expect(md).toContain("search “Grant”");
    expect(md).not.toContain("[view]");
  });

  it("a refusal (no cards) is prose + window, no empty table", () => {
    const md = renderAnswerMarkdown(result([], "That isn't in the catalog."));
    expect(md).toContain("That isn't in the catalog.");
    expect(md).not.toContain("| Course |");
  });

  it("completionEnvelope is a well-formed chat.completion", () => {
    const env = completionEnvelope("hi", "almanac-catalog", 123, "chatcmpl-1") as {
      object: string;
      choices: ReadonlyArray<
        { message: { role: string; content: string; }; finish_reason: string; }
      >;
    };
    expect(env.object).toBe("chat.completion");
    expect(env.choices[0]!.message.content).toBe("hi");
    expect(env.choices[0]!.message.role).toBe("assistant");
    expect(env.choices[0]!.finish_reason).toBe("stop");
  });

  it("chunkEnvelope carries a delta and finish_reason", () => {
    const env = chunkEnvelope({ content: "x" }, "m", 1, "id", null) as {
      object: string;
      choices: ReadonlyArray<{ delta: Record<string, unknown>; finish_reason: string | null; }>;
    };
    expect(env.object).toBe("chat.completion.chunk");
    expect(env.choices[0]!.delta).toEqual({ content: "x" });
    expect(env.choices[0]!.finish_reason).toBeNull();
  });
});
