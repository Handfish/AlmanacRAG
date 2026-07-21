import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { PageFetchError } from "../errors.js";

// One fetched page (ADR-002: fetch, not a browser). Full-page capture (D7): the
// whole page is stored as raw_html (archival) + raw_markdown (clean view),
// snapshotted by hash — no fact is lost to a curated column. (plan §9)
//
// `fetch` models conditional GET (§6.1): with an ETag / Last-Modified the origin
// may answer 304, in which case there is no body to return — the page is
// unchanged and the caller only bumps its observation timestamp.

export type ConditionalHeaders = {
  readonly etag?: string;
  readonly lastModified?: string;
};

/** 200 — a body was returned. */
export type Fetched = {
  readonly _tag: "Fetched";
  readonly url: string;
  readonly httpStatus: number;
  readonly etag: string | undefined;
  readonly lastModified: string | undefined;
  readonly rawHtml: string;
  readonly rawMarkdown: string;
};

/** 304 — the conditional GET matched; nothing changed, no body. */
export type NotModified = {
  readonly _tag: "NotModified";
  readonly url: string;
  readonly httpStatus: number;
  readonly etag: string | undefined;
  readonly lastModified: string | undefined;
};

export type FetchResult = Fetched | NotModified;

export type PageSourceShape = {
  readonly fetch: (
    url: string,
    conditional?: ConditionalHeaders,
  ) => Effect.Effect<FetchResult, PageFetchError>;
};

export class PageSource
  extends Context.Service<PageSource, PageSourceShape>()("catalog/PageSource")
{}
