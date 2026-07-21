# Almanac

**A structured-first, fact-grounded RAG for course catalogs — the model chooses rows, the database speaks the facts, and it remembers what the catalog forgot.**

<p>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white">
  <img alt="Effect" src="https://img.shields.io/badge/Effect-v4%20(beta)-000000">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white">
  <img alt="pgvector" src="https://img.shields.io/badge/pgvector-halfvec-4169E1">
  <img alt="Anthropic" src="https://img.shields.io/badge/Claude-Haiku%2FSonnet-D97757">
  <img alt="tests" src="https://img.shields.io/badge/tests-120%20green-2ea44f">
</p>

Almanac turns a public university continuing-education catalog into a chat interface you can _trust with a price_. It is a deliberate answer to the failure mode of most retrieval-augmented chatbots: the language model reads a retrieved document, retypes a number, and quietly gets it wrong. Here that is structurally impossible — the model never emits a fact.

> Built against a **real** corpus: Rutgers' continuing-education catalog (`ce-catalog.rutgers.edu`), **995 live pages**, re-crawled and measured — not a toy dataset. Several early design decisions were _killed_ by that measurement, and the git history shows it.

---

## The thesis

> **The model chooses rows. The database speaks the facts. And it remembers what the catalog forgot.**

The LLM is allowed to emit exactly two things:

```ts
// The entire contract the model may return
class CardRef {
  listingId: ListingId;
  why: string;
} // a pointer + one line
class Answer {
  prose: string;
  cards: CardRef[];
  filter: ListingFilter | null;
}
```

No `price`. No `date`. No `status`. No `seats`. Those fields **do not exist** in the model's output schema, so it cannot fill them in wrong. Every factual value is **hydrated from Postgres at render time** and shown as a card. A hallucinated `$450` where the catalog says `$415` isn't a faithfulness metric to tune toward 1.0 — it's _unreachable_, because the number was never on the model's output path.

The consequence, stated as a testable claim rather than a vibe:

**Facts are guaranteed by construction; only the connective prose can drift — and we measure exactly that, on exactly the narrow surface where drift is possible.**

---

## Why this isn't "just another RAG wrapper"

The honest baseline for 995 short listings isn't naive prompt-stuffing — it's a **compact index**: one ~50-token line per course, ~54k tokens, cacheable, in-window. That baseline is genuinely _competitive_ on lookup and comparison, and this README says so. It loses decisively on four things, and those four are the entire justification for the project:

|                                | Compact-index baseline                                                              | Almanac                                     |
| ------------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------- |
| **Exhaustive filtered recall** | Attention is not a `WHERE` clause — it will miss rows                               | Deterministic SQL                           |
| **Factual guarantee**          | Model reads the fee and retypes it — can drift                                      | Hydrated from Postgres — cannot drift       |
| **Freshness**                  | As stale as the last prompt rebuild                                                 | `status` read at render time                |
| **Memory**                     | _Impossible at any price_ — last term's catalog isn't on the web to put in a prompt | `disappeared_at` + a field-level change log |

The last row is qualitatively different: it isn't _harder_ for the baseline, it's **unavailable to it forever**, because the information no longer exists anywhere a prompt can reach. Nobody at the institution can currently answer _"what did this cost last fall?"_ Almanac can — but only if it started keeping records before the site overwrote them, which is why ingestion shipped first.

**Knowing where your system is overkill, and naming the exact crossover where it wins, is the point.**

---

## How retrieval works

The load-bearing insight:

> **Most queries are structured queries wearing a natural-language costume.**

> _"Evening cybersecurity classes starting before September, under $2,000, in Newark?"_

That's **four hard predicates** (time-of-day, date, price, campus) and **one soft one** (the topic). Cosine similarity serves exactly _one_ of the five. So retrieval is **structured-first**, and a router decomposes every query:

```
                 ┌── hard predicates → filter_listings   (parameterized SQL, deterministic)
query ── router ─┤
                 └── soft topic      → search_catalog    (hybrid vector + BM25, RRF)
                                │
                         intersect on course_id
                                ▼
           model emits [listing_ids] + prose  ──►  hydrate.ts reads Postgres  ──►  live cards
```

