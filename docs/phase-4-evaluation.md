# Evaluation Harness — Phase 4 Results

**Milestone M4 · Almanac (CECC Course Catalog RAG) · run 2026-07-21 against the live 731-course / 995-section corpus**

> The ruler was built before the thing it measures. Phase 4 shipped the evaluation harness **before** the chat UI (ADR-009) — so retrieval quality is a graded build artifact from the first answer, not a thing we hope to bolt on later.

| Metric               | Result        | What it means                                                                                                           |
| -------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **`filter_exact`**   | **100%**      | Every natural-language query compiled to the exactly-correct `ListingFilter` (headline metric — see the caveat in §5)   |
| **nDCG@10**          | **0.988**     | Ranked retrieval quality over 868 chunks; @10 is a real cutoff here (~1% of the corpus), not the usual trivially-near-1 |
| **Refusal accuracy** | **100%**      | Every out-of-scope / no-history-yet question correctly refused instead of hallucinating an answer                       |
| **Fee-×100 errors**  | **0**         | Zero instances of the `"$2,000" → 2000¢` off-by-100 that silently returns the wrong price band                          |
| **Router latency**   | **p50 ≈ 1 s** | NL → typed filter, per query                                                                                            |
| **CI gate**          | **green**     | Committed baseline; a PR that drops either headline metric >2 points fails the build                                    |

Scope: 95 tests green (`tsc` · `lint` · `dprint` · `vitest`); migrations `0001`–`0005`; the harness core (metrics, filter comparison, gate, report) is pure and unit-tested with **no database and no vendor call**.

---

## 1. Why an eval harness is the M4 deliverable

This system's thesis is that **query parsing, not retrieval, is the bottleneck.** Finding "cybersecurity" among 995 short course descriptions is trivial. Misreading _"under $2,000"_ as `2000` cents instead of `200000` is silent and catastrophic — the user gets a confidently wrong result set and never knows.

So the highest-leverage thing to measure isn't "did we retrieve relevant docs" (nearly free here) — it's **"did the model turn intent into the correct typed filter."** That question has directly-labelable ground truth, and Phase 4 exists to score it. ADR-009 makes the harness a hard prerequisite for the chat UI: you don't build the product before you build the instrument that tells you whether it works.

---

## 2. The golden set — 87 items, grounded in real data

Seven query _shapes_, stratified to fixed target shares (§11.1). Every item is authored against the **real 731-course corpus** — the course titles, campuses, fee bands, and terms all exist in the database — so the labels are **correct by construction, not aspirational.**

| Shape          | Items | Share | What it tests                                                     |
| -------------- | ----- | ----- | ----------------------------------------------------------------- |
| `lookup`       | 22    | ~25%  | A specific named course — the router must **not** invent a filter |
| `filtered`     | 26    | ~30%  | Hard predicates → `ListingFilter` (the `filter_exact` headline)   |
| `availability` | 8     | ~9%   | `"still open"` → `status`, a seat property, not a semantic search |
| `comparative`  | 9     | ~10%  | Two named courses; both must surface, filter stays null           |
| `eligibility`  | 5     | ~6%   | Prereq-aware questions about a specific answerable course         |
| `temporal`     | 5     | ~6%   | Recurrence / price-history — **no history tool yet, so refuse**   |
| `unanswerable` | 12    | ~14%  | Out of scope or too vague to route — refuse (§10.6)               |

**Labels are drift-proof.** `expected_ids` is **not** stored inline — it is _resolved at seed time_ against the live corpus, so it stays correct as the catalog drifts (a re-crawl adds a section, a sweep retires one). Three resolution strategies:

- **`filter`** — expected set = the courses whose live listings pass the labelled `expectedFilter`. Used for `filtered`/`availability`: correct by construction, and retrieval then measures the _filter compilation_, not a soft search.
- **`title`** — expected set = courses whose title matches a pattern (ILIKE). Used for the soft shapes (`lookup`/`comparative`/`eligibility`) where the answer is a specific known course and retrieval is a hybrid search.
- **`none`** — expected set = ∅. The correct answer is a **refusal** (`unanswerable`, plus the "I don't know yet" tail of `temporal`).

**Reproducible by construction.** Relative dates (_"before September"_) resolve against a **fixed `EVAL_TODAY` (2026-07-21)**, not wall-clock `now()`, and `eval_run.config` records it — so the same golden set scores identically on any machine, any day.

---

## 3. What we measure, and why each metric earns its place

### `filter_exact` — the headline

Given a natural-language query, did the router produce the **correct** `ListingFilter`? Both filters are encoded through the domain schema to a **canonical wire form** (sorted keys, absent optionals dropped, `Date` and its ISO string compare equal), then JSON-compared. `null` (a pure lookup — no hard predicate) is its own canonical form, distinct from an empty `{}`.

### The retrieval trio — nDCG@10 / recall@10 / MRR

Binary relevance against the ground-truth course set. Worth noting: **@10 is a genuine cutoff here** — 10 of 868 chunks is ~1% of the corpus — unlike the typical RAG setting where recall@10 is trivially near 1. All three functions are total over string IDs and make no DB or vendor call, so they're exhaustively unit-tested.

