import type { AblationRow } from "./ablation.js";
import type { BaselineResult } from "./compact-baseline.js";
import type { CrossoverReport, SizeResult } from "./crossover.js";

// Renders the Phase-8 findings as the §11.5 "README centerpiece": the ablation ladder
// (broken out by query shape), the two baselines, and the ADR-004 crossover table. Pure —
// no DB, no Effect — so the formatting unit-tests and the runner just prints/writes it.
//
// $/q is an ESTIMATE at documented gemini-3.1-flash-lite rates (input $0.10/1M, output
// $0.40/1M as of this writing) — the ladder rows cost one router call + one query embed
// (config-independent); the reranker adds latency, not $ (self-hosted, §13). The compact
// baseline's $/q is computed from its MEASURED per-query input tokens (the ~54k index),
// which is where the cost contrast actually lives.

const IN_PER_MTOK = 0.1;
const OUT_PER_MTOK = 0.4;

/** Estimated USD for one call at flash-lite rates. */
export const estimateCostUsd = (inputTokens: number, outputTokens: number): number =>
  (inputTokens / 1e6) * IN_PER_MTOK + (outputTokens / 1e6) * OUT_PER_MTOK;

// A ladder query = one router call (~2k in / ~60 out) + one query embed (~negligible $).
const LADDER_COST_USD = estimateCostUsd(2000, 60);

const pct = (x: number | null): string => (x === null ? "—" : `${x.toFixed(0)}%`);
const f2 = (x: number | null): string => (x === null ? "—" : x.toFixed(2));
const usd = (x: number): string => `$${x.toFixed(4)}`;
const tokK = (x: number): string => `~${Math.round(x / 1000)}k`;

export interface AblationReportInput {
  readonly rows: ReadonlyArray<AblationRow>;
  readonly baseline: BaselineResult | null;
  readonly crossover: CrossoverReport | null;
  readonly freshMaxHours: number | null; // max staleness of a served card (§10.4)
  readonly itemCount: number;
  readonly gitSha: string;
}

const freshCell = (h: number | null): string => (h === null ? "✓" : `✓ ≤${h}h`);

/** The §11.5 ablation table as GitHub-flavored markdown. */
export const formatAblationTable = (input: AblationReportInput): string => {
  const lines: Array<string> = [];
  lines.push(
    "| Config | filter_exact | nDCG (lookup) | nDCG (filtered) | Refusal | Fresh | Memory | p95 | $/q |",
  );
  lines.push(
    "| ------ | ------------ | ------------- | --------------- | ------- | ----- | ------ | --- | --- |",
  );
  for (const r of input.rows) {
    lines.push(
      `| ${r.label} | ${pct(r.filterExactPct)} | ${f2(r.ndcgLookup)} | ${f2(r.ndcgFiltered)} | `
        + `${pct(r.refusalPct)} | ${freshCell(input.freshMaxHours)} | ${r.memory ? "✓" : "—"} | `
        + `${r.p95Ms}ms | ${usd(LADDER_COST_USD)} |`,
    );
  }
  const b = input.baseline;
  if (b !== null) {
    const avgIn = b.avgInputTokens ?? 0;
    const avgOut = b.avgOutputTokens ?? 0;
    lines.push(
      `| **${b.label}** | — | ${f2(b.ndcgLookup)} | ${f2(b.ndcgFiltered)} | ${pct(b.refusalPct)} | `
        + `**✗ stale** | **✗ impossible** | ${b.p95Ms}ms | ${
          usd(estimateCostUsd(avgIn, avgOut))
        } |`,
    );
    lines.push(
      `| baseline: whole catalog in context | _does not fit — ${
        tokK(b.wholeCatalogTokens)
      } tok_ | | | | | | | |`,
    );
  }
  return lines.join("\n");
};

const ms = (x: number | null): string => (x === null ? "—" : `${x.toFixed(2)}ms`);
const recall = (x: number | null): string => (x === null ? "—" : `${(x * 100).toFixed(0)}%`);
const build = (x: number | null): string => (x === null ? "—" : `${x}ms`);

const crossoverRow = (s: SizeResult): string => {
  const m = (name: "exact" | "hnsw" | "diskann") => s.methods.find((x) => x.method === name);
  const exact = m("exact");
  const hnsw = m("hnsw");
  const disk = m("diskann");
  const diskCell = disk?.available
    ? `${ms(disk.medianQueryMs)} (build ${build(disk.buildMs)}, recall ${recall(disk.recallAt10)})`
    : "unavailable";
  return `| ${s.n.toLocaleString("en-US")} | ${ms(exact?.medianQueryMs ?? null)} | `
    + `${ms(hnsw?.medianQueryMs ?? null)} (build ${build(hnsw?.buildMs ?? null)}, recall ${
      recall(hnsw?.recallAt10 ?? null)
    }) | ${diskCell} |`;
};

