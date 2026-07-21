import { describe, expect, it } from "@effect/vitest";
import { decodeAnswer } from "./answerer-prompt.js";

// The §1/ADR-008 guarantee, asserted (not scored, §11.2): no factual field can leave the
// model. `decodeAnswer` is the choke point — it re-shapes the raw model JSON into the
// domain `Answer`, whose cards are `{ listingId, why }` and NOTHING else. A model that
// tries to smuggle a price/date/status into a card has those fields dropped on the floor,
// and a card citing a listingId that was not a candidate is dropped entirely (grounding).

const allowed = new Set(["10", "20", "30"]);

describe("decodeAnswer — ADR-008 grounding", () => {
  it("drops every non-{listingId,why} field a card tries to smuggle", () => {
    const raw = {
      prose: "Two options.",
      cards: [
        {
          listingId: "10",
          why: "matches your topic",
          // the model tries to emit facts — these MUST NOT survive:
          price: "$415",
          status: "open",
          startsOn: "2026-07-20",
          totalFeeCents: 41500,
        },
      ],
      followups: [],
    };
    const answer = decodeAnswer(raw, allowed);
    expect(answer.cards.length).toBe(1);
    // The decoded CardRef has EXACTLY these keys — no fact can ride along.
    expect(Object.keys({ ...answer.cards[0] }).sort()).toEqual(["listingId", "why"]);
    expect(answer.cards[0]!.listingId as string).toBe("10");
    expect(answer.cards[0]!.why).toBe("matches your topic");
  });

  it("drops cards citing a listingId that was not a candidate (grounding)", () => {
    const raw = {
      prose: "",
      cards: [
        { listingId: "10", why: "real" },
        { listingId: "999", why: "hallucinated — not a candidate" },
      ],
      followups: [],
    };
    const answer = decodeAnswer(raw, allowed);
    expect(answer.cards.map((c) => c.listingId as string)).toEqual(["10"]);
  });

  it("dedupes repeated listingIds, keeping first", () => {
    const raw = {
      prose: "",
      cards: [
        { listingId: "20", why: "first" },
        { listingId: "20", why: "dup" },
        { listingId: "30", why: "third" },
      ],
      followups: [],
    };
    const answer = decodeAnswer(raw, allowed);
    expect(answer.cards.map((c) => c.listingId as string)).toEqual(["20", "30"]);
    expect(answer.cards[0]!.why).toBe("first");
  });

  it("a grounded refusal is an empty-cards answer, not an error", () => {
    const raw = { prose: "I couldn't find that in the catalog.", cards: [], followups: [] };
    const answer = decodeAnswer(raw, new Set());
    expect(answer.cards).toEqual([]);
    expect(answer.prose).toContain("couldn't find");
    expect(answer.filter).toBe(null); // the agent echoes the router's filter, not the answerer's
  });

  it("trims and caps followups at 3", () => {
    const raw = {
      prose: "",
      cards: [],
      followups: ["  a  ", "b", "", "c", "d"],
    };
    const answer = decodeAnswer(raw, new Set());
    expect(answer.followups).toEqual(["a", "b", "c"]);
  });

  it("survives a malformed response (missing fields) without throwing", () => {
    expect(decodeAnswer({}, allowed).cards).toEqual([]);
    expect(decodeAnswer(null, allowed).prose).toBe("");
    expect(decodeAnswer({ cards: "not an array" }, allowed).cards).toEqual([]);
  });
});
