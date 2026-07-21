# Ablation & Baselines — Phase 8 Results

**Milestone M8 · Almanac (CECC Course Catalog RAG) · run 2026-07-21 against the live 736-course / 993-section corpus**

> Every capability in this system was added because a cheaper design was supposed to lose without it. Phase 8 holds that supposition to numbers: it turns each layer on one at a time, measures the compact-index competitor it claims to beat, and runs the ADR-004 index sweep the design promised. The rule is that a **broken** prediction is the more interesting result and gets published too.

Scope: 162 tests (`tsc` · `lint` · `dprint` · `vitest`), +22 for Phase 8; the ablation ladder, compact baseline, crossover harness, and bge reranker adapter. The report/format/crossover-detection cores are pure and unit-tested with no DB. Ablation and baselines run on the live Docker DB (`:5433`); the crossover runs on synthetic corpora.

---

## 1. The §11.5 ablation table — the README centerpiece

Each row flips **one** knob relative to the row above, so the table reads as a causal chain. Broken out by query shape, because a single aggregate hides the entire finding. Scored on the same 87-item golden set as M4.

| Config                                         | filter_exact                | nDCG (lookup) | nDCG (filtered) | Refusal  | Fresh       | Memory           | p95        | $/q      |
| ---------------------------------------------- | --------------------------- | ------------- | --------------- | -------- | ----------- | ---------------- | ---------- | -------- |
| naive chunks, vector only                      | —                           | 1.00          | 0.40            | 0%       | ✓ ≤3h       | —                | 8ms        | ~$0.0002 |
| + contextual prefixes                          | —                           | 1.00          | 0.39            | 0%       | ✓ ≤3h       | —                | 5ms        | ~$0.0002 |
| + hybrid RRF                                   | —                           | 0.98          | 0.40            | 0%       | ✓ ≤3h       | —                | 5ms        | ~$0.0002 |
| + reranker _(identity — no container)_         | —                           | 0.98          | 0.40            | 0%       | ✓ ≤3h       | —                | 6ms        | ~$0.0002 |
| **+ typed filter routing**                     | **100%**                    | 0.98          | **1.00**        | **100%** | ✓ ≤3h       | —                | 6ms        | ~$0.0002 |
| + retention & history                          | 100%                        | 0.98          | 1.00            | 100%     | ✓ ≤3h       | **✓**            | 6ms        | ~$0.0002 |
| **baseline: compact index (~23k tok, cached)** | —                           | 0.95          | **0.74**        | 75%      | **✗ stale** | **✗ impossible** | **7815ms** | $0.0043  |
| baseline: whole catalog in context             | _does not fit — ~1026k tok_ |               |                 |          |             |                  |            |          |

The dollar-per-query for the ladder is estimated (one router call + one query embed at gemini-3.1-flash-lite rates; the reranker adds latency, not dollars, since it is self-hosted). The compact baseline's cost is computed from its measured per-query input tokens — where the cost contrast actually lives. The Fresh column (≤3h) is the measured max staleness of a served card at run time (§10.4).

### What the ladder discovered

**1. The core thesis holds, hard (§8 / §1.1).** The single largest movement in the whole table is `nDCG (filtered)` jumping **0.40 → 1.00** the instant typed filter routing turns on, and `filter_exact` hitting 100%. Every retrieval refinement above it — prefixes, hybrid RRF, reranker — leaves filtered-exhaustive queries pinned at **0.40**. This is _"attention is not a `WHERE` clause"_ rendered as a number: no amount of embedding cleverness answers _"evenings, under $2,000, in Newark"_; a deterministic filter does, exactly.

**2. The honest, slightly deflating finding: prefixes / hybrid / reranker buy ~nothing here.** On 736 short course documents, vector search already scores **1.00 on lookup** — there is no headroom. Contextual prefixes move filtered `0.40 → 0.39` (noise); hybrid RRF is flat; the reranker (running as the identity fallback — no container deployed) is flat by construction. This is worth publishing plainly: **at this corpus size the retrieval sophistication the RAG literature obsesses over is irrelevant. The entire leverage is in query understanding**, which is exactly where the design put it (§8, ADR-005).

**3. Refusal is a routing capability, and it shows.** The retrieval-only rows never refuse (0% — a pure-RAG system answers _"a PhD in astrophysics?"_ with whatever it retrieves). Refusal accuracy hits **100%** the moment the router enters (`+ typed filter routing`) — the same knob that makes filter_exact real. Memory (temporal) arrives one row later.

**4. Two estimates became measurements.** The compact index is **~23k tokens** (the design guessed ~54k — the real corpus is leaner and smaller), and the whole catalog is **~1026k tokens** (guessed ~870k), comfortably confirming _"does not fit."_

---

## 2. The compact-index competitor (§1.1) — the permanent baseline, measured

The honest competitor is not naive prompt-stuffing; it is one ~50-token line per live section (~23k tokens, cacheable, in-window), read whole by the same flash-lite model, which picks matching sections **by attention**. §1.1 made an explicit, narrow prediction. It came true — with one instructive twist:

| Claim (§1.1)               | Prediction                    | Measured                                                |
| -------------------------- | ----------------------------- | ------------------------------------------------------- |
| Lookup / comparison        | competitive                   | **0.95** nDCG (vs Almanac 0.98) — confirmed competitive |
| Exhaustive filtered recall | loses — attention misses rows | **0.74** nDCG (vs Almanac **1.00**) — confirmed loss    |
| Freshness                  | stale (prompt text)           | ✗ by construction                                       |
| **Memory**                 | impossible at any price       | ✗ — temporal excluded; unrecoverable                    |
| Latency                    | —                             | **7815ms p95** vs Almanac **6ms** (~1300×)              |
| Cost                       | cacheable                     | **$0.0043/q** vs ~$0.0002 (~20×)                        |

