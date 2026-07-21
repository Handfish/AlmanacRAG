# Almanac

**A course-catalog chatbot that can't make up the facts. The model picks which courses to show; Postgres supplies every number.**

<p>
  <a href="https://almanac.pages.dev"><img alt="Live demo" src="https://img.shields.io/badge/live-almanac.pages.dev-2ea44f"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white">
  <img alt="Effect" src="https://img.shields.io/badge/Effect-v4%20(beta)-000000">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white">
  <img alt="pgvector" src="https://img.shields.io/badge/pgvector-halfvec-4169E1">
  <img alt="Gemini" src="https://img.shields.io/badge/Gemini-Flash--Lite-4285F4?logo=googlegemini&logoColor=white">
  <img alt="tests" src="https://img.shields.io/badge/tests-160%2B-2ea44f">
</p>

> **▶ Try it live: [almanac-rag.pages.dev](https://almanac-rag.pages.dev)** — running on free-tier managed infra (Neon + Cloud Run + Cloudflare Pages).

Hi — I'm Kenny. Almanac is a personal project I built to solve a problem I kept seeing in retrieval-augmented chatbots: you ask about a price or a date, the model reads the right document, retypes the number, and quietly gets it wrong. That's a dealbreaker if you actually want people to trust the answer.

So I built it a different way. The language model in Almanac is never allowed to type a fact. It reads a real university continuing-education catalog, decides *which* courses answer your question, and writes the explanation around them — but every price, date, seat count, and status is pulled straight from Postgres when the card renders. A made-up "$450" where the catalog says "$415" isn't a bug I have to catch and tune away; it simply can't happen, because the number was never something the model could produce.

I built it against a real catalog, not a toy dataset: Rutgers' continuing-ed site (`ce-catalog.rutgers.edu`), 995 live pages, crawled and re-crawled. A few of my early design decisions got killed by actually measuring that data, and I left that story in the git history and this README rather than hiding it.

---

## The core idea

The model is only ever allowed to return two things:

```ts
// The entire contract the model may return
class CardRef {
  listingId: ListingId;
  why: string;
} // a pointer + one line of reasoning
class Answer {
  prose: string;
  cards: CardRef[];
  filter: ListingFilter | null;
}
```

Notice what's missing: there's no `price`, no `date`, no `status`, no `seats`. Those fields don't exist in the model's output schema, so it has nothing to fill in wrong. Every factual value gets hydrated from Postgres at render time and shown on a card.

The result is a clean split: **facts are guaranteed correct by construction, and the only thing that can drift is the connecting prose — so that's the narrow surface I actually measure.**

---

## Why this isn't "just another RAG wrapper"

For 995 short listings, the honest competitor isn't naive prompt-stuffing — it's a compact index: one ~50-token line per section, about 23k tokens total, small enough to just keep in the prompt. I measured it ([Phase 8](./docs/phase-8-ablation.md)), and it's genuinely competitive on simple lookups. Where it falls apart is exactly the stuff that justifies the whole project:

|                                | Compact-index baseline                                                          | Almanac                                     |
| ------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------- |
| **Exhaustive filtered recall** | Attention isn't a `WHERE` clause — it misses rows                               | Deterministic SQL                           |
| **Factual guarantee**          | Model reads the fee and retypes it — can drift                                  | Hydrated from Postgres — can't drift        |
| **Freshness**                  | As stale as the last prompt rebuild                                             | `status` read at render time                |
| **Memory**                     | Impossible at any price — last term's catalog isn't on the web to put in a prompt | `disappeared_at` + a field-level change log |

That last row is the interesting one. It isn't *harder* for the baseline, it's flat-out impossible, because once the site overwrites last term's data it's gone from everywhere a prompt could reach. Nobody at the school can currently answer *"what did this cost last fall?"* Almanac can — but only if it started keeping records before the site overwrote them, which is why I shipped ingestion first.

Knowing where a system is overkill, and being able to name the exact point where it starts winning, was one of the goals here.

### What the numbers say (Phase 8)

I turned each capability on one at a time and scored it by query shape on an 87-item golden set. Full table and methodology in [`docs/phase-8-ablation.md`](./docs/phase-8-ablation.md); the rows that carry the argument:

| Config                     | filter_exact | nDCG (lookup) | nDCG (filtered) | Memory | p95   |
| -------------------------- | ------------ | ------------- | --------------- | ------ | ----- |
| naive vector only          | —            | 1.00          | 0.40            | —      | 8ms   |
| + hybrid RRF + reranker    | —            | 0.98          | 0.40            | —      | 6ms   |
| **+ typed filter routing** | **100%**     | 0.98          | **1.00**        | —      | 6ms   |
| + retention & history      | 100%         | 0.98          | 1.00            | **✓**  | 6ms   |

Two things jumped out. First, the row that matters is `+ typed filter routing`: filtered-query nDCG goes from 0.40 to 1.00. Attention really isn't a `WHERE` clause, and now I have the number to prove it. Second, on 995 short docs the fancy retrieval stuff (hybrid, reranker, prefixes) buys essentially nothing — lookup is already 1.00 without it. That told me this is a query-*understanding* problem, not a retrieval problem, which is exactly how I'd designed it, but it was good to have the data confirm it instead of just assuming.

---

## How retrieval works

The insight the whole thing is built on:

> Most catalog queries are structured database queries wearing a natural-language costume.

Take *"Evening cybersecurity classes starting before September, under $2,000, in Newark?"* That's four hard predicates (time-of-day, date, price, campus) and one soft one (the topic). Cosine similarity only helps with one of the five. So retrieval is structured-first, and a router pulls every query apart:

```
                 ┌── hard predicates → filter_listings   (parameterized SQL, deterministic)
query ── router ─┤
                 └── soft topic      → search_catalog    (hybrid vector + BM25, RRF)
                                │
                         intersect on course_id
                                ▼
           model emits [listing_ids] + prose  ──►  hydrate.ts reads Postgres  ──►  live cards
```

**Hybrid search in one round trip.** Vector kNN and BM25 full-text search get fused by Reciprocal Rank Fusion inside a single SQL statement — no merging in application code. The vector side catches "cybersecurity"; the lexical side catches exact course codes and acronyms that embeddings smear together.

**No vector index, on purpose (ADR-004).** The whole vector set is about 736 chunks, roughly 1.7 MB. An exact scan runs in a few milliseconds (p50 ~3.6 ms end to end), which is invisible next to the ~1-second router call. I ran the [crossover sweep](./docs/phase-8-ablation.md#3-adr-004-crossover--exact-vs-hnsw-vs-diskann) to check myself: HNSW does have lower raw kNN latency past ~1k rows, but at its default settings recall drops from 91% to 23% as the corpus grows toward 100k, and the build takes 5.6 minutes. The exact scan is 100% recall, zero build, zero tuning. So skipping the index is a recall and operational-cost win at the size this actually runs at, not a latency compromise.

**The hard part is parsing the query, not finding the document.** Locating "cybersecurity" among 995 short docs is trivial. Misreading "under $2,000" as `2000` cents instead of `200000` is silent and catastrophic. So the highest-leverage piece is turning intent into a correct typed `ListingFilter`, and it gets its own eval slice with directly-labeled ground truth and a headline `filter_exact` metric. The parsed filter also shows up in the UI as editable chips, so the model's interpretation is always visible and you can correct it.

Two refinements, each done as a clean single-variable experiment:

- **Contextual retrieval** — a cheap model writes a one-sentence situating prefix for each chunk before embedding (*"Continuing-ed course in the Effective School Practices unit on numeracy, offered online"*), which lifts both vector and lexical recall for under a dollar across the whole corpus.
- **Prerequisite chains** — the one spot where a graph is actually warranted, handled with a 15-line recursive CTE (with a depth guard, because the catalog data has cycles) instead of standing up a graph database.

---

## How it stays current — and how it remembers

Three separate mechanisms, kept deliberately distinct:

**1. Freshness comes for free.** Because facts are hydrated at render time, answers are always live — `Status: Course Full` is read from Postgres the moment the card renders. There's no "rebuild the index so prices are current" step. Even replaying a three-week-old conversation re-hydrates today's seat status, because chat history stores `card_ids`, not frozen card contents.

**2. Ingestion is cheap and safe.** A durable, resumable crawl re-fetches the site politely (rate-limited, `robots.txt` respected). Two ideas do most of the work here:

- **Segmented hashing** — each page splits into a *course* half (title, description, changes over years) and a *listing* half (status, dates, fees, changes daily). A seat flipping Full → Open only moves the listing hash, so a byte-identical description never gets re-embedded.
- **The gated sweep** — anything not seen on a crawl gets marked gone. The naive version (`UPDATE … WHERE last_seen_at < crawl_start`) will, if a crawl 500s halfway through, silently declare hundreds of courses dead — permanently, since you can't re-observe the past. So the sweep refuses to run unless the crawl completed *and* saw at least 80% of the previous page count. I've watched it work: a follow-up 20-page crawl had its sweep correctly refused, and zero rows were wrongly marked gone.

**3. Memory the live catalog can't have.** The site only publishes what's offered right now; last term's price and the date a section filled up are gone once overwritten. So retention is the default, and it's the one capability with a deadline you can't buy back later:

- **Stop deleting** — `disappeared_at` retires a listing without dropping the row.
- **A change log, not row versions** — status churns daily, so full row-versioning (SCD-2) would spawn thousands of near-identical rows. `listing_change` logs field-level deltas on a whitelist ("section 289 went full on this date").
- **Honesty about the window** — history only builds forward, and today it's `n = 1` term. One sighting of a summer section is not evidence it "runs every summer," so the system stores its `observing_since` epoch and will refuse claims the observation window can't support. Ask *"Does this run every year?"* and "I don't know yet" is the correct, graded answer.

The clock is already running — the 995-page crawl seeded the observation epoch. Every day this sat unbuilt was a day of catalog history getting overwritten, which is why ingestion was the first thing I shipped.

---

## Decisions I'm happy to defend

A lot of the engineering here is stuff I deliberately *didn't* build. Each one has a written ADR:

| Decision                      | Instead of                | Why                                                                                                       |
| ----------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------- |
| Exact vector scan             | HNSW / IVFFlat index      | 1.7 MB set — a sub-ms exact scan beats ANN at 100% recall (ADR-004)                                       |
| Recursive CTE                 | Graph database            | Prerequisite chains are 15 lines of SQL                                                                    |
| Field-level change log        | SCD-2 row versioning      | Daily status churn would make thousands of junk rows; a delta log is the right shape (ADR-011)            |
| Observation time only         | Bitemporal modeling       | Claiming valid-time would claim precision the data can't support (ADR-011)                                 |
| One router, five tools        | Multi-agent orchestration | Auditable in a single file                                                                                 |
| `fetch` + parser              | Headless browser          | No JS to execute; ~633 ms mean parse, nothing to amortize (ADR-002)                                        |
| Retrieval over 995 docs       | Fine-tuning               | Retrieval isn't the bottleneck — query parsing is                                                         |
| Parameterized `ListingFilter` | Free-form text-to-SQL     | No injection surface, no hallucinated columns; text-to-SQL is a gated, separately-measured fallback (ADR-005) |

The architecture is ports and adapters: the domain layer imports zero vendor code, so when a pre-1.0 AI SDK or an Effect beta path shifts, the blast radius is one file under `adapters/`.

---

## What the real data taught me

An early measurement pass against the live corpus proved some of my own earlier assumptions wrong, and I think that's worth showing rather than quietly fixing:

- **I assumed three disjoint course-data template families (A/B/C).** Wrong — the structured column I was counting on was empty on all 995 pages; those keys belonged to a different reference scraper entirely. The real signal is one template with a required core and a long optional tail (144 key-signatures on a smooth 8→20 gradient). So I went with one extraction schema with nullable optional fields instead of three per-family prompts.
- **I assumed the course code could serve as an answer key.** It's present on 99% of pages, but the values are inconsistent (`YD0805`, `Polestar`, `ULA-2026-20274`) and often shifted a row by a label/value misalignment in the source table. It's a field to verify, not an oracle.
- **I assumed sections-per-course was high enough to justify the split on embedding economics alone.** Measured, it's 1.36 — so the real justification is the two different *lifetimes* on every page (course vs. listing), not a ratio that doesn't actually carry the argument.

Measuring first, then writing down which of my own arguments the data destroyed, is a habit I lean on. It's the difference between an architecture and a wish.

---

## Tech stack

- **Language / runtime** — TypeScript (strict), Node 22+, pnpm workspace.
- **Effect v4** — typed errors, dependency injection via `Layer`, durable workflows, `HttpApi`, and `Schema` as the single source of truth for both wire types and DB decode. Pinned to one exact beta (`4.0.0-beta.99`).
- **PostgreSQL 16 + pgvector** — one database does structured filtering, full-text search (BM25 via `tsvector`), and vector search (`halfvec`). Two clients: pooled through PgBouncer for queries, a direct admin connection for DDL only.
- **Google Gemini** — Flash-Lite (`gemini-3.1-flash-lite`) for extraction, chunk-context, the NL→filter router, and the chat answerer/judge (a full extraction pass over 995 pages costs cents); `gemini-embedding-001` (1536-dim, stored as `halfvec`) for embeddings. One thin REST adapter behind the ports, so swapping providers is a one-file change.
- **Web** — Astro 5 with a lean vanilla-TS island that imports the domain contracts (`Card` / `ListingFilter`) and calls the server's JSON endpoints. Editable filter chips re-run with no LLM call; a second OpenAI-compatible `/v1` surface drops straight into Open WebUI.
- **Deployment** — Neon (Postgres + pgvector, scale-to-zero), Google Cloud Run (the API image), and Cloudflare Pages (static web + an `/api/*` proxy to Cloud Run). All infra is defined in Terraform (`infra/terraform`); app revisions ship from GitHub Actions on push to `main`.
- **Testing** — `@effect/vitest` + Testcontainers (a real Postgres per suite, transaction-rollback isolation). 160+ tests across `tsc`, `oxlint`, `dprint`, `vitest`, and `astro check`, all run in CI.

---

## Where it stands

I built this in phases against a live source, so the status is honest and current — it's a working system, now deployed, not a demo.

| Phase                    | Scope                                                                                                                                                                | State                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 0 · Foundations          | Effect v4 spine, dual SQL clients, migrations, telemetry, test harness, CI                                                                                          | ✅ shipped               |
| 1 · Re-crawl & retention | 995 pages re-crawled (0 errors), raw markdown + fields stored, courses grouped (732), retention clock started, gated sweep verified refusing a short crawl          | ✅ shipped               |
| 2 · Extraction           | One-schema typed extractor + 13 hazard tests + field-level change logging; 994 pages → 731 courses / 2,016 fees / 213 relations                                     | ✅ shipped               |
| 3 · Retrieval            | Chunk + embed, hybrid RRF search, exact-scan kNN; 731 chunks+embeddings indexed, `/search` live, exact-scan p50 ~4 ms (ADR-004 confirmed)                           | ✅ shipped               |
| 4 · Eval harness         | 87-item golden set (7 shapes) + runner + CI gate, before the chat UI. filter_exact 100% · nDCG@10 0.99 · refusal 100% · 0 fee-×100 errors                           | ✅ shipped               |
| 5 · Chat & hydration     | Router, the `CardRef → Card` hydration guarantee, SSE typed events, grounded refusal, single-active-run; prose_faithful ~81% (LLM judge)                            | ✅ shipped               |
| 6 · Web UI               | Astro + vanilla-TS: cards, editable filter chips (re-run with no LLM), zero-result relaxation, freshness, feedback → eval; OpenAI-compatible `/v1` + Open WebUI     | ✅ shipped               |
| 7 · History querying     | `course_history` + deterministic observation-window honesty ("I don't know yet" at n=1); temporal eval slice; synthetic-history test harness                        | ✅ shipped               |
| 8 · Ablation & baselines | The results table by shape, compact-index competitor measured, ADR-004 crossover published, bge reranker behind the port — see [`docs/phase-8-ablation.md`](./docs/phase-8-ablation.md) | ✅ shipped               |
| 9 · Ship                 | Terraform infra (Neon + Cloud Run + Cloudflare Pages), CI deploy on push to `main`, **live at [almanac.pages.dev](https://almanac.pages.dev)**                      | ✅ shipped — **deployed** |

The [architecture document](./architecture.md) is the authoritative writeup — full reasoning, DDL, ADRs, and eval design. Phase-8 findings live in [`docs/phase-8-ablation.md`](./docs/phase-8-ablation.md).

---

## Repository layout

```
packages/
  domain/    Schemas + ports. ZERO vendor imports — the two core contracts live here.
  server/    Adapters (Postgres, fetch, embedder, answerer, reranker) · config · errors
             · telemetry · migrations · ingest/sweep · http · main.ts (the one composition root).
apps/
  web/       Astro + effect-atom UI (Phase 6).
infra/
  terraform/ Neon + Cloud Run + Cloudflare Pages (Phase 9).
docs/
  architecture.md                    The design, authoritative.
  initial-architecture-plan-1.md     Implementation plan, phase by phase.
  initial-architecture-progress-1.md Living progress tracker + decision log.
```

## Running it locally

You'll need Node ≥ 22, pnpm 10, Docker, and a Gemini API key. Everything else is provisioned by the compose file and the seed script.

```sh
# Install, then start the database (pgvector Postgres on host :5433)
pnpm install
pnpm db:up

# Seed the corpus end to end (~6 min crawl + Gemini extraction/embeddings)
pnpm seed          # migrate → crawl → extract → index → eval:seed

# Run it
pnpm dev:server    # API: GET /health, POST /chat, /search, /relax, /hydrate, /v1/*
pnpm dev:web       # Astro UI on :4321 (proxies /api/* → :3000)
```

A couple of quick ways to poke at it:

```sh
SEARCH_QUERY="evening cybersecurity" pnpm --filter @catalog/server search   # retrieval smoke test
pnpm --filter @catalog/server eval                                          # golden-set harness
pnpm test                                                                   # unit + testcontainer suite
```

Heads up: `pnpm seed` re-crawls the live catalog, which starts a fresh retention clock (the observation window can't be backfilled). That's the right call for a fresh dev DB; to preserve accrued history from another machine, `pg_dump`/`pg_restore` the volume instead of re-crawling. `pnpm db:down` stops the DB (`-v` also wipes the volume).

---

<sub>Almanac is a personal engineering project built against a public course catalog. It extracts facts and links out; page prose stays at the source. No authenticated pages, student data, or PII.</sub>
