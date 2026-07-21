# CECC Course Catalog RAG — Progress Tracker

**Doc:** `initial-architecture-progress-1.md` · rev 7 · 2026-07-21
**Plan:** [`initial-architecture-plan-1.md`](./initial-architecture-plan-1.md) · **Design:** [`../architecture.md`](../architecture.md)

Living document. Update the status column and check boxes as work lands. Keep the **Decision log**
and **Blockers** current — they are where the plan meets reality.

**Legend:** ☐ not started · ◐ in progress · ☑ done · ⛔ blocked · ⏸ deferred

---

## Current state

|                      |                                                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phase**            | 4 — Evaluate — **DONE & RUN**. 87-item golden set + router (Gemini) + runner + §11.4 CI gate; `filter_exact` **100%**, nDCG@10 **0.99**, refusal **100%**, 0 fee-×100 errors, baseline recorded & gate green           |
| **Milestone (§16)**  | M0 ✅ · M1 ✅ · **M2 ✅** (994/995 extracted) · **M3 ✅** (retrieval live) · **M4 ✅** (eval harness + gate). Next: M5 Answer (router feeds the Toolkit loop; `prose_faithful` + LlmJudge)                             |
| **Repo**             | git repo (`main`) + pnpm workspace; effect **`4.0.0-beta.99`**; migrations `0001`–`0005`; **95 tests green** (`tsc`·`lint`·`dprint`·`vitest`). Router + eval harness + `filter_exact` reporting landed                 |
| **Source (real)**    | **`ce-catalog.rutgers.edu`** — index `searchResults.cfm?searchId=1`; detail links `a.chart` → `courseDisplay.cfm?schID=…`; grouping via `couID` (confirmed by owner). Not the 6-site business scraper                  |
| **Decisions locked** | D1 = **first-party `effect/unstable/ai`**; §17 Q1 = **couID is course id**; D6 = **table-driven resume**; D7 = **full-page capture**; **D9 = real-data pivot (one schema, no families)**; pin `beta.99`                |
| **AI providers**     | **Extraction + embeddings + context prefixes all on Gemini** (`gemini-3.1-flash-lite` / `gemini-embedding-001`). Anthropic `generateObject` is blocked by its 16-union tool-schema cap (our schema has 21)             |
| **Immediate gate**   | Phase 4 exit met (ADR-009: harness before the chat UI). Next: **Phase 5 (Answer)** — router → 5-tool loop, `Answer` schema + `CardRef→Card` hydration, SSE, grounded refusal; assert no factual field leaves the model |

---

## Phase 0 — Foundations ◐ (spine complete — exit criteria met; 3 non-blocking follow-ups remain)

_New phase; precedes §16 M1. Stand up the Effect v4 spine._ **Verified 2026-07-20:** `pnpm exec tsc -b`,
`pnpm test` (domain unit + testcontainer spine), `pnpm lint`, `dprint check` all green; `main.ts` boots
and `GET /health` → `200 {"status":"ok","service":"catalog"}`.