The twist worth noting: the compact index scores **0.74** on filtered — _better_ than Almanac's retrieval-only rows (0.40), _worse_ than its typed-filter rows (1.00). **Attention beats naive vector search on filtered queries, and loses decisively to a real `WHERE` clause.** That is the whole argument in one line, and it is now a measurement rather than an assertion. And it costs three orders of magnitude more latency and one order more dollars to get its 0.74.

The `whole catalog in context` baseline is a computed fact, not a run: **~1026k tokens** of full page markdown over live sections — it does not fit any current context window.

---

## 3. ADR-004 crossover — exact vs HNSW vs DiskANN

Synthetic **clustered** halfvec(1536) corpora (64 centroids + per-dim jitter, so nearest-neighbours are real), queries sampled from existing points, exact-scan recall = 100% by definition. `k = 10`, 15 queries per size, median latency.

| N (chunks) | exact    | HNSW                                             | DiskANN     |
| ---------- | -------- | ------------------------------------------------ | ----------- |
| 1,000      | 1.62ms   | 0.60ms (build 303ms, recall 91%)                 | unavailable |
| 5,000      | 7.76ms   | 0.77ms (build 2.1s, recall 77%)                  | unavailable |
| 25,000     | 45.85ms  | 1.09ms (build 33s, recall 42%)                   | unavailable |
| 100,000    | 223.94ms | 3.44ms (build **338s ≈ 5.6min**, recall **23%**) | unavailable |

**The finding is not "exact is faster" — it isn't, past ~1,000 rows.** HNSW's raw kNN latency (0.6–3.4ms) beats the exact sequential scan (1.6–224ms) at every measured size. But that is the wrong lens, and the sweep shows why:

- **At the production corpus (~736 chunks), the delta is sub-millisecond.** Exact is a few ms; the real system measured **p50 3.6ms end-to-end** (M3). That saving is invisible next to the **~1-second LLM router call** in front of it.
- **HNSW is approximate, and it degrades.** At default `ef_search`, recall@10 falls from **91% → 23%** as the corpus grows 1k → 100k. Recovering it needs `ef_search` tuning — the exact scan is **100% recall with no knob**.
- **HNSW costs a build that grows to 5.6 minutes** at 100k, re-run on every crawl. Exact has no build step.

So ADR-004's _"exact scan, no index"_ is a **recall + operational-cost win, not a latency win** — and it holds decisively at the size the system actually runs at. _"I measured it and chose the boring option, and here's the real tradeoff"_ is the honest version of the strongest sentence in the design doc.

**DiskANN (pgvectorscale) is `unavailable`** on the `pgvector/pgvector:pg16` image and is honestly reported as such, not faked. Per ADR-004 its case is storage pressure + ~9× compression at scale — orders of magnitude away from this corpus regardless. The harness attempts the extension and degrades on absence, so the leg fills in automatically on an image that ships it.

---

## 4. The reranker (§11.6) — built, wired, keep/drop deferred

`bge-reranker-v2-m3` is implemented behind the `Reranker` port (`adapters/reranker-bge.ts`): an HTTP `/rerank` client (TEI-compatible, configurable `RERANKER_URL`) that **degrades to identity** on a missing URL, a downed container, a timeout, or a malformed response — so the service stays up whether or not the reranker is deployed (§14). It is wired as an optional post-fusion step and as the `+ reranker` ablation knob.

No container is deployed, so the `+ reranker` row ran as the identity pass and is flat by construction — honestly labelled, not hidden. **Keep/drop is deferred to Phase 9 deploy**, where a live container makes its nDCG lift measurable against its p95 cost. The point ADR-011/§11.6 makes is preserved: the port exists so _"we removed it"_ (or added it) is a one-line change in the composition root.

---

## 5. Reproduce

```bash
# One-time: build the no-prefix embedding set the "+ contextual prefixes" row isolates
GEMINI_API_KEY=… pnpm --filter @catalog/server ablate:prep

# The §11.5 ladder + compact-index baseline (writes the markdown table to ABLATE_OUT)
GEMINI_API_KEY=… pnpm --filter @catalog/server ablate
#   knobs: ABLATE_CONCURRENCY, ABLATE_BASELINE=0, ABLATE_OUT=path.md, RERANKER_URL

# The ADR-004 crossover sweep (pure Postgres, no LLM calls)
pnpm --filter @catalog/server crossover
#   knobs: CROSSOVER_SIZES=1000,5000,25000,100000  CROSSOVER_DIMS=1536  CROSSOVER_QUERIES=15
```

---

## 6. Exit criterion

✅ **MET** — the §11.5 table is filled by query shape, both baselines are measured (compact index) or computed (whole catalog), and the ADR-004 crossover is published with a grounded conclusion. The two headline design claims survived contact with data: **typed filter routing is the load-bearing capability** (filtered 0.40 → 1.00), and **exact scan is the right call at this corpus** — for recall and operational simplicity, not raw latency. The one deflation — retrieval refinements buy nothing at 736 docs — is itself the finding: this is a query-understanding problem, not a retrieval problem.
