import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

// crawl_run bookkeeping (§6.2). The sweep gate reads pages_seen + status from
// here; a crash leaves a 'running' row so resume is a query (ADR-I6 / D6).

export interface OpenedRun {
  readonly id: string;
  readonly startedAt: string;
}

/** Open a run in 'running' state; returns its id and start cutoff for the sweep. */
export const openRun = Effect.gen(function*() {
  const sql = yield* SqlClient;
  // clock_timestamp() (real wall-clock), not now() (transaction start): observes
  // that follow must record a strictly later last_seen_at for the sweep's
  // "not seen this run" comparison to hold — including inside a single tx.
  // Result keys are camelCase — pgConfig transformResultNames snake→camel.
  const rows = yield* sql<{ id: string; startedAt: string; }>`
    INSERT INTO crawl_run (status, started_at) VALUES ('running', clock_timestamp())
    RETURNING id::text AS id, started_at
  `;
  const row = rows[0];
  if (row === undefined) return yield* Effect.die("crawl_run insert returned no row");
  return { id: row.id, startedAt: row.startedAt } satisfies OpenedRun;
});

export type CrawlStatus = "ok" | "failed" | "aborted";

/** Finalize a run with its observed page count and terminal status. */
export const closeRun = (id: string, pagesSeen: number, status: CrawlStatus) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    yield* sql`
      UPDATE crawl_run
      SET finished_at = now(), pages_seen = ${pagesSeen}, status = ${status}
      WHERE id = ${id}
    `;
  });

/** The largest page count of any prior successful run — the sweep-gate baseline. */
export const lastGoodPagesSeen = (excludeRunId: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ n: number | null; }>`
      SELECT max(pages_seen) AS n
      FROM crawl_run
      WHERE status = 'ok' AND id <> ${excludeRunId}
    `;
    return rows[0]?.n ?? null;
  });

export const markSwept = (id: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    yield* sql`UPDATE crawl_run SET swept = true WHERE id = ${id}`;
  });
