import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { runBatch } from "./gemini-batch.js";

// Network-free test of the risky part — the batch-response navigation + decode +
// key correlation (the nesting flagged "confirm on live run"). `fetch` is stubbed
// with a synthetic SUCCEEDED batch: one row whose JSON decodes through
// `ExtractedCourse`, one whose JSON omits a required field. We assert the good row
// comes back `extracted`, the bad row becomes an `extracted: null` + error (→ the
// runner writes a `schema_error`), correlated by the per-request key.

const validCourse = {
  courseTitle: "Test Course",
  externalCourseId: "TST1",
  track: null,
  contactHours: null,
  subject: null,
  program: null,
  description: null,
  audience: null,
  prerequisiteText: null,
  registrationKeyword: null,
  relations: [],
  externalSectionId: "1",
  sessionLabel: null,
  datesText: null,
  scheduleText: null,
  timesText: null,
  isEvening: null,
  registrationDeadlineText: null,
  formatText: null,
  deliveryMode: "online_async",
  locationText: null,
  campus: "Online",
  statusRaw: "Registration Available",
  isNew: false,
  fees: [],
  instructors: [],
};

const inlined = (key: string, text: string) => ({
  metadata: { key },
  response: {
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
  },
});

const jsonResponse = (payload: unknown) => ({
  ok: true,
  status: 200,
  text: () => Promise.resolve(JSON.stringify(payload)),
});

const stubFetch = () =>
  vi.fn((_url: string, init?: { method?: string; }) => {
    // POST → create; GET (no body / method undefined) → poll a succeeded batch.
    if (init?.method === "POST") return Promise.resolve(jsonResponse({ name: "batches/test" }));
    return Promise.resolve(
      jsonResponse({
        state: "JOB_STATE_SUCCEEDED",
        response: {
          inlinedResponses: {
            inlinedResponses: [
              inlined("good", JSON.stringify(validCourse)),
              inlined("bad", JSON.stringify({ courseTitle: "missing the rest" })),
            ],
          },
        },
      }),
    );
  });

describe("runBatch (Gemini batch parsing)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_BATCH_POLL_SECONDS;
  });

  it("decodes good rows and turns undecodable rows into errors, correlated by key", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.GEMINI_BATCH_POLL_SECONDS = "1";
    vi.stubGlobal("fetch", stubFetch());

    const results = await Effect.runPromise(
      runBatch([
        { key: "good", rawMarkdown: "# Good\n..." },
        { key: "bad", rawMarkdown: "# Bad\n..." },
      ]),
    );

    const byKey = new Map(results.map((r) => [r.key, r]));
    const good = byKey.get("good");
    const bad = byKey.get("bad");

    expect(good?.extracted?.courseTitle).toBe("Test Course");
    expect(good?.error).toBeNull();
    expect(good?.inputTokens).toBe(100);

    expect(bad?.extracted).toBeNull();
    expect(bad?.error).toContain("decode:");
  });
});
