import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { lastGoodPagesSeen } from "../db/repos/crawl-run.js";

// ── The sweep gate (§6.2, ADR-011) — "the bug that eats your history." A naive
// sweep marks every URL not seen this crawl as gone. Crawl 500s at page 300, or
// a redirect loop eats half the site, and you have just declared hundreds of
// courses dead — silently, forever, because the past cannot be re-observed.
//
// So the sweep only runs after a complete, plausible crawl: status must be 'ok'
// (enforced by the caller — we sweep only on a clean run) AND pages_seen must be
// at least 80% of the last successful run. Below that we refuse and alert; a 30%
// drop is a site or crawler problem, never 300 courses vanishing overnight.

export const SWEEP_FRACTION = 0.8;

export interface SweepDecision {
  readonly swept: boolean;
  readonly reason: string;
  readonly disappeared: number;
  readonly pagesSeen: number;
  readonly lastGood: number | null;
  readonly threshold: number | null;
}

/**
 * Decide and, if the gate passes, execute the sweep for `runId`. Pages whose
 * `last_seen_at` predates this run's start (i.e. not observed this crawl) get
 * `disappeared_at = now()`. Idempotent: pages already gone are skipped.
 */
export const gatedSweep = (runId: string, pagesSeen: number, startedAt: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const lastGood = yield* lastGoodPagesSeen(runId);
    const threshold = lastGood === null ? null : Math.ceil(SWEEP_FRACTION * lastGood);

    if (threshold !== null && pagesSeen < threshold) {
      return {
        swept: false,
        reason:
          `REFUSED: pages_seen ${pagesSeen} < ${threshold} (${
            Math.round(SWEEP_FRACTION * 100)
          }% of `
          + `last good run ${lastGood}). A short crawl must never mark history gone (§6.2).`,
        disappeared: 0,
        pagesSeen,
        lastGood,
        threshold,
      } satisfies SweepDecision;
    }

    const gone = yield* sql<{ id: string; }>`
      UPDATE cecc_course_index_course_listing
      SET disappeared_at = clock_timestamp()
      WHERE last_seen_at < ${startedAt} AND disappeared_at IS NULL
      RETURNING id::text AS id
    `;

    return {
      swept: true,
      reason: lastGood === null
        ? "first successful run — no prior history to protect; nothing to mark gone"
        : `gate passed: pages_seen ${pagesSeen} >= ${threshold}`,
      disappeared: gone.length,
      pagesSeen,
      lastGood,
      threshold,
    } satisfies SweepDecision;
  });