/** The ADR-004 crossover table as markdown. */
export const formatCrossoverTable = (report: CrossoverReport): string => {
  const lines: Array<string> = [];
  const dims = report.sizes[0]?.dims;
  lines.push(
    `ADR-004 crossover — synthetic halfvec(${dims ?? "?"}) corpora, exact-scan recall = 100%:\n`,
  );
  lines.push("| N (chunks) | exact | HNSW | DiskANN |");
  lines.push("| ---------- | ----- | ---- | ------- |");
  const ordered = [...report.sizes].sort((a, b) => a.n - b.n);
  for (const s of ordered) lines.push(crossoverRow(s));
  lines.push("");

  // The honest reading is NOT "exact is faster" — past ~1k rows HNSW's raw kNN latency wins.
  // It is that at the production corpus the latency delta is sub-millisecond (dwarfed by the
  // ~1 s LLM router call), while exact keeps 100% recall and zero build cost, and HNSW at
  // default params sheds recall and grows a multi-minute rebuild as the corpus scales. Pull
  // those two curves out of the data so the conclusion is grounded, not asserted.
  const hnswOf = (s: SizeResult) => s.methods.find((m) => m.method === "hnsw");
  const recalls = ordered.map((s) => hnswOf(s)?.recallAt10 ?? null).filter((x): x is number =>
    x !== null
  );
  const builds = ordered.map((s) => hnswOf(s)?.buildMs ?? null).filter((x): x is number =>
    x !== null
  );
  const firstRecall = recalls[0] ?? null;
  const lastRecall = recalls[recalls.length - 1] ?? null;
  const maxBuild = builds.length > 0 ? Math.max(...builds) : null;
  const bigN = ordered[ordered.length - 1]?.n ?? null;
  const recallStr = firstRecall !== null && lastRecall !== null
    ? `HNSW recall@10 falls from ${recall(firstRecall)} to ${recall(lastRecall)}`
    : "HNSW is approximate";
  const buildStr = maxBuild !== null && bigN !== null
    ? `, and its build grows to ${(maxBuild / 1000).toFixed(0)}s at N=${
      bigN.toLocaleString("en-US")
    }`
    : "";
  lines.push(
    report.hnswCrossoverN === null
      ? "**Crossover: none in range** — exact sequential scan wins on latency at every measured "
        + `size, and ${recallStr}${buildStr}. ADR-004 holds outright.`
      : `**Crossover (latency): HNSW's kNN latency dips below exact at N ≈ ${
        report.hnswCrossoverN.toLocaleString("en-US")
      }** — but that is the wrong lens. At the production ~736 chunks the exact scan is a few `
        + `ms (measured p50 3.6 ms end-to-end, §M3), dwarfed by the ~1 s LLM router call, so the `
        + `index would buy a sub-millisecond saving. Against that: ${recallStr} at default `
        + `\`ef_search\`${buildStr}, while exact is 100% recall with no build and no tuning. `
        + `**ADR-004's "no index" is a recall + operational-cost win, not a latency loss — and it `
        + `holds decisively at the corpus size the system actually runs at.**`,
  );
  if (!report.diskannAvailable) {
    lines.push(
      "> DiskANN (pgvectorscale) is not installed on the `pgvector/pgvector:pg16` image, so its "
        + "column is `unavailable`. ADR-004: DiskANN's case is storage pressure + ~9× compression "
        + "at scale — off by orders of magnitude here regardless.",
    );
  }
  return lines.join("\n");
};

/** A compact console summary of one ablation run (not the markdown table). */
export const formatConsoleSummary = (input: AblationReportInput): string => {
  const lines: Array<string> = [];
  lines.push(
    `\n═══ Ablation (§11.5) · ${input.itemCount} items @ ${input.gitSha.slice(0, 8)} ═══\n`,
  );
  lines.push(formatAblationTable(input));
  if (input.baseline !== null) {
    lines.push(
      `\nCompact index: ${input.baseline.indexLines} lines · ${
        tokK(input.baseline.indexTokens)
      } tok (model ${input.baseline.model}). Whole catalog: ${
        tokK(input.baseline.wholeCatalogTokens)
      } tok (does not fit).`,
    );
  }
  return lines.join("\n");
};
