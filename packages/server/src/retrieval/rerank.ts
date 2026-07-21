// Pure reranking utilities (architecture.md §11.6). A cross-encoder (bge-reranker-v2-m3)
// scores each candidate document against the query; this module turns those scores into a
// reordered candidate list. Kept pure — no DB, no vendor call — so the ordering logic
// unit-tests exhaustively and the adapter (adapters/reranker-bge.ts) only owns transport.
//
// The port returns one score per document, aligned by index (higher = more relevant).
// `reorderByScores` is a STABLE descending sort by score, so when the reranker is absent
// and returns identity scores, the input (fusion) order is preserved exactly — the
// degrade-to-identity guarantee (§14) is visible here, not just asserted.

/** Identity scores that preserve the input order under a descending sort: the first item
 * gets the highest score. Used as the degrade-to-identity fallback (§14) so a downed
 * reranker is a no-op reordering, never an error. */
export const identityScores = (n: number): ReadonlyArray<number> =>
  Array.from({ length: n }, (_, i) => n - i);

/**
 * Reorder `items` by `scores` (aligned by index), highest first, stably. Extra scores are
 * ignored; missing scores (shorter array) sort last in their original order. A stable sort
 * means equal scores keep their fusion order, so identity scores are a true no-op.
 */
export const reorderByScores = <A>(
  items: ReadonlyArray<A>,
  scores: ReadonlyArray<number>,
): ReadonlyArray<A> => {
  const decorated = items.map((item, i) => ({
    item,
    i,
    score: scores[i] ?? Number.NEGATIVE_INFINITY,
  }));
  decorated.sort((a, b) => (b.score - a.score) || (a.i - b.i)); // desc score, stable on ties
  return decorated.map((d) => d.item);
};
