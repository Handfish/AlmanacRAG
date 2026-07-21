import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

// The Gemini provider (architecture.md §9 / §11.5 ablation seam) — the batch-mode
// counterpart to the synchronous Anthropic adapter. No Effect v4 Google provider
// exists at this beta AND Gemini's Batch API is not on the OpenAI-compat endpoint,
// so this talks to the native REST API directly (contained here, one-file blast
// radius, ADR-I1). Correctness is still enforced downstream: every batch result is
// decoded through the SAME `ExtractedCourse` schema, so a value this response-schema
// permits but the typed schema rejects becomes a `schema_error` row, never a silent
// null. The response-schema below is therefore a generation *hint*; the decode is
// the source of truth (§9).

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** Output-token ceiling for the public chat surface (router + answerer). A grounded route
 * (a small ListingFilter) and a grounded answer (1–2 sentences + a handful of `why` clauses)
 * both fit comfortably under this; the cap bounds cost if a prompt-injected question tries to
 * elicit a long generation. Extraction does NOT use it (see `generateJson`). */
export const CHAT_MAX_OUTPUT_TOKENS = 1024;

/** Transport / job-level failure (whole batch), distinct from a per-row decode miss. */
export class GeminiBatchError extends Data.TaggedError("GeminiBatchError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Batch runner needs a key — unlike the boot-optional Anthropic client, this is a
 * dedicated entrypoint, so a missing key fails the run cleanly at config time. */
export const GeminiApiKey = Config.redacted("GEMINI_API_KEY");

/** Cheapest current tier and the §9.3 candidate. Override via GEMINI_EXTRACTION_MODEL.
 * (gemini-2.5-flash-lite is restricted for new API projects → default to 3.1-flash-lite,
 * which carries a very large free-tier quota.) */
export const GeminiExtractionModel = Config.string("GEMINI_EXTRACTION_MODEL").pipe(
  Config.withDefault("gemini-3.1-flash-lite"),
);

/** Poll cadence + ceiling. Batch jobs usually finish in minutes; the ceiling guards
 * a wedged job (Gemini allows up to 24h — raise GEMINI_BATCH_MAX_MINUTES for a huge run). */
export const GeminiPollSeconds = Config.string("GEMINI_BATCH_POLL_SECONDS").pipe(
  Config.withDefault("20"),
  Config.map((s) => Number.parseInt(s, 10) || 20),
);
export const GeminiMaxMinutes = Config.string("GEMINI_BATCH_MAX_MINUTES").pipe(
  Config.withDefault("180"),
  Config.map((s) => Number.parseInt(s, 10) || 180),
);

// ── Response schema (Gemini OpenAPI subset) mirroring domain `ExtractedCourse` ──
// Uppercase types + `nullable`; every key is `required` so the model always emits
// it (explicit null when absent — matching the schema's NullOr-not-optional
// contract). Enum value lists mirror domain `course.ts`; if they ever drift, the
// `ExtractedCourse` decode catches it as a schema_error (safe-failing), so this is
// not a second source of truth.
type G = Record<string, unknown>;
const str = (nullable: boolean): G => ({ type: "STRING", nullable });
const num = (nullable: boolean): G => ({ type: "NUMBER", nullable });
const bool = (nullable: boolean): G => ({ type: "BOOLEAN", nullable });
const enm = (values: ReadonlyArray<string>, nullable: boolean): G => ({
  type: "STRING",
  enum: values,
  nullable,
});
const obj = (properties: Record<string, G>): G => ({
  type: "OBJECT",
  properties,
  required: Object.keys(properties),
  propertyOrdering: Object.keys(properties),
  nullable: false,
});
const arr = (items: G): G => ({ type: "ARRAY", items, nullable: false });

const DELIVERY_MODES = ["in_person", "online_sync", "online_async", "hybrid", "unknown"];
const CAMPUSES = ["New Brunswick", "Newark", "Camden", "Online", "Other", "unknown"];
const RELATION_SOURCES = ["prereq_field", "description"];
const RELATION_KINDS = ["required", "recommended", "corequisite", "concurrent"];

export const RESPONSE_SCHEMA: G = obj({
  // ── Course ──
  courseTitle: str(false),
  externalCourseId: str(true),
  track: str(true),
  contactHours: num(true),
  subject: str(true),
  program: str(true),
  description: str(true),
  audience: str(true),
  prerequisiteText: str(true),
  registrationKeyword: str(true),
  relations: arr(obj({
    rawText: str(false),
    source: enm(RELATION_SOURCES, false),
    kind: enm(RELATION_KINDS, true),
  })),
  // ── Listing ──
  externalSectionId: str(true),
  sessionLabel: str(true),
  datesText: str(true),
  scheduleText: str(true),
  timesText: str(true),
  isEvening: bool(true),
  registrationDeadlineText: str(true),
  formatText: str(true),
  deliveryMode: enm(DELIVERY_MODES, false),
  locationText: str(true),
  campus: enm(CAMPUSES, false),
  statusRaw: str(false),
  isNew: bool(false),
  fees: arr(obj({ label: str(false), amount: str(false), isTotal: bool(false) })),
  instructors: arr(obj({ lastName: str(true), firstName: str(true) })),
});

const request = (apiKey: Redacted.Redacted<string>, url: string, body: unknown) =>
  Effect.tryPromise({
    try: async (signal) => {
      const res = await fetch(url, {
        method: body === undefined ? "GET" : "POST",
        signal,
        headers: {
          "x-goog-api-key": Redacted.value(apiKey),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
      return JSON.parse(text) as unknown;
    },
    catch: (cause) => new GeminiBatchError({ message: "Gemini API request failed", cause }),
  });

/** Create an inline batch job. Returns the raw operation/batch object (has `.name`). */
export const createBatch = (
  apiKey: Redacted.Redacted<string>,
  model: string,
  body: unknown,
) => request(apiKey, `${BASE_URL}/models/${model}:batchGenerateContent`, body);

/** Poll one batch by its resource name (e.g. "batches/123"). */
export const getBatch = (apiKey: Redacted.Redacted<string>, name: string) =>
  request(apiKey, `${BASE_URL}/${name}`, undefined);

// ── Synchronous generateContent (Phase 3 §7.3 contextual prefixes) ───────────
// The cheap-model, one-sentence "situating prefix per chunk". Same key, same REST
// surface as the batch extractor — reused rather than a second vendor file.

/** The §7.3 prefix writer — cheapest tier by default. Override via CONTEXT_MODEL. */
export const GeminiContextModel = Config.string("CONTEXT_MODEL").pipe(
  Config.withDefault("gemini-3.1-flash-lite"),
);

const textFromResponse = (response: unknown): string | null => {
  const get = (o: unknown, k: string): unknown =>
    typeof o === "object" && o !== null && k in o ? (o as Record<string, unknown>)[k] : undefined;
  const candidates = get(response, "candidates");
  const first = Array.isArray(candidates) ? candidates[0] : undefined;
  const parts = get(get(first, "content"), "parts");
  if (!Array.isArray(parts)) return null;
  const texts = parts
    .map((p) => get(p, "text"))
    .filter((t): t is string => typeof t === "string");
  return texts.length > 0 ? texts.join("").trim() : null;
};

/** One synchronous generateContent call, returning the concatenated text (or null). */
export const generateText = (
  apiKey: Redacted.Redacted<string>,
  model: string,
  system: string,
  user: string,
) =>
  request(apiKey, `${BASE_URL}/models/${model}:generateContent`, {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generation_config: { temperature: 0.2, maxOutputTokens: 256 },
  }).pipe(Effect.map(textFromResponse));

// ── Synchronous structured extraction (Phase 2 §9, sync sibling of the batch path) ──
// The batch API trades ~50% cost for minutes of async scheduling latency; the sync
// path returns immediately, which is what we want to actually POPULATE the catalog.
// Same SYSTEM prompt, same RESPONSE_SCHEMA, same downstream `ExtractedCourse` decode —
// an ablation still compares models, not prompts.

const usageOf = (response: unknown): { input: number | null; output: number | null; } => {
  const get = (o: unknown, k: string): unknown =>
    typeof o === "object" && o !== null && k in o ? (o as Record<string, unknown>)[k] : undefined;
  const um = get(response, "usageMetadata");
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  return { input: num(get(um, "promptTokenCount")), output: num(get(um, "candidatesTokenCount")) };
};

export interface GeminiStructuredResult {
  readonly text: string | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

/** One synchronous structured generateContent call, JSON constrained to `schema` (a
 * Gemini OpenAPI-subset object). The generation-schema is a HINT; the source of truth is
 * always the downstream Effect Schema decode (§9), so callers pass whatever shape their
 * decode expects — `RESPONSE_SCHEMA` for extraction, the ListingFilter schema for the
 * router (§8). */
export const generateJson = (
  apiKey: Redacted.Redacted<string>,
  model: string,
  system: string,
  user: string,
  schema: G,
  // Abuse guard (cost cap): the response_schema constrains the *shape* of the output but
  // not its *length* — a long `prose` string or a padded array still bills output tokens.
  // Callers on the public chat surface (router/answerer) pass a bound; extraction leaves it
  // undefined because a full `ExtractedCourse` object legitimately needs the room.
  maxOutputTokens?: number,
): Effect.Effect<GeminiStructuredResult, GeminiBatchError> =>
  request(apiKey, `${BASE_URL}/models/${model}:generateContent`, {
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generation_config: {
      temperature: 0,
      response_mime_type: "application/json",
      response_schema: schema,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    },
  }).pipe(Effect.map((response) => {
    const usage = usageOf(response);
    return {
      text: textFromResponse(response),
      inputTokens: usage.input,
      outputTokens: usage.output,
    };
  }));

/** Extraction's structured call — the `RESPONSE_SCHEMA` specialization of `generateJson`. */
export const generateStructured = (
  apiKey: Redacted.Redacted<string>,
  model: string,
  system: string,
  user: string,
): Effect.Effect<GeminiStructuredResult, GeminiBatchError> =>
  generateJson(apiKey, model, system, user, RESPONSE_SCHEMA);
