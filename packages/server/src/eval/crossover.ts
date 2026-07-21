import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

// The ADR-004 crossover curve (architecture.md §11.5) — "converts 'I didn't need an index'
// from an excuse into a finding". At ~736 chunks an EXACT sequential scan over the whole
// halfvec set is sub-millisecond at 100% recall, so ADR-004 chose no index. This harness
// runs the sweep the ADR promised: synthetic corpora from 10³ upward, measuring exact vs
// HNSW (and DiskANN where available) latency + recall, and reports the size at which HNSW's
// approximate scan finally beats exact — i.e. the size at which "the boring option" stops
// being right. "I measured it and chose the boring option, and here's the size at which that
// stops being true" (ADR-004).
//
// Method notes:
//   • A REAL table (not TEMP) so the pooled client sees it across connections. Dropped after.
//   • Exact = no index present → guaranteed sequential scan (no fragile per-connection SET).
//   • HNSW  = build the index, then the planner uses it for `ORDER BY <=> … LIMIT`.
//   • Recall@10 is measured against the exact top-10 (which is ground truth by definition).
//   • DiskANN (pgvectorscale) is ATTEMPTED and degrades to "unavailable" with a reason — the
//     stock pgvector image has no vectorscale, so this leg is honestly reported, not faked.

export interface MethodResult {
  readonly method: "exact" | "hnsw" | "diskann";
  readonly available: boolean;
  readonly buildMs: number | null; // index build time (null for exact / unavailable)
  readonly medianQueryMs: number | null;
  readonly recallAt10: number | null; // vs exact ground truth (exact is 1.0 by definition)
  readonly note: string | null;
}

export interface SizeResult {
  readonly n: number;
  readonly dims: number;
  readonly methods: ReadonlyArray<MethodResult>;
}

export interface CrossoverReport {
  readonly sizes: ReadonlyArray<SizeResult>;
  readonly hnswCrossoverN: number | null; // smallest N where HNSW medianQueryMs < exact
  readonly diskannAvailable: boolean;
}

/** Median of a numeric list (lower-median for even counts). */
const median = (xs: ReadonlyArray<number>): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)]!;
};

/**
 * The smallest corpus size at which HNSW's median query latency dips below exact's — the
 * published crossover. Pure, so it unit-tests on synthetic latency rows. Returns null when
 * exact wins across the whole measured range (the expected ADR-004 result at these sizes).
 */
export const findHnswCrossover = (sizes: ReadonlyArray<SizeResult>): number | null => {
  for (const s of [...sizes].sort((a, b) => a.n - b.n)) {
    const exact = s.methods.find((m) => m.method === "exact")?.medianQueryMs ?? null;
    const hnsw = s.methods.find((m) => m.method === "hnsw")?.medianQueryMs ?? null;
    if (exact !== null && hnsw !== null && hnsw < exact) return s.n;
  }
  return null;
};

const vectorLiteral = (v: ReadonlyArray<number>): string => `[${v.join(",")}]`;

/** A random unit-ish vector, rounded to keep the literal small. */
const randomVector = (dims: number): ReadonlyArray<number> =>
  Array.from({ length: dims }, () => Math.round(Math.random() * 1e4) / 1e4);

const timeQueries = (queries: ReadonlyArray<string>, k: number) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const ids: Array<ReadonlyArray<string>> = [];
    const times: Array<number> = [];
    for (const q of queries) {
      const [dur, rows] = yield* Effect.timed(
        sql<{ id: string; }>`
          SELECT id::text AS id FROM bench_vec ORDER BY embedding <=> ${q}::halfvec LIMIT ${k}`,
      );
      ids.push(rows.map((r) => r.id));
      times.push(Duration.toMillis(dur));
    }
    return { ids, medianMs: median(times) };
  });

const recallVsExact = (
  approx: ReadonlyArray<ReadonlyArray<string>>,
  exact: ReadonlyArray<ReadonlyArray<string>>,
): number => {
  let hit = 0;
  let total = 0;
  for (let i = 0; i < exact.length; i++) {
    const truth = new Set(exact[i]);
    total += truth.size;
    for (const id of approx[i] ?? []) if (truth.has(id)) hit++;
  }
  return total === 0 ? 0 : hit / total;
};