**Hybrid search, one round trip.** Vector kNN and BM25 full-text are fused by **Reciprocal Rank Fusion** in a single SQL statement — no application-side merge. Semantic recall catches _"cybersecurity"_; lexical recall catches exact course codes and acronyms that embeddings blur.

**No vector index — on purpose (ADR-004).** The entire vector set is ~870 chunks ≈ **1.7 MB**. An exact sequential scan computes distances in **well under a millisecond — faster than HNSW, at 100% recall** — with no index to build, no `ef_search` to tune, and no post-filter overfiltering hazard. The decision is written as a _threshold_ ("add an index above ~50k chunks"), not a guess, which is why it survived a 3× revision to the corpus estimate without changing.

**Query parsing is the real bottleneck, not retrieval.** Finding "cybersecurity" among 995 short documents is trivial. Misreading _"under $2,000"_ as `2000` cents instead of `200000` is silent and catastrophic. So the highest-leverage component is turning intent into a correct typed `ListingFilter` — and it gets its own eval slice with directly-labelable ground truth (`expected_filter`) and a headline metric (`filter_exact`). The filter round-trips to the UI as **editable chips**, so the model's interpretation is always visible and correctable.

Two refinements, each a clean single-variable ablation:

- **Contextual retrieval** — a cheap model writes a one-sentence situating prefix per chunk before embedding (_"Continuing-ed course in the Effective School Practices unit on numeracy, offered online"_), lifting both vector and lexical recall for under a dollar across the whole corpus.
- **Prerequisite chains** — the one place a graph is warranted, done in a 15-line recursive CTE (with a depth guard, because catalog data contains cycles) instead of a graph database.

---

## How it stays current — and remembers

Three _distinct_ mechanisms, kept deliberately separate:

**1. Freshness is free.** Because facts are hydrated at render time, answers are always live — `Status: Course Full` is read from Postgres the moment the card renders. There is no "rebuild the index so prices are current" step. Even replaying a three-week-old conversation re-hydrates _today's_ seat status, because chat history stores `card_ids`, not frozen card contents.

**2. Ingestion is cheap and safe.** A durable, resumable crawl re-fetches the site politely (rate-limited, `robots.txt` respected). Two safety ideas do the heavy lifting:

- **Segmented hashing** — each page is split into a _course_ half (title, description — changes over years) and a _listing_ half (status, dates, fees — changes daily). A seat flipping `Full → Open` moves only the listing hash, so it never re-embeds a byte-identical description.
- **The gated sweep** — anything not re-seen gets marked gone. The naive `UPDATE … WHERE last_seen_at < crawl_start` will, on a crawl that 500s halfway, **silently declare hundreds of courses dead — permanently, because you cannot re-observe the past.** So the sweep refuses unless the crawl completed _and_ saw ≥80% of the previous page count. **Verified in practice:** a follow-up 20-page crawl had its sweep correctly _refused_ — zero rows wrongly marked gone.

**3. Memory the live catalog cannot have.** The site publishes only what's offered _now_; last term's price and the date a section filled are unrecoverable once overwritten. So retention is the default, and it's the one capability with a deadline money can't buy back:

- **Stop deleting** — `disappeared_at` retires a listing without dropping the row.
- **A change log, not row versions** — status churns daily, so SCD-2 would spawn thousands of near-identical rows. `listing_change` logs _field-level deltas_ on a whitelist ("section 289 went full on this date").
- **Honesty about the window** — history only accrues forward. Today `n = 1` term. One sighting of a summer section is _not_ evidence it "runs every summer," and the system stores its `observing_since` epoch so it can **refuse claims the observation window can't support**. _"Does this run every year?"_ → _"I don't know yet"_ is the graded-correct answer, not a UI nicety.

**The clock is already running** — the 995-page crawl seeded the observation epoch. Every day this design sat unbuilt was a day of history the catalog was overwriting.

---

## Decisions worth defending

Half of the engineering here is what was deliberately _not_ built. Each carries a written ADR:

| Decision                      | Instead of                | Why                                                                                                           |
| ----------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Exact vector scan             | HNSW / IVFFlat index      | 1.7 MB set — sub-ms exact scan beats ANN at 100% recall (ADR-004)                                             |
| Recursive CTE                 | Graph database            | Prerequisite chains are 15 lines of SQL                                                                       |
| Field-level change log        | SCD-2 row versioning      | Daily status churn → thousands of junk rows; a delta log is the right shape (ADR-011)                         |
| Observation time only         | Bitemporal modelling      | Claiming valid-time would claim precision the data can't support (ADR-011)                                    |
| One router, five tools        | Multi-agent orchestration | Auditable in a single file                                                                                    |
| `fetch` + parser              | Headless browser          | No JS to execute; ~633 ms mean parse, nothing to amortize (ADR-002)                                           |
| Retrieval over 995 docs       | Fine-tuning               | Retrieval isn't the bottleneck — query parsing is                                                             |
| Parameterized `ListingFilter` | Free-form text-to-SQL     | No injection surface, no hallucinated columns; text-to-SQL is a gated, separately-measured fallback (ADR-005) |

The architecture is **ports & adapters**: the domain layer imports zero vendor code, so when a pre-1.0 AI SDK or an Effect beta path moves, the blast radius is one file under `adapters/`.

---

## Grounded in real data — assumptions that got killed

A milestone-0 measurement pass against the live corpus falsified the project's own earlier design, on the record:

- **"Three disjoint course-data template families (A/B/C)."** Wrong. The structured column was empty on all 995 pages — those keys belonged to a _different_ reference scraper. The real signal is one template with a required core and a long optional tail (144 key-signatures on a smooth 8→20 gradient). Consequence: **one extraction schema with nullable optional fields**, not three per-family prompts.
- **"345 pages carry a clean course code — use it as an answer key."** The code is present on 99% of pages but its _values_ are inconsistent (`YD0805`, `Polestar`, `ULA-2026-20274`) — often shifted one row by a label/value misalignment in the source table. It's a field to **verify**, not an oracle.
- **"Sections/course is high enough to justify the split on embedding economics alone."** Measured at **1.36** — so the split is justified by the two _lifetimes_ visible on every page (course vs. listing), not by a ratio that doesn't carry the argument.

Measuring first, then writing down which of your own arguments the data destroyed, is the difference between an architecture and a wish.

---

## Tech stack

- **Language / runtime** — TypeScript (strict), Node 22+, pnpm workspace
- **Effect v4** — typed errors, dependency injection via `Layer`, durable workflows, `HttpApi`, `Schema` as the single source of truth for both wire types and DB decode. Pinned to one exact beta (`4.0.0-beta.99`); the whole `@effect/*` ecosystem now lives under `effect/unstable/*`.
- **PostgreSQL 16 + pgvector** — one database does structured filtering, full-text (BM25 via `tsvector`), and vector search (`halfvec`). Dual clients: pooled through PgBouncer for queries, a direct admin connection for DDL only.
- **Anthropic Claude** — Haiku-class for extraction and chunk-context (a full extraction pass over 995 pages costs ~$4), Sonnet-class for the chat router.
- **Web** — Astro 5 + a lean vanilla-TS island importing the domain contracts (`Card`/`ListingFilter`), calling the server's JSON endpoints. Editable filter chips re-run with no LLM call; a second OpenAI-compatible `/v1` surface drops into Open WebUI.
- **Testing** — `@effect/vitest` + Testcontainers (real Postgres per suite, transaction-rollback isolation). 120 tests green across `tsc` · `oxlint` · `dprint` · `vitest` · `astro check`, run in CI.

---

## Status

Honest and current — this is a system being built in phases against a live source, not a demo.