- [x] Toolchain verified: node 24.4.1, pnpm 10.11.0, git 2.39.2, bun 1.3.14
- [x] `git init` (`main`); `.gitignore` the four reference repos (reference-scraper, reference-catalog, reference-ai-chat, reference-ai-lib)
- [x] pnpm workspace: `packages/domain`, `packages/server` (ADR-I2, plan §4.2). **`apps/web` deferred to Phase 6** (glob `apps/*` already in `pnpm-workspace.yaml`)
- [x] Pin `effect` via root `pnpm.overrides` (ADR-I3) — **pinned `4.0.0-beta.99`** (networked install confirmed; newest beta coherent across `effect` + `@effect/sql-pg`/`platform-node`/`vitest`/`opentelemetry`/`ai-anthropic`)
- [x] **Re-audited `effect/unstable/*` export paths at beta.99**: `ai, sql, httpapi, http, workflow, schema, encoding, observability, persistence, reactivity, rpc` all present. Churn found & handled: `Config.*` are now **functions** (not consts); `PgClient` config has **no `prepare`/`fetchTypes`** (node-`pg` driver — §14 stale-prepared-statement hazard is structurally absent); `Context.Service<Self,Shape>()("tag")` one-arg port form confirmed
- [x] `tsconfig.base.json` (composite, 3 projects) + `@effect/language-service` plugin + `dprint` + `oxlint`. _Follow-up:_ enforce the `domain`-may-not-import-vendor boundary as a lint rule (currently convention only)
- [x] `AppConfig` service (`Config.all` + `Config.redacted` + `Config.withDefault`); `.env.example` (POSTGRES_URL:6432, POSTGRES_ADMIN_URL:5432, ANTHROPIC_API_KEY, …)
- [x] `SqlLive` (pooled :6432) + `SqlAdmin` (:5432) (ADR-I5, plan §6.2). _Adapted:_ `prepare/fetchTypes` don't exist on beta.99 `@effect/sql-pg`; split enforced by URL + config; pool hardened via `maxConnections`/`idleTimeout`
- [x] `PgMigrator.fromFileSystem` runner wired to `SqlAdmin` (`db/migrate.ts`); `0001_init` (`app_meta`) applies cleanly
- [x] Error skeleton (`Data.TaggedError` + `Match.typeTags` formatter in `server/errors.ts`; `Schema.TaggedErrorClass` for wire in `domain/errors.ts`)
- [x] Telemetry skeleton (`@effect/opentelemetry` `NodeSdk.layer`, OTLP trace export) — live: request spans logged at boot
- [x] Test harness: `@effect/vitest` + `@testcontainers/postgresql` (`postgres:16-alpine`) + `withTransactionRollback`. _Follow-up:_ mock-`LanguageModel` helper stub (needed Phase 5, not yet)
- [x] `main.ts` composition root; health endpoint boots (verified `200`)
- [x] Empty port tags in `domain` (KnowledgeBase, Extractor, Embedder, Reranker, Answerer, PageSource, Judge)
- [x] CI: `.github/workflows/ci.yml` (install → dprint check → tsc -b → lint → test); all steps green locally
- **Exit:** ✅ **MET** — testcontainer migration + `it.effect` against pooled `SqlClient` pass; `main.ts` serves `/health`
- **Deferred (non-blocking, not spine):** `apps/web` scaffold (Phase 6) · `domain` import-boundary lint rule · mock-`LanguageModel` stub (Phase 5)

## Phase 1 — Re-crawl ☑ (§16 M1 · **DONE** · the clock is running)

**Verified 2026-07-20 on live data:** full re-crawl of **995 pages, 0 errors** (~6 min, polite: concurrency 3,
300 ms delay ≈ 3 req/s); every page has `raw_markdown`+`raw_html`+`page_fields`+`group_url`+segmented hashes;
`system_epoch` seeded (clock started); a follow-up short crawl (20 pages) had its sweep **REFUSED**
("pages_seen 20 < 796 = 80% × 995"), **0 rows wrongly marked gone**. `tsc`·`oxlint`·`dprint`·`vitest` (31) all green.

