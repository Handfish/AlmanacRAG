import { PageSource } from "@catalog/domain/ports/page-source";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as http from "node:http";
import { afterAll, beforeAll } from "vitest";
import { FetchPageSourceLive } from "./fetch-page-source.js";

// Exercises the real adapter against a local server: conditional GET (200/304),
// bounded retry on 5xx, and no-retry on 4xx. `it.live` so the retry backoff runs
// on the real clock (it.effect would virtualize Schedule delays and hang).

let server: http.Server;
let base = "";
const hits = new Map<string, number>();
const bump = (path: string) => hits.set(path, (hits.get(path) ?? 0) + 1);

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    bump(path);
    if (path === "/ok") {
      if (req.headers["if-none-match"] === "\"v1\"") {
        res.statusCode = 304;
        res.setHeader("etag", "\"v1\"");
        res.end();
        return;
      }
      res.statusCode = 200;
      res.setHeader("etag", "\"v1\"");
      res.setHeader("content-type", "text/html");
      res.end(
        "<html><body><div role=\"main\"><h1>OK Page</h1><p>hello world</p></div></body></html>",
      );
      return;
    }
    if (path === "/boom") {
      res.statusCode = 500;
      res.end("boom");
      return;
    }
    res.statusCode = 404;
    res.end("nope");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  base = typeof addr === "object" && addr !== null ? `http://127.0.0.1:${addr.port}` : "";
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

describe("FetchPageSource", () => {
  it.live("fetches 200, converts to markdown, surfaces the etag", () =>
    Effect.gen(function*() {
      const ps = yield* PageSource;
      const r = yield* ps.fetch(`${base}/ok`);
      expect(r._tag).toBe("Fetched");
      if (r._tag === "Fetched") {
        expect(r.httpStatus).toBe(200);
        expect(r.etag).toBe("\"v1\"");
        expect(r.rawHtml).toContain("OK Page");
        expect(r.rawMarkdown).toContain("hello world");
      }
    }).pipe(Effect.provide(FetchPageSourceLive)));

  it.live("conditional GET returns NotModified on a matching etag (304)", () =>
    Effect.gen(function*() {
      const ps = yield* PageSource;
      const r = yield* ps.fetch(`${base}/ok`, { etag: "\"v1\"" });
      expect(r._tag).toBe("NotModified");
      expect(r.httpStatus).toBe(304);
    }).pipe(Effect.provide(FetchPageSourceLive)));

  it.live("does not retry a 404", () =>
    Effect.gen(function*() {
      const ps = yield* PageSource;
      const err = yield* ps.fetch(`${base}/notfound`).pipe(Effect.flip);
      expect(err.status).toBe(404);
      expect(hits.get("/notfound")).toBe(1); // fetched once, not retried
    }).pipe(Effect.provide(FetchPageSourceLive)));

  it.live("retries a 500 a bounded number of times, then fails", () =>
    Effect.gen(function*() {
      const ps = yield* PageSource;
      const err = yield* ps.fetch(`${base}/boom`).pipe(Effect.flip);
      expect(err.status).toBe(500);
      expect(hits.get("/boom")).toBe(4); // 1 initial + 3 bounded retries
    }).pipe(Effect.provide(FetchPageSourceLive)));
});
