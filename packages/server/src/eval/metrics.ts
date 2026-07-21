// Pure retrieval metrics (architecture.md §11.2). Binary relevance: an eval item's
// `expected_ids` is the ground-truth course set; retrieval returns a RANKED course-id
// list. We score nDCG@k / recall@k / MRR over that ranking. "10 of 868 is ~1%", so @10
// is a valid cutoff here (§11.2) — unlike the usual RAG setting where recall@10 is
// trivially near 1. All functions are total over `string` ids and make no DB or vendor
// call, so they unit-test exhaustively.

const log2 = (x: number): number => Math.log(x) / Math.log(2);

/** Discounted cumulative gain of the first `k` results under binary relevance. */
const dcgAt = (
  retrieved: ReadonlyArray<string>,
  relevant: ReadonlySet<string>,
  k: number,
): number => {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, retrieved.length); i++) {
    if (relevant.has(retrieved[i]!)) dcg += 1 / log2(i + 2); // rank i (0-based) → 1/log2(i+2)
  }
  return dcg;
};

/**
 * nDCG@k. The ideal ranking puts all `min(|relevant|, k)` relevant docs first, so the
 * ideal DCG is a prefix of the discount series. Returns 0 when nothing is relevant
 * (the caller records NULL for refusal items rather than scoring them).
 */
export const ndcgAt = (
  retrieved: ReadonlyArray<string>,
  relevant: ReadonlySet<string>,
  k: number,
): number => {
  if (relevant.size === 0) return 0;
  const idealHits = Math.min(relevant.size, k);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) idcg += 1 / log2(i + 2);
  return idcg === 0 ? 0 : dcgAt(retrieved, relevant, k) / idcg;
};

/** recall@k — fraction of the relevant set that appears in the top `k`. */
export const recallAt = (
  retrieved: ReadonlyArray<string>,
  relevant: ReadonlySet<string>,
  k: number,
): number => {
  if (relevant.size === 0) return 0;
  let hit = 0;
  const top = retrieved.slice(0, k);
  for (const id of relevant) if (top.includes(id)) hit++;
  return hit / relevant.size;
};

/** Reciprocal rank of the FIRST relevant result (1-based); 0 if none is retrieved. */
export const mrr = (
  retrieved: ReadonlyArray<string>,
  relevant: ReadonlySet<string>,
): number => {
  for (let i = 0; i < retrieved.length; i++) {
    if (relevant.has(retrieved[i]!)) return 1 / (i + 1);
  }
  return 0;
};

/** Mean of a numeric list, or null when empty (so an empty slice reads as "n/a"). */
export const meanOrNull = (xs: ReadonlyArray<number>): number | null =>
  xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;