- [x] ~~§17 Q1/Q3~~ **resolved** — Q1: the "More offerings like this" **image** link → `searchResults.cfm?couID=…` (authoritative course id); Q3: superseded by D7
- [ ] Check §17 **Q2** (families track `cecc_unit`?) & **Q5** (history already thrown away?) — deferred to Phase 2; the greenfield DB has no legacy `course_data` to query yet (run against the production crawler DB when available)
- [x] **Regenerate the scrape approach; capture the FULL page** (D7): `fetch` → `cheerio`/`turndown` → `raw_html` (archival) + `raw_markdown` (clean main-content view); extraction (Phase 2) reads the full page (ADR-010)
- [x] PageSource adapter (`adapters/fetch-page-source.ts`): `fetch` + conditional GET (etag/if-modified-since) + `AbortSignal` timeout + jittered exponential retry bounded to 3 (ADR-002); robots consulted by the orchestrator (`ingest/robots.ts`, wildcard-aware)
- [x] Ported `dates.ts` (chrono-node range parser) + `generateHash` (`utils.ts`) into `ingest/`
- [x] Field-location re-derived **against the real ce-catalog page** (label/value `<table>`, `<br>` multi-value cells, `$n | label` fee rows) — captured deterministically into `page_fields` jsonb
- [x] Migrations set 1 (`0002_provenance`): `CREATE EXTENSION vector`; provenance ALTERs (`raw_markdown`, `raw_html`, **`page_fields`**, `course_hash`, `listing_hash`, http meta, `group_url`, retention trio); `page_snapshot`; `crawl_run`; `system_epoch`
- [x] **Whole page stored** as `raw_markdown` (+ `raw_html`) + `page_snapshot` keyed by content hash (dedup: unchanged page writes nothing)
- [x] Segmented hashing: course-hash vs listing-hash, derived from **structured fields** (robust to turndown table rendering) — a status flip moves only the listing hash (tested)
- [x] Grouping link followed → `group_url` captured on all 995 pages; **732 distinct `couID` across 995 sections = 1.36×** (the §5.2.6 estimate is now a measurement)
- [x] Retention columns `first_seen_at`/`last_seen_at`/`disappeared_at` + `system_epoch` seeded (§5.3); observation ordering uses `clock_timestamp()` so a status flip is timed correctly even within one tx
- [x] Ingest orchestration is **table-driven** (ADR-I6 / **decision D6** — resume is a `crawl_run` query; not blocked on the v4 workflow engine)
- [x] **Gated sweep** (`ingest/sweep.ts`): `status='ok'` AND `pages_seen ≥ 0.8×` last good run (§6.2); refusal logged — verified refusing on a live short crawl
- [x] Re-fetched **all 995 discovered pages** politely (robots-respected, rate-limited)
- [x] Fetch-vs-browser benchmark published (ADR-002): discovery = 1 static index fetch → 995 links; fetch+parse ~633 ms mean (p95 ~1.07 s); browser has no volume to amortize
- **Exit:** ✅ **MET** — 995 re-fetched; `raw_markdown`+`page_fields` stored; clock started; sweep refuses a short crawl. **Zero AI.**
- **Deviations from plan (all additive):** real source is `ce-catalog.rutgers.edu` (not the 6-site business scraper — that was reference material); **`page_fields` jsonb** deterministic label/value capture added for RAG/analytics (owner request; not the typed M2 schema); segments derived from fields not markdown lines; the run used an isolated **`pgvector/pgvector:pg16` Docker DB (port 5433)** because local homebrew PG 14 lacks pgvector — data lives there
- **Follow-up:** wire a persistent pgvector Postgres (or `brew install pgvector`) as the durable catalog DB before the next crawl so the clock keeps accruing; add a dotenv loader so `pnpm crawl` reads `.env`

## Phase 2 — Extract ◐ (§16 M2 · pipeline built & green; extraction run pending)

**Real-data pivot** (`docs/real-data-findings-1.md`, verified first-hand on the live 995-page crawl):
the A/B/C template families do **not** exist in the real corpus (`course_data` empty on all 995 — the
split was the legacy scraper's). Extraction is **one schema over one template** (`page_fields` =
required core + optional tail). Term derives from `dates` not `session`; `course.unit_id` is nullable
(`cecc_unit` null); course identity is `group_url`/couID (732 distinct); `courseId` is verified, not
trusted. Architecture §2.1/§9.1/§9.3 amended in parallel by a second agent.

