import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

// A per-IP token-bucket rate limiter for the public chat surface (abuse guard, defense in
// depth). One `POST /chat` fans out into THREE Gemini calls (router + embedder + answerer),
// so an unthrottled client is a direct cost/quota-exhaustion (financial-DoS) vector. This
// caps how often a single client can trigger that fan-out.
//
// SCOPE / CAVEATS — read before relying on this as your only control:
//  • In-memory & per-instance. Cloud Run scales to N instances (gcp.tf), each with its own
//    buckets, so the effective global limit is up to N× the per-instance limit. The real
//    edge control is a Cloudflare WAF rate-limit rule on /chat*; this is the app-layer
//    backstop for when a request slips past the edge (or in local/dev with no edge).
//  • Keyed on the client IP from the proxy headers. Behind Cloudflare, `cf-connecting-ip`
//    is trustworthy; direct-to-Cloud-Run it is not (a client can forge `x-forwarded-for`),
//    which is another reason the edge rule is primary.
//  • No cross-instance coordination. For a hard global cap, back the bucket with Postgres
//    or Redis instead of this Map (same `take` shape, async).

// ── config (env, read once at module load; sane hobby-tier defaults) ───────────────
const intEnv = (name: string, fallback: number): number => {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Sustained rate: tokens refilled per minute (≈ requests/min once the burst is spent). */
const RPM = intEnv("RATE_LIMIT_RPM", 30);
/** Bucket capacity — the burst a fresh client may spend before the refill rate binds. */
const BURST = intEnv("RATE_LIMIT_BURST", 12);
const REFILL_PER_MS = RPM / 60_000;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

// Per-instance state. Pruned opportunistically (see `take`) so a spray of unique IPs cannot
// grow it without bound.
const buckets = new Map<string, Bucket>();
const MAX_BUCKETS = 50_000;

export interface RateDecision {
  readonly allowed: boolean;
  /** Whole seconds until one token is available again (for a `Retry-After` header). */
  readonly retryAfterSec: number;
}

/** Spend one token for `key`, refilling by elapsed wall-clock first. Pure bookkeeping over
 * the module bucket map; `now` is injected so it is deterministically testable. */
export const take = (key: string, now: number): RateDecision => {
  if (buckets.size > MAX_BUCKETS) prune(now);
  const b = buckets.get(key) ?? { tokens: BURST, updatedAt: now };
  const refilled = Math.min(BURST, b.tokens + (now - b.updatedAt) * REFILL_PER_MS);
  if (refilled >= 1) {
    buckets.set(key, { tokens: refilled - 1, updatedAt: now });
    return { allowed: true, retryAfterSec: 0 };
  }
  buckets.set(key, { tokens: refilled, updatedAt: now });
  const retryAfterSec = Math.ceil((1 - refilled) / REFILL_PER_MS / 1000);
  return { allowed: false, retryAfterSec: Math.max(1, retryAfterSec) };
};

/** Drop buckets that have fully refilled (idle clients) — they reconstruct at BURST for free. */
const prune = (now: number): void => {
  for (const [key, b] of buckets) {
    const refilled = b.tokens + (now - b.updatedAt) * REFILL_PER_MS;
    if (refilled >= BURST) buckets.delete(key);
  }
};

// ── request → client key ───────────────────────────────────────────────────────────
const firstForwarded = (xff: string | undefined): string | undefined =>
  xff === undefined ? undefined : xff.split(",")[0]?.trim() || undefined;

/** The client identity: Cloudflare's verified IP first, then the first `x-forwarded-for`
 * hop, then a shared "unknown" bucket (fail-closed-ish: unattributable traffic shares one
 * limit rather than getting a free pass each). */
export const clientKey = (headers: Record<string, string | undefined>): string =>
  headers["cf-connecting-ip"] ?? firstForwarded(headers["x-forwarded-for"]) ?? "unknown";

/** Read the request and spend one token for its client. Never fails; callers decide what a
 * `!allowed` decision means for their transport (429 on SSE, a typed error on the JSON API). */
export const rateDecision: Effect.Effect<RateDecision, never, HttpServerRequest.HttpServerRequest> =
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const key = clientKey(request.headers as Record<string, string | undefined>);
    return take(key, Date.now());
  });
