# Almanac

**A course-catalog chatbot that can't make up the facts. The model picks which courses to show; Postgres supplies every number.**

<p>
  <a href="https://almanac-rag.pages.dev"><img alt="Live demo" src="https://img.shields.io/badge/live-almanac--rag.pages.dev-2ea44f"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white">
  <img alt="Effect" src="https://img.shields.io/badge/Effect-v4%20(beta)-000000">
  <img alt="PostgreSQL" src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white">
  <img alt="pgvector" src="https://img.shields.io/badge/pgvector-halfvec-4169E1">
  <img alt="Gemini" src="https://img.shields.io/badge/Gemini-Flash--Lite-4285F4?logo=googlegemini&logoColor=white">
  <img alt="tests" src="https://img.shields.io/badge/tests-160%2B-2ea44f">
</p>

> **▶ Try it live: [almanac-rag.pages.dev](https://almanac-rag.pages.dev)** — running on free-tier managed infra (Neon + Cloud Run + Cloudflare Pages).
>
> _(Scale-to-zero, so the first request after an idle period can take a few seconds to warm up.)_

Almanac addresses a common failure mode in retrieval-augmented chatbots: a user asks about a price or a date, the model reads the correct document, retypes the number, and gets it wrong. For any system meant to be trusted, that's disqualifying.

The design avoids it structurally. The language model is never allowed to emit a fact. It reads a university continuing-education catalog, decides _which_ courses answer a question, and writes the surrounding explanation — but every price, date, seat count, and status is read directly from Postgres when the card renders. A made-up "$450" where the catalog says "$415" isn't a bug to catch and tune away; it can't occur, because the number was never on the model's output path.

The system runs against a real catalog rather than a toy dataset: Rutgers' continuing-education site (`ce-catalog.rutgers.edu`), 995 live pages, crawled and re-crawled. Several early design assumptions were disproven by measuring that data; those corrections are kept in the git history and in this README rather than hidden.

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

Note what's missing: there's no `price`, no `date`, no `status`, no `seats`. Those fields don't exist in the model's output schema, so there's nothing to fill in wrong. Every factual value is hydrated from Postgres at render time and shown on a card.

The result is a clean split: **facts are correct by construction, and the only thing that can drift is the connecting prose — which is the narrow surface the evals target.**

---

## How it compares to just stuffing the prompt

For 995 short listings, the fair comparison isn't naive prompt-stuffing — it's a compact index: one ~50-token line per section, about 23k tokens total, small enough to keep in the prompt. Measured in Phase 8, it's competitive on simple lookups. It falls short in four places, and those four are what the rest of the design is for:

|                                | Compact-index baseline                                                      | Almanac                                     |
| ------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------- |
| **Exhaustive filtered recall** | Attention isn't a `WHERE` clause — it misses rows                           | Deterministic SQL                           |
| **Factual guarantee**          | Model reads the fee and retypes it — can drift                              | Hydrated from Postgres — can't drift        |
| **Freshness**                  | As stale as the last prompt rebuild                                         | `status` read at render time                |
| **Memory**                     | No source to read — last term's catalog is gone once the site overwrites it | `disappeared_at` + a field-level change log |

The last row is the one that's out of reach for the baseline entirely. Once the site overwrites last term's data, it's gone from everywhere a prompt could read it, so no amount of context helps. That's why ingestion shipped first: the only way to answer "what did this cost last fall?" is to have started recording before the site overwrote it.

A goal of the project is to be explicit about where a compact index is good enough and where this design earns its added complexity.

### What the numbers say (Phase 8)

Each capability was enabled one at a time and scored by query shape on an 87-item golden set. Full table and methodology in [`docs/phase-8-ablation.md`](./docs/phase-8-ablation.md); the rows that matter most:

| Config                     | filter_exact | nDCG (lookup) | nDCG (filtered) | Memory | p95 |
| -------------------------- | ------------ | ------------- | --------------- | ------ | --- |
| naive vector only          | —            | 1.00          | 0.40            | —      | 8ms |
| + hybrid RRF + reranker    | —            | 0.98          | 0.40            | —      | 6ms |
| **+ typed filter routing** | **100%**     | 0.98          | **1.00**        | —      | 6ms |
| + retention & history      | 100%         | 0.98          | 1.00            | **✓**  | 6ms |

Two results stand out. First, `+ typed filter routing` is the significant one: filtered-query nDCG goes from 0.40 to 1.00 — a language model's attention isn't a `WHERE` clause, and the gap is clear in the numbers. Second, on 995 short docs the extra retrieval machinery (hybrid, reranker, prefixes) buys almost nothing — lookup is already 1.00 without it. That points to a query-_understanding_ problem more than a retrieval one, which matches the original design intent; the ablation confirms it rather than assuming it.

---

## How retrieval works

The insight the whole thing is built on:

> Most catalog queries are structured database queries wearing a natural-language costume.

Take _"Evening cybersecurity classes starting before September, under $2,000, in Newark?"_ That's four hard predicates (time-of-day, date, price, campus) and one soft one (the topic). Cosine similarity only helps with one of the five. So retrieval is structured-first, and a router decomposes every query:

```
                 ┌── hard predicates → filter_listings   (parameterized SQL, deterministic)
query ── router ─┤
                 └── soft topic      → search_catalog    (hybrid vector + BM25, RRF)
                                │
                         intersect on course_id
                                ▼
           model emits [listing_ids] + prose  ──►  hydrate.ts reads Postgres  ──►  live cards
```

**Hybrid search in one round trip.** Vector kNN and BM25 full-text search are fused by Reciprocal Rank Fusion inside a single SQL statement — no merging in application code. The vector side catches "cybersecurity"; the lexical side catches exact course codes and acronyms that embeddings smear together.

**No vector index, on purpose (ADR-004).** The whole vector set is about 736 chunks, roughly 1.7 MB. An exact scan runs in a few milliseconds (p50 ~3.6 ms end to end), which is invisible next to the ~1-second router call. A [crossover sweep](./docs/phase-8-ablation.md#3-adr-004-crossover--exact-vs-hnsw-vs-diskann) quantifies the trade-off: HNSW does have lower raw kNN latency past ~1k rows, but at its default settings recall drops from 91% to 23% as the corpus grows toward 100k, and the build takes 5.6 minutes. The exact scan is 100% recall, zero build, zero tuning. So skipping the index is a recall and operational-cost win at the size this actually runs at, not a latency compromise.

**The hard part is parsing the query, not finding the document.** Locating "cybersecurity" among 995 short docs is easy. Misreading "under $2,000" as `2000` cents instead of `200000` is silent and does real damage. So the component that matters most is turning intent into a correct typed `ListingFilter`, and it gets its own eval slice with directly-labeled ground truth and a headline `filter_exact` metric. The parsed filter also surfaces in the UI as editable chips, so the model's interpretation is always visible and correctable.

Two refinements, each done as a clean single-variable experiment:

- **Contextual retrieval** — a cheap model writes a one-sentence situating prefix for each chunk before embedding (_"Continuing-ed course in the Effective School Practices unit on numeracy, offered online"_), which lifts both vector and lexical recall for under a dollar across the whole corpus.
- **Prerequisite chains** — the one spot where a graph is actually warranted, handled with a 15-line recursive CTE (with a depth guard, because the catalog data contains cycles) instead of standing up a graph database.

---

## How it stays current — and how it remembers

Three separate mechanisms, kept deliberately distinct:

**1. Freshness comes for free.** Because facts are hydrated at render time, answers are always live — `Status: Course Full` is read from Postgres the moment the card renders. There's no "rebuild the index so prices are current" step. Even replaying a three-week-old conversation re-hydrates today's seat status, because chat history stores `card_ids`, not frozen card contents.

**2. Ingestion is cheap and safe.** A durable, resumable crawl re-fetches the site politely (rate-limited, `robots.txt` respected). Two ideas do most of the work here:

- **Segmented hashing** — each page splits into a _course_ half (title, description, changes over years) and a _listing_ half (status, dates, fees, changes daily). A seat flipping Full → Open only moves the listing hash, so a byte-identical description never gets re-embedded.
- **The gated sweep** — anything not seen on a crawl gets marked gone. The naive version (`UPDATE … WHERE last_seen_at < crawl_start`) will, if a crawl 500s halfway through, silently declare hundreds of courses dead — permanently, since the past can't be re-observed. So the sweep refuses to run unless the crawl completed _and_ saw at least 80% of the previous page count. This has been exercised in practice: a follow-up 20-page crawl had its sweep correctly refused, with zero rows wrongly marked gone.

**3. Memory the live catalog can't have.** The site only publishes what's offered right now; last term's price and the date a section filled up are gone once overwritten. So retention is the default, and it's the one capability with a deadline that can't be bought back later:

- **Stop deleting** — `disappeared_at` retires a listing without dropping the row.
- **A change log, not row versions** — status churns daily, so full row-versioning (SCD-2) would spawn thousands of near-identical rows. `listing_change` logs field-level deltas on a whitelist ("section 289 went full on this date").
- **Honesty about the window** — history only builds forward, and today it's `n = 1` term. One sighting of a summer section is not evidence it "runs every summer," so the system stores its `observing_since` epoch and refuses claims the observation window can't support. Ask _"Does this run every year?"_ and "I don't know yet" is the correct, graded answer.

The clock is already running — the 995-page crawl seeded the observation epoch. Every day the design sat unbuilt was a day of catalog history getting overwritten, which is why ingestion shipped first.

---

## Design decisions and trade-offs

Much of the engineering here is about what was deliberately _not_ built. Each of these carries a written ADR:

| Decision                      | Instead of                | Why                                                                                                           |
| ----------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Exact vector scan             | HNSW / IVFFlat index      | 1.7 MB set — a sub-ms exact scan beats ANN at 100% recall (ADR-004)                                           |
| Recursive CTE                 | Graph database            | Prerequisite chains are 15 lines of SQL                                                                       |
| Field-level change log        | SCD-2 row versioning      | Daily status churn would make thousands of junk rows; a delta log is the right shape (ADR-011)                |
| Observation time only         | Bitemporal modeling       | Claiming valid-time would claim precision the data can't support (ADR-011)                                    |
| One router, five tools        | Multi-agent orchestration | Auditable in a single file                                                                                    |
| `fetch` + parser              | Headless browser          | No JS to execute; ~633 ms mean parse, nothing to amortize (ADR-002)                                           |
| Retrieval over 995 docs       | Fine-tuning               | Retrieval isn't the bottleneck — query parsing is                                                             |
| Parameterized `ListingFilter` | Free-form text-to-SQL     | No injection surface, no hallucinated columns; text-to-SQL is a gated, separately-measured fallback (ADR-005) |

The architecture is ports and adapters: the domain layer imports zero vendor code, so when a pre-1.0 AI SDK or an Effect beta path shifts, the blast radius is one file under `adapters/`.

---

## Assumptions the data disproved

An early measurement pass against the live corpus disproved several starting assumptions. They're documented here rather than quietly corrected, because the corrections shaped the design:

- **Assumed: three disjoint course-data template families (A/B/C).** Wrong — the structured column this relied on was empty on all 995 pages; those keys belonged to a different reference scraper entirely. The real signal is one template with a required core and a long optional tail (144 key-signatures on a smooth 8→20 gradient). The result: one extraction schema with nullable optional fields, not three per-family prompts.
- **Assumed: the course code could serve as an answer key.** It's present on 99% of pages, but the values are inconsistent (`YD0805`, `Polestar`, `ULA-2026-20274`) and often shifted a row by a label/value misalignment in the source table. It's a field to verify, not an oracle.
- **Assumed: sections-per-course was high enough to justify the split on embedding economics alone.** Measured, it's 1.36 — so the real justification is the two different _lifetimes_ on every page (course vs. listing), not a ratio that turned out not to support it.

Measuring before committing, and recording which assumptions the data changed, keeps the design grounded in what it's actually based on.

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

Built in phases against a live source. The status below is current — a working, deployed system rather than a demo.

| Phase                    | Scope                                                                                                                                                                                   | State                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| 0 · Foundations          | Effect v4 spine, dual SQL clients, migrations, telemetry, test harness, CI                                                                                                              | ✅ shipped                |
| 1 · Re-crawl & retention | 995 pages re-crawled (0 errors), raw markdown + fields stored, courses grouped (732), retention clock started, gated sweep verified refusing a short crawl                              | ✅ shipped                |
| 2 · Extraction           | One-schema typed extractor + 13 hazard tests + field-level change logging; 994 pages → 731 courses / 2,016 fees / 213 relations                                                         | ✅ shipped                |
| 3 · Retrieval            | Chunk + embed, hybrid RRF search, exact-scan kNN; 731 chunks+embeddings indexed, `/search` live, exact-scan p50 ~4 ms (ADR-004 confirmed)                                               | ✅ shipped                |
| 4 · Eval harness         | 87-item golden set (7 shapes) + runner + CI gate, before the chat UI. filter_exact 100% · nDCG@10 0.99 · refusal 100% · 0 fee-×100 errors                                               | ✅ shipped                |
| 5 · Chat & hydration     | Router, the `CardRef → Card` hydration guarantee, SSE typed events, grounded refusal, single-active-run; prose_faithful ~81% (LLM judge)                                                | ✅ shipped                |
| 6 · Web UI               | Astro + vanilla-TS: cards, editable filter chips (re-run with no LLM), zero-result relaxation, freshness, feedback → eval; OpenAI-compatible `/v1` + Open WebUI                         | ✅ shipped                |
| 7 · History querying     | `course_history` + deterministic observation-window honesty ("I don't know yet" at n=1); temporal eval slice; synthetic-history test harness                                            | ✅ shipped                |
| 8 · Ablation & baselines | The results table by shape, compact-index competitor measured, ADR-004 crossover published, bge reranker behind the port — see [`docs/phase-8-ablation.md`](./docs/phase-8-ablation.md) | ✅ shipped                |
| 9 · Ship                 | Terraform infra (Neon + Cloud Run + Cloudflare Pages), CI deploy on push to `main`, **live at [almanac-rag.pages.dev](https://almanac-rag.pages.dev)**                                  | ✅ shipped — **deployed** |

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

Requirements: Node ≥ 22, pnpm 10, Docker, and a Gemini API key. Everything else is provisioned by the compose file and the seed script.

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

A few ways to exercise it:

```sh
SEARCH_QUERY="evening cybersecurity" pnpm --filter @catalog/server search   # retrieval smoke test
pnpm --filter @catalog/server eval                                          # golden-set harness
pnpm test                                                                   # unit + testcontainer suite
```

Note: `pnpm seed` re-crawls the live catalog, which starts a fresh retention clock (the observation window can't be backfilled). That's the right call for a fresh dev DB; to preserve accrued history from another machine, `pg_dump`/`pg_restore` the volume instead of re-crawling. `pnpm db:down` stops the DB (`-v` also wipes the volume).

---

<sub>Almanac is a personal engineering project built against a public course catalog. It extracts facts and links out; page prose stays at the source. No authenticated pages, student data, or PII.</sub>