- [x] Extractor adapter (Anthropic `generateObject`, **single `ExtractedCourse` schema**, decode before DB — §9) — `adapters/extractor-anthropic.ts`; provider `adapters/ai-anthropic.ts` (`EXTRACTION_MODEL`, default **Haiku 4.5**)
- [x] ~~Three family prompts A/B/C~~ → **one schema, closed enums + raw-verbatim capture** (validation-first: off-schema output fails decode → typed `schema_error`, never a silent null)
- [x] Migrations set 2 (`0003_extraction`): `unit`·`model`·`course`·`extraction`·`listing`·`listing_fee`·`listing_instructor`·`course_relation`·`listing_change` (real-data corrections) — applies clean on a testcontainer
- [x] All 13 §9.2 hazards, one pure test each (`extraction/derive.ts` + `derive.test.ts` = 16 tests incl. `deriveRows` integration)
- [x] `listing_change` writer on watched-field deltas (§5.3.2) — tested on a status flip
- [x] Persistence (`extraction/persist.ts`) + orchestration (`extract-page.ts`): a typed `extraction` row per attempt (ok/schema_error) in one tx — mock-port + real-DB tests
- [x] §9.3 correctness: tier-1 `courseId`-shape verify + tier-2 `extraction.status` & per-field null/unknown rates — `main-report.ts` (`pnpm … report`)
- [x] **Run — DONE (2026-07-21):** `pnpm --filter @catalog/server extract:sync` over the corpus → **994/995
      pages extracted (1 transient Gemini fail, resumable)**, 731 courses, 2016 fees, 213 relations, 0 silent
      nulls. Not the planned `extract` (Anthropic): that path is blocked by the 16-union tool-schema cap — see
      Phase 3 deviations. Model `gemini-3.1-flash-lite`. _Still open:_ 30 field-presence hand labels for per-field P/R
- **Exit:** ✅ typed `extraction` rows written; no silent nulls; corpus populated. Per-field P/R hand-labeling deferred.

## Phase 3 — Retrieve ☑ (§16 M3 · **DONE & RUN on the real corpus**)

**Verified 2026-07-21 end-to-end on the live Docker DB (:5433):** 731 courses extracted → 731 chunks
(all with §7.3 context prefixes) → 731 embeddings (`gemini-embedding-001`, **dim 1536**, halfvec, no
index) → `/search` returns fused course_ids + filtered listings. **Exact-scan latency (full hybrid RRF
over 731 chunks): p50 3.6 ms · mean 4.2 ms · p95 6.7 ms** — ADR-004's "no index" thesis holds. `tsc`·
`oxlint`·`dprint`·`vitest` (**59 tests**, +11 for Phase 3) all green.

- [x] Embedder adapter — **Gemini `gemini-embedding-001`** (dim 1536, RETRIEVAL_DOCUMENT/QUERY) via
      `:batchEmbedContents`; `adapters/embedder-gemini.ts` (plan said OpenAI/jina — Gemini per owner, R3)
- [x] Migrations set 3 (`0004_semantic`): `chunk` (+`tsv` gin, generated `context_prefix||text`),
      `chunk_embedding` (**halfvec, no index** ADR-004); `model_id` in PK for A/B (§5.4)
- [x] Contextual prefixes per chunk (§7.3) — `retrieval/context-prefix.ts` via Gemini flash-lite;
      degrades to null (never blocks indexing). 731/731 got a prefix on the real run
- [x] Hybrid-RRF single statement (§7.2, `retrieval/hybrid-rrf.ts`, k=60, cosine `<=>`); prereq
      recursive CTE (§7.4, `retrieval/prereq-chain.ts`, depth-guarded for cycles) — both testcontainer-tested
- [x] `filter_listings` (`retrieval/filter-listings.ts`): compiles the §4.2 `ListingFilter` → parameterized
      SQL (`disappeared_at IS NULL` unless `includeGone`; NULL-safe positive predicates) — 12 assertions
- [x] KnowledgeBase adapter (`adapters/pg-knowledge-base.ts`); `POST /search` HttpApi group (no generation);
      `main-index.ts` (`… index`) + `main-search.ts` (`… search`, latency)
