import type {
  ChatResponse,
  FeedbackResponse,
  FilterWire,
  HealthResponse,
  HydrateResponse,
  RelaxResponse,
  SearchResponse,
} from "./types";

// Thin typed fetch wrappers over the Effect server's JSON endpoints. In dev these hit the
// Vite proxy (`/api/*` → the API server, see astro.config.mjs), so the browser stays
// same-origin. Every response is a plain JSON contract mirrored in `types.ts`.

const post = async <T>(path: string, body: unknown): Promise<T> => {
  const res = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
};

/** Liveness + cold-start probe (§10.5). Does no DB/LLM work, so its latency and the
 * `uptime` it reports are a clean read on whether the container is booting vs. warm. */
export const health = async (): Promise<HealthResponse> => {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error(`/health → ${res.status}`);
  return (await res.json()) as HealthResponse;
};

/** Ask a question — the full LLM path (router → retrieve → answer → live-hydrate, §8/§10). */
export const chat = (question: string, sessionId: string | undefined): Promise<ChatResponse> =>
  post<ChatResponse>("/chat", { question, ...(sessionId ? { sessionId } : {}) });

/** Re-run a filter with NO LLM call (§10.2) — the editable-chip path. */
export const search = (filter: FilterWire): Promise<SearchResponse> =>
  post<SearchResponse>("/search", { filter, limit: 12 });

/** Count each single-predicate drop when a filter matched nothing (§10.3). */
export const relax = (filter: FilterWire): Promise<RelaxResponse> =>
  post<RelaxResponse>("/relax", { filter });

/** Resolve listing ids → live cards (§10.4) — chip re-runs render identical fresh cards. */
export const hydrate = (listingIds: ReadonlyArray<string>): Promise<HydrateResponse> =>
  post<HydrateResponse>("/hydrate", { listingIds });

/** Thumbs up/down (§5.5). A thumbs-down promotes the question to a review-queue eval item. */
export const feedback = (
  messageId: string,
  rating: 1 | -1,
): Promise<FeedbackResponse> => post<FeedbackResponse>("/feedback", { messageId, rating });