const populate = (n: number, dims: number) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    yield* sql`DROP TABLE IF EXISTS bench_vec`;
    yield* sql.unsafe(`CREATE TABLE bench_vec (id bigint PRIMARY KEY, embedding halfvec(${dims}))`);
    // Generate rows in Postgres in batches (a correlated subquery builds each row's random
    // vector). Batching keeps any single statement bounded.
    const BATCH = 2000;
    for (let start = 1; start <= n; start += BATCH) {
      const end = Math.min(n, start + BATCH - 1);
      yield* sql.unsafe(
        `INSERT INTO bench_vec (id, embedding)
         SELECT g,
           ('[' || (SELECT string_agg(round(random()::numeric, 4)::text, ',')
                    FROM generate_series(1, ${dims})) || ']')::halfvec
         FROM generate_series(${start}, ${end}) AS g`,
      );
    }
  });

const measureSize = (n: number, dims: number, nQueries: number, k: number) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    yield* Effect.logInfo(`crossover: N=${n} dims=${dims} — populating…`);
    yield* populate(n, dims);

    const queries = Array.from({ length: nQueries }, () => vectorLiteral(randomVector(dims)));

    // ── exact (no index) ──
    yield* sql`DROP INDEX IF EXISTS bench_hnsw`;
    const warm = timeQueries(queries.slice(0, 1), k); // warm the cache
    yield* warm;
    const exact = yield* timeQueries(queries, k);
    const exactMethod: MethodResult = {
      method: "exact",
      available: true,
      buildMs: null,
      medianQueryMs: exact.medianMs,
      recallAt10: 1,
      note: null,
    };

    // ── HNSW ──
    const [buildDur] = yield* Effect.timed(
      sql.unsafe(
        `CREATE INDEX bench_hnsw ON bench_vec USING hnsw (embedding halfvec_cosine_ops)`,
      ),
    );
    const hnsw = yield* timeQueries(queries, k);
    const hnswMethod: MethodResult = {
      method: "hnsw",
      available: true,
      buildMs: Math.round(Duration.toMillis(buildDur)),
      medianQueryMs: hnsw.medianMs,
      recallAt10: recallVsExact(hnsw.ids, exact.ids),
      note: null,
    };

    // ── DiskANN (pgvectorscale) — attempt, degrade to unavailable ──
    const diskann = yield* buildDiskann(queries, exact.ids, k);

    yield* sql`DROP TABLE IF EXISTS bench_vec`;
    return {
      n,
      dims,
      methods: [exactMethod, hnswMethod, diskann],
    } satisfies SizeResult;
  });

/** Try to build a DiskANN index and measure it; on any failure (extension absent, opclass
 * mismatch), report the leg as unavailable with the reason — never fail the run. */
const buildDiskann = (
  queries: ReadonlyArray<string>,
  exactIds: ReadonlyArray<ReadonlyArray<string>>,
  k: number,
) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    return yield* Effect.gen(function*() {
      yield* sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vectorscale CASCADE`);
      const [buildDur] = yield* Effect.timed(
        sql.unsafe(
          `CREATE INDEX bench_diskann ON bench_vec USING diskann (embedding halfvec_cosine_ops)`,
        ),
      );
      const res = yield* timeQueries(queries, k);
      yield* sql`DROP INDEX IF EXISTS bench_diskann`;
      return {
        method: "diskann" as const,
        available: true,
        buildMs: Math.round(Duration.toMillis(buildDur)),
        medianQueryMs: res.medianMs,
        recallAt10: recallVsExact(res.ids, exactIds),
        note: null,
      } satisfies MethodResult;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed(
          {
            method: "diskann" as const,
            available: false,
            buildMs: null,
            medianQueryMs: null,
            recallAt10: null,
            note: `unavailable: ${Cause.pretty(cause).slice(0, 140)}`,
          } satisfies MethodResult,
        )
      ),
    );
  });

export interface CrossoverInput {
  readonly sizes: ReadonlyArray<number>;
  readonly dims: number;
  readonly queries: number;
  readonly k: number;
}

/** Run the whole crossover sweep. Cleans up `bench_vec` even on interruption. */
export const runCrossover = (
  input: CrossoverInput,
): Effect.Effect<CrossoverReport, never, SqlClient> =>
  Effect.gen(function*() {
    const sizes: Array<SizeResult> = [];
    for (const n of [...input.sizes].sort((a, b) => a - b)) {
      sizes.push(yield* measureSize(n, input.dims, input.queries, input.k));
    }
    const diskannAvailable = sizes.some((s) =>
      s.methods.some((m) => m.method === "diskann" && m.available)
    );
    return {
      sizes,
      hnswCrossoverN: findHnswCrossover(sizes),
      diskannAvailable,
    } satisfies CrossoverReport;
  }).pipe(
    Effect.ensuring(
      Effect.gen(function*() {
        const sql = yield* SqlClient;
        yield* sql`DROP TABLE IF EXISTS bench_vec`.pipe(Effect.ignore);
      }).pipe(Effect.catchCause(() => Effect.void)),
    ),
    Effect.orDie,
  );