| Phase                    | Scope                                                                                                                                                                                    | State                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 0 · Foundations          | Effect v4 spine, dual SQL clients, migrations, telemetry, test harness, CI                                                                                                               | ✅ shipped                          |
| 1 · Re-crawl & retention | 995 pages re-crawled (0 errors), `raw_markdown` + `page_fields` stored, course-grouping resolved (732 courses), **retention clock started**, gated sweep verified refusing a short crawl | ✅ shipped — _the clock is running_ |
| 2 · Extraction           | One-schema typed extractor + 13 hazard tests + field-level change logging; **994 pages extracted → 731 courses / 2,016 fees / 213 relations** (Gemini)                                   | ✅ shipped                          |
| 3 · Retrieval            | Chunk + embed, hybrid RRF search, exact-scan kNN; **731 chunks+embeddings indexed, `/search` live, exact-scan p50 ~4 ms** (ADR-004 confirmed)                                            | ✅ shipped                          |
| 4 · Eval harness         | 87-item golden set (7 shapes) + runner + §11.4 CI gate — _before_ the chat UI. **`filter_exact` 100% · nDCG@10 0.99 · refusal 100% · 0 fee-×100 errors**                                 | ✅ shipped                          |
| 5 · Chat & hydration     | Router, the `CardRef → Card` hydration guarantee, SSE typed events, grounded refusal, single-active-run; **`prose_faithful` ~81%** (LlmJudge)                                            | ✅ shipped                          |
| 6 · Web UI               | Astro + vanilla-TS: cards, **editable filter chips** (re-run with no LLM), zero-result relaxation, freshness, feedback→eval; **OpenAI-compatible `/v1`** + Open WebUI quadlet            | ✅ shipped                          |
| 7 · History querying     | `course_history` over the accrued retention window                                                                                                                                       | ▷ designed                          |

The [architecture document](./architecture.md) is the authoritative artifact and carries the full reasoning, DDL, ADRs, and eval design.

---

## Repository layout

```
packages/
  domain/    Schemas + ports. ZERO vendor imports — the two §4 contracts live here.
  server/    Adapters (Postgres, fetch, embedder, answerer, reranker) · config · errors
             · telemetry · migrations · ingest/sweep · http · main.ts (the one composition root).
apps/
  web/       Astro + effect-atom UI (Phase 6).
docs/
  architecture.md                    The design, authoritative.
  initial-architecture-plan-1.md     Implementation plan, phase by phase.
  initial-architecture-progress-1.md Living progress tracker + decision log.
```

## Getting started

**Prerequisites** — Node ≥ 22, pnpm 10, and Docker. Everything else is provisioned by the compose file and the seed script.

```sh
# 1. Install + configure
pnpm install
cp .env.example .env          # then set GEMINI_API_KEY (extraction + embeddings)

# 2. Start the database — pgvector Postgres, published on host :5433
pnpm db:up                    # docker compose up -d (named volume: data survives restarts)

# 3. Seed the corpus end to end (~6 min crawl + Gemini extraction/embeddings)
pnpm seed                     # migrate → crawl → extract:sync → index → eval:seed

# 4. Run it
pnpm dev:server               # boot main.ts → GET /health, POST /chat, /search, /relax, /hydrate, /v1/*
pnpm dev:web                  # Astro product UI on :4321 (proxies /api/* → :3000) — cards, chips, relaxation
```

Then verify:

```sh
pnpm --filter @catalog/server report                       # per-field extraction rates
SEARCH_QUERY="evening cybersecurity" \
  pnpm --filter @catalog/server search                     # hybrid retrieval smoke test
pnpm --filter @catalog/server eval                         # golden-set harness (±2 gate)
pnpm test                                                  # domain unit + testcontainer spine
```

**`.env` loads automatically.** Every entrypoint imports [`src/env.ts`](./packages/server/src/env.ts), which loads the repo-root `.env` via `dotenv` before any config is read — so the commands above work on a bare shell (no `source .env` needed). Real environment variables always win, so CI / production, which export their own, are unaffected.

**About the seed.** `pnpm seed` re-crawls the live catalog, which starts a fresh retention clock (`system_epoch` / `first_seen_at`) — the observation window can't be backfilled. That's the right choice for a fresh dev DB; to preserve accrued M1 history from another machine, `pg_dump`/`pg_restore` the volume instead of re-crawling. Individual stages are also available under `pnpm --filter @catalog/server <migrate|crawl|extract:sync|index|eval:seed>`. `pnpm db:down` stops the DB (add `-v` to wipe the volume and start clean).

**Other tasks** — `pnpm build` (tsc -b), `pnpm lint` (oxlint), `pnpm format` (dprint fmt).

---

<sub>Almanac is a personal engineering project built against a public course catalog. It extracts facts and links out; page prose stays at the source. No authenticated pages, student data, or PII.</sub>
