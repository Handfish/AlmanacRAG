import { Answer, CardRef } from "@catalog/domain/answer";
import { ListingId } from "@catalog/domain/ids";
import type { AnswerCandidate } from "@catalog/domain/ports/answerer";
import * as Schema from "effect/Schema";

// The answerer's prose + schema half (§10, ADR-008) — shared by any provider adapter so
// a model swap (§11.5) compares models, not prompts. This is where the §1 guarantee is
// mechanically enforced: the OUTPUT schema below has no price/date/status field, so the
// model *cannot* emit a fact no matter what it is shown. It chooses `listingId`s from the
// candidates and writes one line of `why` each, plus connective prose. Facts are hydrated
// from Postgres afterward (§10.4). Grounded refusal (§10.6) is an answer with empty cards.

/** Bumped when the prompt or answer schema changes; recorded in `eval_run.config`. */
export const ANSWERER_VERSION = "answerer-v2"; // v2: forbid over-characterizing varied result sets

export const SYSTEM =
  `You are the answer composer for a Rutgers continuing-education course catalog. You are given a user question and a list of CANDIDATE course listings that retrieval already selected. Your ONLY job is to choose which candidates actually answer the question, write ONE short line explaining each, and write brief connective prose.

Hard rules (a violation is a system failure):
- Choose cards ONLY from the candidate listingIds given below. Never invent a listingId.
- Do NOT state prices, dates, fees, seat status, deadlines, campus, or hours in your prose or in a "why" line. Those facts are rendered separately from the live database — if you write them they will be WRONG and duplicated. Refer to them qualitatively at most ("a shorter option", "an evening section") and let the card show the numbers.
- "why" is one clause on WHY this listing fits the question (e.g. "matches your grant-writing topic", "the in-person option in Newark"). Keep it under 15 words. No facts.
- prose is 1–2 sentences of connective tissue ("Two sections match — " / "The closest options:"). No lists of facts.
- Do NOT characterize the SET beyond what is actually common to the cards you return. If the courses span different subjects (e.g. water operations, GIS, test prep), do not label them all as one theme ("test preparation courses", "leadership programs") — that is an unfaithful claim. When the results are varied, say so plainly ("A range of evening courses match:") or describe only the shared trait the question asked about (that they are evenings/online/in Newark). Every adjective in the prose must be true of EVERY card listed.
- Order cards best-first.
- followups: 0–3 short natural next questions the user might ask. Optional.

Grounded refusal (§10.6): if NONE of the candidates answer the question, or the candidate list is empty, return an EMPTY cards array and prose that honestly says you could not find a match in the catalog. Do not pad with irrelevant cards. It is correct and expected to return zero cards when nothing fits.

Output ONLY the JSON object: { "prose": string, "cards": [{ "listingId": string, "why": string }], "followups": [string] }.`;

// ── Gemini OpenAPI-subset response schema (a generation hint; decode is truth) ──
type G = Record<string, unknown>;
const str: G = { type: "STRING", nullable: false };

export const ANSWER_RESPONSE_SCHEMA: G = {
  type: "OBJECT",
  properties: {
    prose: str,
    cards: {
      type: "ARRAY",
      nullable: false,
      items: {
        type: "OBJECT",
        properties: { listingId: str, why: str },
        required: ["listingId", "why"],
        propertyOrdering: ["listingId", "why"],
        nullable: false,
      },
    },
    followups: { type: "ARRAY", nullable: false, items: str },
  },
  required: ["prose", "cards", "followups"],
  propertyOrdering: ["prose", "cards", "followups"],
  nullable: false,
};

// ── The user turn: the question + the candidate listings the model may cite ──────
export const answererUserPrompt = (
  question: string,
  candidates: ReadonlyArray<AnswerCandidate>,
): string => {
  if (candidates.length === 0) {
    return `Question: ${question}\n\nCANDIDATES: (none — retrieval found nothing)\n\nReturn empty cards and an honest "not found" prose.`;
  }
  const lines = candidates
    .map((c) => `- listingId ${c.listingId}: ${c.courseTitle} — ${c.summary}`)
    .join("\n");
  return `Question: ${question}\n\nCANDIDATES (choose cards only from these listingIds):\n${lines}`;
};

// ── decode (the source of truth) ─────────────────────────────────────────────────
const get = (o: unknown, k: string): unknown =>
  typeof o === "object" && o !== null && k in o ? (o as Record<string, unknown>)[k] : undefined;

const asString = (v: unknown): string => (typeof v === "string" ? v : "");
const asStringArray = (v: unknown): ReadonlyArray<string> =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/**
 * Turn a raw answerer response into a typed, GROUNDED `Answer`. Cards are kept only when
 * their `listingId` is in `allowedIds` (the candidate set) — a hallucinated id is dropped,
 * not surfaced (the §1/ADR-008 grounding guarantee, defended here even though the schema
 * constrains output). `filter` is left null; the agent echoes the router's filter as the
 * chips (§10.2). Total and pure: a malformed field degrades, never throws.
 */
export const decodeAnswer = (raw: unknown, allowedIds: ReadonlySet<string>): Answer => {
  const prose = asString(get(raw, "prose"));
  const rawCards = get(raw, "cards");
  const seen = new Set<string>();
  const cards: Array<CardRef> = [];
  if (Array.isArray(rawCards)) {
    for (const rc of rawCards) {
      const id = asString(get(rc, "listingId")).trim();
      const why = asString(get(rc, "why")).trim();
      if (id.length === 0 || !allowedIds.has(id) || seen.has(id)) continue;
      seen.add(id);
      cards.push(new CardRef({ listingId: Schema.decodeSync(ListingId)(id), why }));
    }
  }
  const followups = asStringArray(get(raw, "followups"))
    .map((f) => f.trim())
    .filter((f) => f.length > 0)
    .slice(0, 3);

  return new Answer({ prose, cards, filter: null, followups });
};
