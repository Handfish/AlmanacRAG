import type { ConditionalHeaders } from "@catalog/domain/ports/page-source";
import { PageSource } from "@catalog/domain/ports/page-source";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import {
  closeRun,
  type CrawlStatus,
  lastGoodPagesSeen,
  markSwept,
  openRun,
} from "../db/repos/crawl-run.js";
import { snapshotIfAbsent } from "../db/repos/page-snapshot.js";
import {
  type ExistingPage,
  getExistingByUrl,
  observePage,
  touchObservation,
} from "../db/repos/source-page.js";
import { ensureEpoch } from "../db/repos/system-epoch.js";
import { DEFAULT_CONCURRENCY, DEFAULT_MIN_DELAY_MS } from "./consts.js";
import { Robots } from "./robots.js";
import { analyzePage, extractLinks } from "./segment.js";
import { gatedSweep, type SweepDecision } from "./sweep.js";

// ── The ingest orchestrator (§6). Table-driven, not a durable workflow engine
// (ADR-I6 / decision D6): `crawl_run` + per-page observation make crash-resume a
// query and the sweep ordering explicit, so Phase 1 does not ride on the v4
// workflow backend's maturity.
//
//   discover (a.chart)
//     → openCrawlRun
//     → per URL: robots? → conditional fetch → segment + fields → observe + snapshot
//     → closeCrawlRun
//     → gated sweep (§6.2)
//
// Zero AI (§16 M1).

export interface CrawlOptions {
  /** Explicit seed URLs. If absent, discovered from `indexUrl`. */
  readonly seeds?: ReadonlyArray<string>;
  /** Index page to discover detail links from (e.g. searchResults.cfm?searchId=1). */
  readonly indexUrl?: string;
  /** CSS selector for detail links on the index. Default `a.chart`. */
  readonly linkSelector?: string;
  readonly concurrency?: number;
  readonly minDelayMs?: number;
  /** Cap the seed set — for a bounded sample run. */
  readonly limit?: number;
}

export type OutcomeKind = "fetched" | "not_modified" | "skipped_robots" | "error";

export interface UrlOutcome {
  readonly url: string;
  readonly kind: OutcomeKind;
  readonly courseChanged: boolean;
  readonly listingChanged: boolean;
  readonly isNew: boolean;
  readonly snapshotNew: boolean;
  readonly groupUrl: string | undefined;
  readonly message: string | undefined;
}

export interface CrawlSummary {
  readonly runId: string;
  readonly startedAt: string;
  readonly seeds: number;
  readonly fetched: number;
  readonly notModified: number;
  readonly skipped: number;
  readonly errors: number;
  readonly pagesSeen: number;
  readonly courseChanged: number;
  readonly listingChanged: number;
  readonly newPages: number;
  readonly snapshotsWritten: number;
  readonly groupLinks: number;
  readonly status: CrawlStatus;
  readonly sweep: SweepDecision;
}

const buildConditional = (existing: ExistingPage | null): ConditionalHeaders => {
  if (existing === null) return {};
  const lm = existing.httpLastModified ? new Date(existing.httpLastModified) : null;
  const lmStr = lm && !isNaN(lm.getTime()) ? lm.toUTCString() : undefined;
  return {
    ...(existing.etag ? { etag: existing.etag } : {}),
    ...(lmStr ? { lastModified: lmStr } : {}),
  };
};

const blank = (url: string, kind: OutcomeKind, message?: string): UrlOutcome => ({
  url,
  kind,
  courseChanged: false,
  listingChanged: false,
  isNew: false,
  snapshotNew: false,
  groupUrl: undefined,
  message,
});

/** Fetch the index once and extract the detail-page links (ADR-002: no browser). */
const discover = (indexUrl: string, selector: string) =>
  Effect.gen(function*() {
    const pageSource = yield* PageSource;
    const res = yield* pageSource.fetch(indexUrl);
    return res._tag === "Fetched" ? extractLinks(res.rawHtml, indexUrl, selector) : [];
  });