- **Exit:** ✅ **MET** — `/search` returns fused course_ids + filtered listings; exact-scan latency measured
- **Deviations (additive):** Embedder is **Gemini** not OpenAI/jina (owner's key). **New finding:** the
  Anthropic `generateObject` extractor (Phase 2) is **blocked** — `ExtractedCourse` has 21 `NullOr` fields,
  over Anthropic's 16-union tool-schema cap. Extraction runs on Gemini instead: added **`extract:sync`**
  (`main-extract-sync.ts`, synchronous `generateContent`, same schema/decode/persist). Model default moved
  `gemini-2.5-flash-lite` → **`gemini-3.1-flash-lite`** (2.5-lite is restricted for new API projects).
  `test/global-setup.ts` now migrates once up front (concurrent per-suite migrators raced on `CREATE TABLE
  effect_sql_migrations`). Domain `filter.ts` (`ListingFilter`) added; `Embedder`/`KnowledgeBase` ports fleshed out.

## Phase 4 — Evaluate ☐ (§16 M4 · ADR-009: before the chat UI)

- [ ] Golden set 150–200 items, stratified by family + shape (§11.1); fixtures in `evals/fixtures/`
- [ ] Migrations set 4: `eval_item`, `eval_run`, `eval_result` (§5.5)
- [ ] Runner: `Effect.forEach(items, {concurrency:5})` → `eval_run`/`eval_result` (§11.3)
- [ ] `LlmJudge` service (frontier model, prose faithfulness §11.2)
- [ ] **`filter_exact`** headline metric + per-field near-miss reporting
- [ ] CI gate: PR fails on `filter_exact` or nDCG@10 drop >2pt (§11.4)
- **Exit:** golden set + runner + CI gate green; `filter_exact` reported

## Phase 5 — Answer ☐ (§16 M5)

- [ ] **Resolve D1** (AI stack) before starting
- [ ] Router + Toolkit agent loop (`LanguageModel.streamText` + `while finish==="tool-calls"`, plan §8.1)
- [ ] `Answer`/`CardRef` schema (structured `generateObject`); five tools as `Tool.make`/`Toolkit.make` (§8.1)
- [ ] `hydrate.ts`: `CardRef → Card`, live status/fees at render (§10.4) — the §1 guarantee
- [ ] SSE typed events `filter`/`prose`/`card`/`window`/`done` (§10.3) via PubSub mailbox → `Sse` (plan §8.2)
- [ ] Grounded refusal + observation-window honesty seam (§10.6)
- [ ] Migrations set 5: `chat_message`, `feedback` (§5.5); single-active-run UPDATE guard
- [ ] **Test: no factual field ever leaves the model** (ADR-008 assertion, §11.2)
- **Exit:** streaming grounded answers with hydrated cards; baseline eval recorded

## Phase 6 — Surface ☐ (§16 M6)

- [ ] Astro + effect-atom app; imports `Answer`/`Card`/`Filter` from `domain`
- [ ] Cards (§10.1); editable filter chips, re-run without LLM (§10.2); zero-result relaxation (§10.3); freshness "checked 3h ago" (§10.4)
- [ ] Feedback buttons → `eval_item` promotion (§5.5)
- [ ] `compat.ts` OpenAI-compatible `/v1/chat/completions` SSE (§10.5); Open WebUI quadlet
- **Exit:** end-to-end product demo; feedback promotes to eval

## Phase 7 — History ☐ (§16 M7)

- [ ] `course_history` tool returning data **plus** observation window (§8.1, §5.3.5)
- [ ] `temporal` eval slice; "I don't know yet" correct at `n=1` (§10.6)
- **Exit:** temporal questions answered honestly against the observation window

## Phase 8 — Ablate ☐ (§16 M8)

- [ ] Ablation runner; §11.5 table by query shape
- [ ] Both baselines: compact index (~54k tok, cached) + whole-catalog (does-not-fit)
- [ ] ADR-004 crossover curve (exact/HNSW/DiskANN, 10³–10⁶)
- [ ] Reranker adapter (bge-reranker-v2-m3) behind port; keep/drop per §11.6
- **Exit:** §11.5 table filled; ADR-004 crossover published

## Phase 9 — Ship ☐ (§16 M9)

- [ ] Podman quadlets (§13); OTel collector; timers
- [ ] README with the ablation table; ADRs; 3-minute demo
- **Exit:** deployed; docs complete

---

## Decision log

| #      | Decision                                                      | Status                                                          | Notes                                                                                                                                                                                                                                                                                                                                                                        |
| ------ | ------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1** | **AI stack: first-party `effect/unstable/ai`**                | ✅ **decided 2026-07-20** (ADR-I1)                              | Phase 5 clones reference-ai-chat; reference-ai-lib stays a drop-in adapter behind the ports and the likely `jina` embedder source (R3). Reversible one-file if multi-provider answering is later needed                                                                                                                                                                       |
| D2     | Monorepo (pnpm, 3 packages) + **Node runtime**                | ✅ **decided 2026-07-20** (ADR-I2)                              | Node + `@effect/platform-node`. Swap Node→Bun is 1 file if desired                                                                                                                                                                                                                                                                                                           |
| D3     | Effect beta pin + path audit                                  | ✅ **pinned `4.0.0-beta.99`** (newest coherent set); re-audited | `Config.*` are functions now (not consts); `PgClient` has no `prepare/fetchTypes` (node-`pg`) → `SqlLive` adapted, §14 hazard structurally absent; `Context.Service` 1-arg port form confirmed                                                                                                                                                                               |
| D4     | Transport SSE (not RPC-WS)                                    | ✅ ADR-I4                                                       | Internals from effect-ai-chat port regardless                                                                                                                                                                                                                                                                                                                                |
| D5     | Dual SQL client :5432/:6432                                   | ✅ ADR-I5                                                       |                                                                                                                                                                                                                                                                                                                                                                              |
| **D6** | Durable workflow vs table-driven resume                       | ✅ **table-driven** (2026-07-20, ADR-I6)                        | `crawl_run` + per-page observation make resume a query and the sweep ordering explicit; Phase 1 does not ride on the v4 workflow backend. Revisit if multi-activity durability is later needed                                                                                                                                                                               |
| **D8** | Deterministic `page_fields` jsonb capture in M1               | ✅ **added** (2026-07-20)                                       | Owner asked for RAG/ML-friendly capture. Faithful label/value mirror (no normalization/derivation) alongside `raw_markdown`; the typed/validated schema stays M2. `course_data` (legacy) left untouched                                                                                                                                                                      |
| **D9** | **Real-data pivot: one extraction schema, no A/B/C families** | ✅ **decided 2026-07-20** (`docs/real-data-findings-1.md`)      | Verified first-hand on the 995-page crawl: `course_data` empty on all → families were legacy-scraper-only. Extract with ONE `ExtractedCourse` schema over `page_fields` (core + optional tail). Term from `dates` not `session`; `unit_id` nullable; course id = couID/`group_url`; `courseId` verified not trusted. Moots §9.1's three prompts and §9.3's courseCode oracle |
| **D7** | **Regenerate scrape approach; capture & extract full page**   | ✅ **decided 2026-07-20** (ADR-I7)                              | Store whole page as `raw_markdown` (+`raw_html`); extraction reads full page (ADR-010). Moots §17 Q3                                                                                                                                                                                                                                                                         |

## Blockers

| #      | Blocker                                                                             | Blocks                                      | Owner | Resolution                                                                                                                                  |
| ------ | ----------------------------------------------------------------------------------- | ------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~B1~~ | §17 Q1                                                                              | Phase 1 course-key                          | —     | ✅ **resolved: grouping link is authoritative course id** (§5.2.6)                                                                          |
| ~~B2~~ | §17 Q3                                                                              | M1 re-crawl thesis                          | —     | ✅ **superseded by D7** — full-page capture; `description` adequacy no longer gates                                                         |
| ~~B3~~ | D1 (AI stack)                                                                       | Phase 5                                     | user  | ✅ **resolved: first-party `effect/unstable/ai`**                                                                                           |
| ~~B4~~ | No git / workspace yet                                                              | Everything                                  | —     | ✅ **resolved** — git repo (`main`) + pnpm workspace + `effect@4.0.0-beta.99`; spine green (`tsc`·`test`·boot)                              |
| B5     | §17 **Q2** (families track `cecc_unit`?) & **Q5** (history already lost?) unchecked | Phase 2 prompt strategy; §5.3 justification | —     | Deferred to Phase 2 — greenfield DB has no legacy `course_data`/`created_at` to query; run against the production crawler DB when connected |

## Change history

| Date       | Rev | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-20 | 1   | Initial plan + progress from architecture.md rev 7 and surveys of the 4 reference repos                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2026-07-20 | 2   | Folded in decisions: D1 first-party AI, Node runtime, §17 Q1 (grouping = authoritative id), D7 (regenerate scrape + full-page capture)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-07-20 | 3   | **Phase 0 spine scaffolded & verified**: pnpm workspace + `effect@4.0.0-beta.99` pin; dual SQL clients; PgMigrator + `0001_init`; AppConfig/errors/telemetry skeletons; testcontainer harness; 7 domain ports; HttpApi `/health`; CI. `tsc`·`test`·`lint`·`dprint`·boot all green                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-07-20 | 4   | **Phase 1 / M1 implemented & run.** Real source `ce-catalog.rutgers.edu` (index `searchResults.cfm?searchId=1`, `a.chart` details, `couID` grouping). Migration `0002` (provenance/retention/`page_snapshot`/`crawl_run`/`system_epoch` + `page_fields`). PageSource(fetch)+robots+segment+fields+segmented-hashing+table-driven crawl+gated sweep; ported `dates`/`utils`. **Ran full re-crawl: 995 pages, 0 errors, 995 snapshots, clock started; short crawl → sweep REFUSED.** 732 courses/995 sections (1.36×). 31 tests green. Decisions D6 (table-driven), D8 (`page_fields`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-07-21 | 6   | **Phase 3 / M3 implemented & RUN; Phase 2 / M2 extraction RUN.** Domain `filter.ts` (`ListingFilter`) + fleshed `Embedder`/`KnowledgeBase` ports; migration `0004_semantic` (`chunk`+`tsv` gin, `chunk_embedding` halfvec no-index); **Gemini embedder** (`gemini-embedding-001`, dim 1536); `context-prefix`/`hybrid-rrf`/`filter-listings`/`prereq-chain`/`index-courses`; `pg-knowledge-base` + `POST /search`; `index`+`search` runners. **Discovered Anthropic `generateObject` is blocked** (21>16 unions) → added **`extract:sync`** (Gemini); model default → `gemini-3.1-flash-lite`. globalSetup migrates once (fixed a concurrent-migrator race). **Ran on the real Docker DB:** 994 extracted, 731 courses → 731 chunks+embeddings, `/search` live, exact-scan p50 3.6 ms. **59 tests green.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 2026-07-20 | 5   | **Phase 2 / M2 pipeline built & green (not yet run).** Real-data pivot **D9** (families don't exist — `docs/real-data-findings-1.md`). Anthropic provider (`@effect/ai-anthropic`, `EXTRACTION_MODEL` default Haiku 4.5); domain `ExtractedCourse` single schema + enums; migration `0003` (typed layer, corrected for real data); `derive.ts` with all 13 §9.2 hazards (16 pure tests); `persist.ts` + `extract-page.ts` (typed `extraction` rows, `listing_change` on deltas; testcontainer + mock-port tests); `main-extract.ts` runner + `main-report.ts` (§9.3). **48 tests green** (`tsc`·`lint`·`dprint`·`vitest`). Remaining: run extraction over the 995 pages with a key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-07-21 | 7   | **Phase 4 / M4 implemented & RUN — eval harness before the chat UI (ADR-009).** Domain `Router` port + `RouteDecision` + `RouterError`; **`router-gemini`** adapter turning NL → `ListingFilter` (the §8 traps: `$2,000`→200000 ×100, evenings, "still open"→status, campus/online, relative dates vs a fixed `EVAL_TODAY`, out-of-scope/recurrence → refuse). Migration `0005_eval` (`eval_item`/`eval_run`/`eval_result`, §5.5). Pure tested core: retrieval metrics (nDCG@10/recall@10/MRR), `filter_exact` + per-field near-miss (`fee_x100`), §11.4 gate. **87-item golden set** (7 shapes at §11.1 shares, grounded in the real 731-course corpus; `expected_ids` resolved live + reconciled) via `eval:seed`; `runner` (`forEach` conc 5 → `eval_run`/`eval_result`) + shape-broken report; `main-eval` with committed baseline + CI gate; secret-guarded `eval-gate` workflow. **Ran on the real Docker DB:** `filter_exact` **100%**, nDCG@10 **0.99**, refusal **100%**, **0** fee-×100 errors, router p50 ~1 s; baseline recorded, gate green. Prompt tuned twice off eval findings (over-refused comparatives/eligibility; over-read course-name tokens as filters). **95 tests green** (`tsc`·`lint`·`dprint`·`vitest`). `prose_faithful` deferred to Phase 5 (LlmJudge) |
