import { describe, expect, it } from "vitest";
import { clientKey, take } from "./rate-limit.js";

// Defaults (no env set in the test run): BURST=12 capacity, RPM=30 → refill 0.5 tokens/sec.
// A unique key per test keeps the shared module bucket map from bleeding across cases.
const uniq = (n: string) => `test-${n}-${Math.random()}`;

describe("rate-limit token bucket", () => {
  it("allows a fresh client to spend the full burst, then throttles", () => {
    const key = uniq("burst");
    const t0 = 1_000_000;
    for (let i = 0; i < 12; i++) {
      expect(take(key, t0).allowed).toBe(true);
    }
    // 13th request in the same instant: no tokens left.
    const denied = take(key, t0);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThanOrEqual(1);
  });

  it("refills over wall-clock time (30 rpm ⇒ ~2s per token)", () => {
    const key = uniq("refill");
    const t0 = 2_000_000;
    for (let i = 0; i < 12; i++) take(key, t0); // drain the burst
    expect(take(key, t0).allowed).toBe(false);

    // After 2s one token has refilled (0.5 tok/s), so exactly one request gets through.
    const t1 = t0 + 2_000;
    expect(take(key, t1).allowed).toBe(true);
    expect(take(key, t1).allowed).toBe(false);
  });

  it("isolates clients — one client's flood does not throttle another", () => {
    const a = uniq("a");
    const b = uniq("b");
    const t = 3_000_000;
    for (let i = 0; i < 12; i++) take(a, t);
    expect(take(a, t).allowed).toBe(false);
    expect(take(b, t).allowed).toBe(true); // b has its own full bucket
  });
});

describe("clientKey", () => {
  it("prefers Cloudflare's verified IP over x-forwarded-for", () => {
    expect(clientKey({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }))
      .toBe("1.2.3.4");
  });

  it("falls back to the first x-forwarded-for hop, then to a shared bucket", () => {
    expect(clientKey({ "x-forwarded-for": "5.6.7.8, 10.0.0.1" })).toBe("5.6.7.8");
    expect(clientKey({})).toBe("unknown");
  });
});