const processUrl = (url: string, minDelayMs: number) =>
  Effect.gen(function*() {
    const pageSource = yield* PageSource;
    const robots = yield* Robots;

    if (!(yield* robots.isAllowed(url))) return blank(url, "skipped_robots");

    const existing = yield* getExistingByUrl(url);
    const result = yield* pageSource.fetch(url, buildConditional(existing));
    if (minDelayMs > 0) yield* Effect.sleep(Duration.millis(minDelayMs));

    if (result._tag === "NotModified") {
      yield* touchObservation(url);
      return blank(url, "not_modified");
    }

    const analysis = analyzePage(result.rawHtml, result.rawMarkdown, url);
    // Store page_fields FLAT so a query hits `page_fields->>'status'` directly
    // (RAG/analytics-friendly) rather than a nested path. Fields map spreads to
    // the top; title/fees are authoritative on collision.
    const id = yield* observePage({
      url,
      rawHtml: result.rawHtml,
      rawMarkdown: result.rawMarkdown,
      pageFields: {
        ...analysis.fields.fields,
        title: analysis.fields.title,
        fees: analysis.fields.fees,
      },
      courseHash: analysis.courseHash,
      listingHash: analysis.listingHash,
      contentHash: analysis.contentHash,
      httpStatus: result.httpStatus,
      etag: result.etag,
      lastModified: result.lastModified,
      groupUrl: analysis.groupUrl,
    });
    const snapshotNew = yield* snapshotIfAbsent(id, analysis.contentHash, result.rawMarkdown);

    return {
      url,
      kind: "fetched",
      isNew: existing === null,
      courseChanged: existing === null || existing.courseHash !== analysis.courseHash,
      listingChanged: existing === null || existing.listingHash !== analysis.listingHash,
      snapshotNew,
      groupUrl: analysis.groupUrl,
      message: undefined,
    } satisfies UrlOutcome;
  }).pipe(
    Effect.catchTag("PageFetchError", (e) => Effect.succeed(blank(url, "error", e.message))),
  );

export const runCrawl = (options: CrawlOptions = {}) =>
  Effect.gen(function*() {
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    const minDelayMs = options.minDelayMs ?? DEFAULT_MIN_DELAY_MS;
    const selector = options.linkSelector ?? "a.chart";

    // Start the clock (§5.3.4) — idempotent, the irreversible M1 act.
    yield* ensureEpoch;

    let seeds = options.seeds
      ? [...options.seeds]
      : options.indexUrl
      ? yield* discover(options.indexUrl, selector)
      : [];
    if (options.limit !== undefined) seeds = seeds.slice(0, options.limit);

    const run = yield* openRun;
    yield* Effect.logInfo(
      `crawl ${run.id}: ${seeds.length} seeds · concurrency ${concurrency} · delay ${minDelayMs}ms`,
    );

    const outcomes = yield* Effect.forEach(seeds, (url) => processUrl(url, minDelayMs), {
      concurrency,
    });

    const count = (k: OutcomeKind) => outcomes.filter((o) => o.kind === k).length;
    const fetched = count("fetched");
    const notModified = count("not_modified");
    const skipped = count("skipped_robots");
    const errors = count("error");
    const pagesSeen = fetched + notModified;
    const courseChanged = outcomes.filter((o) => o.courseChanged).length;
    const listingChanged = outcomes.filter((o) => o.listingChanged).length;
    const newPages = outcomes.filter((o) => o.isNew).length;
    const snapshotsWritten = outcomes.filter((o) => o.snapshotNew).length;
    const groupLinks = outcomes.filter((o) => o.groupUrl !== undefined).length;

    // A run that observed nothing (with seeds present) failed; otherwise ok even
    // with some per-page errors. The sweep gate (§6.2) is the real protection.
    const status: CrawlStatus = seeds.length > 0 && pagesSeen === 0 ? "failed" : "ok";
    yield* closeRun(run.id, pagesSeen, status);

    const sweep = status === "ok"
      ? yield* gatedSweep(run.id, pagesSeen, run.startedAt)
      : {
        swept: false,
        reason: "run status not 'ok' — sweep skipped",
        disappeared: 0,
        pagesSeen,
        lastGood: yield* lastGoodPagesSeen(run.id),
        threshold: null,
      } satisfies SweepDecision;
    if (sweep.swept) yield* markSwept(run.id);

    yield* Effect.logInfo(
      `crawl ${run.id} done: fetched=${fetched} notModified=${notModified} skipped=${skipped} `
        + `errors=${errors} new=${newPages} courseΔ=${courseChanged} listingΔ=${listingChanged} `
        + `snapshots=${snapshotsWritten} groupLinks=${groupLinks} · sweep=${sweep.swept} `
        + `(${sweep.disappeared} gone) — ${sweep.reason}`,
    );

    return {
      runId: run.id,
      startedAt: run.startedAt,
      seeds: seeds.length,
      fetched,
      notModified,
      skipped,
      errors,
      pagesSeen,
      courseChanged,
      listingChanged,
      newPages,
      snapshotsWritten,
      groupLinks,
      status,
      sweep,
    } satisfies CrawlSummary;
  });