### Per-field near-misses — catching the _silent_ failures

An aggregate hides the failure mode that matters most. So beyond the binary match, every field disagreement is classified:

| Diff kind      | Meaning                                          | Why it's tracked separately                                                                           |
| -------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| **`fee_x100`** | `maxFeeCents`/`minFeeCents` off by exactly 100×  | The `"$2,000" → 2000¢` catastrophe — invisible in an aggregate, wrong result set, zero error surfaced |
| `extra`        | An over-eager predicate the query didn't ask for | The filter that "works against the user" — hides the Fall section of the very course they wanted (§8) |
| `missing`      | An under-read predicate                          | The query said it; the router dropped it                                                              |
| `mismatch`     | Right field, wrong value                         | Everything else                                                                                       |

### Refusal, and per-shape reporting

Refusal accuracy is scored over the `unanswerable` + `temporal` slices. Everything is reported **per shape, not as one number** — a single aggregate would hide exactly the finding you need (§11.5).

---

## 4. The regression gate — retrieval quality as a build artifact

> A PR that drops `filter_exact` or nDCG@10 by more than **2 points** against `main` fails.

The gate is a pure comparison (unit-tested, no DB) against a **committed baseline snapshot** (`eval/baseline.json`), refreshed from a green `main` run. Both metrics are expressed in percentage points so "2 points" means the same on each. A secret-guarded GitHub Actions workflow runs it on every PR.

This is the point of the whole phase: **the harness's job is to catch the first regression the day it happens** — a prompt edit that quietly re-introduces the fee-×100 bug, a retrieval change that drops a shape. The 100% is a starting line, not a finish line, and the gate is what makes it hold.

---

## 5. Honesty about the 100%

**`filter_exact` at 100% is a co-designed clean-mapping baseline, and this document says so.** The `filtered`/`availability` `expectedFilter`s encode the exact §8 mappings the router prompt teaches; `filter_exact` measures whether the model faithfully _reproduces the mappings it was designed against._ It is **not** a claim that query understanding is solved.

What the number actually demonstrates:

- The **canonicalization is right** — Date/ISO equivalence, null-vs-`{}`, key ordering all handled, so the metric doesn't lie in either direction.
- The router **reliably clears the traps that were specified** — the ×100 fee scaling, `NULL`-safe `isEvening`, `"still open"` as a seat status rather than a search term, campus-vs-online disambiguation, relative dates against a fixed clock, and out-of-scope → refuse.
- The **instrumentation is in place** to detect the first time that stops being true.

The value here is the _harness, the near-miss classifier, and the gate_ — not the headline digit. Presenting a clean number without that framing would be inventing a result; the framing is the result.

---

## 6. Eval-driven development — the harness changed the code

The router prompt was **tuned twice off eval findings**, not off intuition:

1. It **over-refused** `comparative` and `eligibility` questions — treating "compare the LSAT and GRE prep" as out-of-scope. The eval slice caught it; the fix taught the router that two named courses is a valid decomposition, not a refusal.
2. It **over-read course-name tokens as filters** — pulling a spurious predicate out of a course title. Again surfaced by the per-shape breakdown, fixed against the `lookup` slice.

Neither was visible from spot-checking. The per-shape report made both obvious, and re-running the suite proved the fix. That loop — _measure → find the failing shape → fix → re-gate_ — is the entire reason the harness ships before the UI.

---

## 7. What is deliberately **not** measured yet

- **`prose_faithful`** — the faithfulness of connective prose is a Phase 5 metric, because it needs the answer agent + an LLM judge, which don't exist until the chat loop does. The column is present in `eval_result`; it's `NULL` in Phase 4.
- **`cost_micros`** — Phase 4 scores the router only (NL → filter), not answer generation, so there's no per-answer token cost to record yet.
- **The competitor crossover** (compact-index baseline) — a later slice.

Naming what isn't measured is part of the discipline: a metric that reads as `100%` next to one that reads as `n/a` is more trustworthy than a dashboard of green that quietly omits the hard parts.

---

## Appendix — implementation notes

- **Router:** `router-gemini` turns NL → `ListingFilter`. It runs on Gemini rather than Anthropic because the `ListingFilter` schema has 21 optional-union fields and Anthropic's structured-output path caps at 16 — a real, documented adapter constraint, contained (per ports-and-adapters) to one file.
- **Runner:** `Effect.forEach(items, { concurrency: 5 })` → writes one `eval_result` row per item (`filter_exact`, `ndcg_10`, `recall_at_10`, `mrr`, `refused`, `latency_ms`) plus an `eval_run` header capturing `git_sha` and config.
- **Purity boundary:** metrics, filter comparison, the gate, and the report summarizer are all pure functions — they unit-test exhaustively with no Postgres and no network. Only the runner and seeder touch the database.
- **Reproduce it:** `pnpm --filter @catalog/server migrate` → `eval:seed` → `eval`. The run records its baseline and exits non-zero if the gate fails.
