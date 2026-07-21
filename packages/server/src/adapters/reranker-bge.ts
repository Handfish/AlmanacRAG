import { RerankError } from "@catalog/domain/errors";
import { Reranker } from "@catalog/domain/ports/reranker";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { identityScores } from "../retrieval/rerank.js";

// The Reranker adapter (architecture.md §11.6) — the single file carrying the reranker
// dependency behind the first-party `Reranker` port. Cross-encodes the query against the
// top ~50 fused candidates with bge-reranker-v2-m3, served over HTTP (the §13
// `reranker.container`, or any HuggingFace text-embeddings-inference `/rerank` endpoint).
//
// It is the LARGEST latency line item in the request path (§11.6), so it exists behind a
// port precisely so "we removed it" is a one-line change and §11.5 can measure keep/drop.
// Two properties matter:
//   • DEGRADE TO IDENTITY (§14). A missing `RERANKER_URL`, a downed container, a timeout,
//     or a malformed response all resolve to identity scores (input order preserved), never
//     an error — the service stays up whether or not the reranker is deployed. This is why
//     the "+reranker" ablation row runs even with no container: it honestly reports "no
//     effect (identity fallback)" instead of failing the run.
//   • ALIGNED BY INPUT INDEX. TEI's `/rerank` returns `[{index, score}]` sorted by score;
//     we map it back to one score per INPUT document (the port's contract), so the caller's
//     `reorderByScores` does the reordering deterministically.

const RERANK_TIMEOUT_MS = 10_000;

/** `RERANKER_URL` — the `/rerank` endpoint (e.g. http://localhost:8787/rerank). Optional:
 * unset ⇒ the adapter is a pure identity pass, so the port can always be provided. */
const OptionalRerankerUrl = Config.string("RERANKER_URL").pipe(
  Config.option,
  Config.map(Option.getOrUndefined),
);

/** The served model — informational, surfaced in the ablation report. Override for a
 * different cross-encoder without touching code. */
export const RerankerModel = Config.string("RERANKER_MODEL").pipe(
  Config.withDefault("bge-reranker-v2-m3"),
);

/**
 * Parse a TEI-style `/rerank` response into one score per INPUT document, aligned by
 * index. Accepts the bare `[{index, score}]` array or a `{results:[…]}` / `{data:[…]}`
 * envelope. Any document the response omits keeps a very-low score (sorts last). Pure, so
 * the alignment logic tests without a server. Returns null when the shape is unrecognized
 * (the caller then degrades to identity).
 */
export const parseRerankResponse = (
  body: unknown,
  n: number,
): ReadonlyArray<number> | null => {
  const arr = Array.isArray(body)
    ? body
    : typeof body === "object" && body !== null
    ? ((body as Record<string, unknown>).results ?? (body as Record<string, unknown>).data)
    : undefined;
  if (!Array.isArray(arr)) return null;
  const scores = Array.from<number>({ length: n }).fill(Number.NEGATIVE_INFINITY);
  let matched = 0;
  for (const entry of arr) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const idx = typeof rec.index === "number" ? rec.index : undefined;
    const score = typeof rec.score === "number"
      ? rec.score
      : typeof rec.relevance_score === "number"
      ? rec.relevance_score
      : undefined;
    if (idx === undefined || score === undefined || idx < 0 || idx >= n) continue;
    scores[idx] = score;
    matched++;
  }
  return matched === 0 ? null : scores;
};

const callRerankEndpoint = (
  url: string,
  query: string,
  documents: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<number>, RerankError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const res = await fetch(url, {
        method: "POST",
        signal: AbortSignal.any([signal, AbortSignal.timeout(RERANK_TIMEOUT_MS)]),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, texts: documents, raw_scores: false }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      const parsed = parseRerankResponse(JSON.parse(text) as unknown, documents.length);
      if (parsed === null) throw new Error("unrecognized /rerank response shape");
      return parsed;
    },
    catch: (cause) => new RerankError({ message: "bge /rerank failed", cause }),
  });

/**
 * The HTTP bge reranker. `available` reflects whether `RERANKER_URL` was configured — the
 * ablation report reads it to distinguish a measured "+reranker" row from an identity
 * fallback. `rerank` NEVER fails: a transport/parse fault is caught and degraded to
 * identity (§14), logged once so a silently-down container is visible in the run output.
 */
export const RerankerBgeLive = Layer.effect(
  Reranker,
  Effect.gen(function*() {
    const url = yield* OptionalRerankerUrl;
    return {
      rerank: (query, documents) =>
        documents.length === 0
          ? Effect.succeed([] as ReadonlyArray<number>)
          : url === undefined
          ? Effect.succeed(identityScores(documents.length))
          : callRerankEndpoint(url, query, documents).pipe(
            Effect.catchTag("RerankError", (e) =>
              Effect.logWarning(`reranker down, degrading to identity: ${e.message}`).pipe(
                Effect.as(identityScores(documents.length)),
              )),
          ),
    };
  }),
);

/** The reranker as a pure identity pass — the composition-root default (the port is
 * always providable) and the deterministic test double. Equivalent to "reranker off". */
export const RerankerIdentityLive = Layer.succeed(Reranker, {
  rerank: (_query, documents) => Effect.succeed(identityScores(documents.length)),
});

/** Whether `RERANKER_URL` is set — the ablation runner reads this to label the row. */
export const rerankerConfigured = Config.string("RERANKER_URL").pipe(
  Config.option,
  Config.map(Option.isSome),
);
