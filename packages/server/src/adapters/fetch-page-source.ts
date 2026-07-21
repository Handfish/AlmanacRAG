import { PageFetchError } from "@catalog/domain/errors";
import {
  type ConditionalHeaders,
  type FetchResult,
  PageSource,
} from "@catalog/domain/ports/page-source";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import { FETCH_TIMEOUT_MS, USER_AGENT } from "../ingest/consts.js";
import { htmlToMarkdown } from "../ingest/segment.js";

// ── FetchPageSource (ADR-002): the ONE adapter that touches the network. `fetch`
// + a parser, no browser. Conditional GET (§6.1), a hard per-request timeout via
// AbortSignal, a polite identifying User-Agent, and a jittered exponential retry
// scoped to transient failures. Everything vendor-ish (turndown, via
// htmlToMarkdown) is contained here.

const describe = (cause: unknown): string =>
  cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);

const isRetryable = (e: PageFetchError): boolean =>
  e.status === undefined || e.status >= 500 || e.status === 429;

// ccpd `ed2go-api.ts` idiom: jittered exponential backoff, bounded to 3 retries
// via the `times` option (beta.99 dropped `Schedule.both`; `times` + `schedule`
// compose in `Effect.retry`'s options).
const retrySchedule = Schedule.jittered(Schedule.exponential(Duration.millis(300)));

const doFetch = (
  url: string,
  conditional?: ConditionalHeaders,
): Effect.Effect<FetchResult, PageFetchError> =>
  Effect.gen(function*() {
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      "accept": "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
    };
    if (conditional?.etag) headers["if-none-match"] = conditional.etag;
    if (conditional?.lastModified) headers["if-modified-since"] = conditional.lastModified;

    const res = yield* Effect.tryPromise({
      try: () =>
        fetch(url, {
          headers,
          redirect: "follow",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        }),
      catch: (cause) => new PageFetchError({ url, message: `network: ${describe(cause)}` }),
    });

    const etag = res.headers.get("etag") ?? undefined;
    const lastModified = res.headers.get("last-modified") ?? undefined;

    if (res.status === 304) {
      return {
        _tag: "NotModified",
        url,
        httpStatus: 304,
        etag,
        lastModified,
      } satisfies FetchResult;
    }
    if (res.status >= 400) {
      return yield* Effect.fail(
        new PageFetchError({ url, message: `HTTP ${res.status}`, status: res.status }),
      );
    }

    const rawHtml = yield* Effect.tryPromise({
      try: () => res.text(),
      catch: (cause) => new PageFetchError({ url, message: `body: ${describe(cause)}` }),
    });

    return {
      _tag: "Fetched",
      url,
      httpStatus: res.status,
      etag,
      lastModified,
      rawHtml,
      rawMarkdown: htmlToMarkdown(rawHtml),
    } satisfies FetchResult;
  }).pipe(
    Effect.retry({ schedule: retrySchedule, times: 3, while: isRetryable }),
  );

export const FetchPageSourceLive = Layer.succeed(PageSource, { fetch: doFetch });
