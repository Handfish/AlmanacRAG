# CECC Course Catalog RAG — Progress Tracker

**Doc:** `initial-architecture-progress-1.md` · rev 9 · 2026-07-21
**Plan:** [`initial-architecture-plan-1.md`](./initial-architecture-plan-1.md) · **Design:** [`../architecture.md`](../architecture.md)

Living document. Update the status column and check boxes as work lands. Keep the **Decision log**
and **Blockers** current — they are where the plan meets reality.

**Legend:** ☐ not started · ◐ in progress · ☑ done · ⛔ blocked · ⏸ deferred

---

## Current state

|                      |                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phase**            | 6 — Surface — **DONE & RUN**. Astro + vanilla-TS product surface (cards §10.1, editable chips §10.2, zero-result relaxation §10.3, freshness §10.4, feedback→eval §5.5); `/relax`+`/hydrate` endpoints; `compat.ts` OpenAI-compatible `/v1` (§10.5); Open WebUI quadlet. Booted end-to-end on the live corpus; gate still green (filter_exact **100%**, nDCG **0.99**) |
| **Milestone (§16)**  | M0 ✅ · M1 ✅ · M2 ✅ · M3 ✅ · M4 ✅ · M5 ✅ · **M6 ✅** (Astro surface + `/relax`+`/hydrate` + compat `/v1` + Open WebUI quadlet). Next: M7 History (`course_history` tool; observation-window honesty; `temporal` eval slice)                                                                                                                                       |
| **Repo**             | git repo (`main`) + pnpm workspace (now **3 packages**: `domain`, `server`, `apps/web`); effect **`4.0.0-beta.99`** + **Astro 5**; migrations `0001`–`0006`; **120 tests green** (`tsc`·`lint`·`dprint`·`vitest` + `astro check`). Phase 6: `apps/web`, `retrieval/relax.ts`, `http/compat.ts`, `/hydrate`, feedback→eval promotion landed                             |
| **Source (real)**    | **`ce-catalog.rutgers.edu`** — index `searchResults.cfm?searchId=1`; detail links `a.chart` → `courseDisplay.cfm?schID=…`; grouping via `couID` (confirmed by owner). Not the 6-site business scraper                                                                                                                                                                  |
| **Decisions locked** | D1 = first-party `effect/unstable/ai` (**superseded in practice by Gemini REST** — see D10); §17 Q1 = **couID is course id**; D6 = **table-driven resume**; D7 = **full-page capture**; **D9 = real-data pivot**; pin `beta.99`                                                                                                                                        |
| **AI providers**     | **All AI seams on Gemini REST** (`gemini-3.1-flash-lite`): extraction, embeddings, context prefixes, router, **answerer, judge**. Anthropic `generateObject` blocked (16-union cap); frontier judge tiers (2.5/3.5-flash) restricted/503 on this key → judge also flash-lite (a §11.5 one-env-var swap)                                                                |
| **Immediate gate**   | Phase 6 exit met — both surfaces boot end-to-end (Astro product UI + Open WebUI via compat `/v1`); chips re-run without an LLM; zero-result relaxation live; feedback promotes to a review-queue candidate. Next: **Phase 7 (History)** — `course_history` tool; "I don't know yet" at n=1; `temporal` eval slice                                                      |

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

## Phase 5 — Answer ☑ (§16 M5 · **DONE & RUN on the real corpus**)

**Verified 2026-07-21 end-to-end on the live Docker DB (:5433):** router → retrieve (search∩filter, §8) →
answer (structured `Answer`) → **live card hydration** (§10.4) → observation window. Ran across lookup /
filtered / refusal shapes: e.g. "online leadership under $2000" → chips `{"campus":"Online","maxFeeCents":200000}`
(the ×100 trap handled), 4 hydrated cards all < $2000; "PhD in astrophysics" and "does it run every year?" →
grounded refusals, 0 cards. HTTP surface booted: `GET /health`, `POST /chat` (JSON), `POST /chat/stream`
(**14 SSE events**: filter→prose→card→window→done, matching §10.3 verbatim), `POST /feedback` persisted.
`tsc`·`oxlint`·`dprint`·`vitest` (**108 tests**, +13 for Phase 5) all green.

- [x] ~~**Resolve D1**~~ — decided first-party `effect/unstable/ai`, but **superseded in practice by Gemini REST** (D10): no Effect-v4 Google provider at this beta and the whole codebase already answers on the Gemini REST + structured-output + domain-Schema-decode idiom (router/extractor/embedder). Phase 5 stays consistent — the "Toolkit loop" is realized as the plan's endorsed **naive plan** (§8: router decomposes → filter_listings ∩ search_catalog → compose), which is exactly right at this scale
- [x] Router + retrieve + answer **agent** (`agent/answer-agent.ts`): `run` (Effect) + `runStream` (typed §10.3 events). §8 decomposition with intersect-on-course_id and a filter fallback when the intersection is empty
- [x] `Answer`/`CardRef` schema (`domain/answer.ts`, the §4.2 contract) — structured output; the schema has **no** price/date/status field, so ADR-008 is enforced by construction. Answerer adapter (`adapters/answerer-gemini.ts` + `answerer-prompt.ts`, Gemini `generateJson`); candidate-grounding drops any hallucinated/`listingId`-not-a-candidate card
- [x] **Live card hydration** (`retrieval/hydrate.ts` → `KnowledgeBase.hydrate`): `CardRef → Card` reading live `listing`+`listing_fee`+`course`, status/fees at render (§10.4), freshness from `last_hash_comparison_at`. `listingsForCourses` turns search hits into candidates; `observationWindow` from `system_epoch`
- [x] SSE typed events `filter`/`prose`/`card`/`window`/`done` (§10.3) via `effect/unstable/encoding/Sse` `encoder` + `HttpServerResponse.stream` (`http/chat.ts`, a raw `HttpRouter` route). Prose chunked into deltas; a provider fault degrades to a graceful error event, never an empty 500 mid-stream
- [x] Grounded refusal (§10.6) — a refusal is a normal empty-cards `Answer`; observation window attached to every answer (the §10.6 honesty seam; "n=1 → I don't know yet" recurrence claims are Phase 7's `course_history`)
- [x] Migrations set 5 (`0006_chat`): `chat_session` (the single-active-run lock) + `chat_message` (card_ids, never contents — §5.5) + `feedback` (thumbs → eval-promotion). **Single-active-run** = DB conditional `UPDATE … WHERE active_run_id IS NULL RETURNING id` (`db/repos/chat.ts`), tested
- [x] **Test: no factual field ever leaves the model** (ADR-008 assertion, §11.2) — `answerer-prompt.test.ts`: a decoded `CardRef` has EXACTLY `{listingId, why}` (a smuggled price/status/date is dropped); the agent test asserts card FACTS come from `hydrate`, not the model
- [x] **`prose_faithful` (§11.2) via LlmJudge** (`adapters/judge-gemini.ts`; Judge port extended to take retrieval CONTEXT). Wired into the runner as an **opt-in** pass (`EVAL_PROSE=1`, +2 LLM calls/item; the §11.4 gate stays on the cheap router/retrieval headlines). Ran over the 87-item golden set: **prose_faithful ~81%** — a real signal (the judge caught the answerer over-characterizing varied result sets, e.g. labeling a mixed water/GIS set "test preparation courses"); answerer prompt tightened once off that finding. Reported, not gated
- **Exit:** ✅ **MET** — streaming grounded answers with hydrated cards; baseline eval recorded (eval_run with `prose_faithful`); the ADR-008 assertion is a passing test
- **Deviations (additive):** the "5 tools as `Tool.make`/`Toolkit.make`" (plan §8.1) is realized as the router-decomposition + KnowledgeBase (search_catalog / filter_listings / hydrate = get_course); `compare_courses`/`course_history` are Phase 7/naturally batched. Answerer + judge on **Gemini flash-lite** (frontier tiers restricted/503 on this key — same constraint as extraction; a §11.5 one-env-var swap). SSE computes-then-streams (token-by-token is a Phase-6 UX refinement); the typed event contract is what Phase 5 pins down

## Phase 6 — Surface ☑ (§16 M6 · **DONE & RUN on the real corpus**)

**Verified 2026-07-21 end-to-end on the live Docker DB (:5433), API on :3000, Astro on :4321:** booted
both servers; `/v1/models`, `/hydrate`, `/relax`, `/search` (no key) and `/chat` + `/v1/chat/completions`
(Gemini) all return live-hydrated facts. `/relax` on an impossible filter (`Camden` ∧ `evenings` ∧ `≤$5`)
→ `{total:0, drop campus→6, drop evenings→2, drop fee→2}` (§10.3 exactly). `/chat` "online PM under $3000"
→ chips `{campus:Online, maxFeeCents:300000}` (the ×100 trap handled), 5 live cards ($395 first). Astro
dev proxies `/api/*` → :3000 (verified same-origin). `astro build` = a **7.7 kB** client bundle; `astro
check` 0 errors. `tsc`·`oxlint`·`dprint`·`vitest` (**120 tests**, +12 for Phase 6) all green.

- [x] **Astro app** (`apps/web`, lean vanilla-TS islands — not effect-atom, decision **D11**): imports
      `Card`/`ListingFilter`/`ObservationWindow` from `@catalog/domain` (type-only → erased at runtime) for
      type-safe rendering; one `boot()` island (`lib/app.ts`) over `render.ts`/`format.ts`/`api.ts`/`types.ts`
- [x] **Cards** (§10.1): live-hydrated, status dot + fee + dates; the CTA is the REAL path (register keyword
      or "view details"), never an invented Register button (ADR-008)
- [x] **Editable filter chips** (§10.2): the router's filter → removable chips; clicking × drops one predicate
      and re-runs via `POST /search` → `POST /hydrate` — **no LLM call**. Added `/hydrate` endpoint so a chip
      re-run renders the SAME live cards (with freshness) the chat answer shows
- [x] **Zero-result relaxation** (§10.3): new `retrieval/relax.ts` + `KnowledgeBase.relaxFilter` + `POST /relax`
      — counts each single-predicate drop (N+1, best-first) so a dead search offers "drop one? → N results"
- [x] **Freshness** (§10.4): `format.ts` `freshness(checkedAt)` → "checked 3h ago" on every card
- [x] **Feedback → `eval_item` promotion** (§5.5): 👍/👎 → `POST /feedback`; a 👎 calls `promoteFeedbackToEval`
      — inserts the question as a **CANDIDATE** eval_item (`reviewed_at` NULL). The runner + seed both now scope
      to `reviewed_at IS NOT NULL`, so a candidate **can never move the §11.4 gate** until a human curates it
- [x] **`compat.ts`** OpenAI-compatible `/v1/chat/completions` (+ `/v1/models`) (§10.5): same agent, degrades
      to a markdown table (facts still live-hydrated); non-streaming JSON + SSE `chat.completion.chunk` frames
      + `[DONE]`; stateless (no session lock); a fault degrades to a valid apology completion
- [x] **Open WebUI quadlet** (§13): `deploy/quadlet/open-webui.container` + `catalog.network` + `deploy/README.md`
      (points Open WebUI's OpenAI client at the compat `/v1` surface). Full podman stack stays Phase 9
- **Exit:** ✅ **MET** — end-to-end product demo works (both surfaces); feedback promotes to a candidate eval item
- **Deviations (additive):** **D11** — the frontend is **lean Astro + vanilla TS**, not effect-atom (owner-chosen;
  effect-atom is React+RPC-over-WS, conflicts with ADR-I4's SSE and adds a pre-1.0 dep the ports don't need — its
  value was the Phase-5 backend internals, already taken). New endpoints `/hydrate` + `/relax` added (the UI's
  no-LLM chip/relaxation paths). Chat uses JSON `/chat` (full hydrated answer in one shot); the §10.3 SSE stream
  (`/chat/stream`, Phase 5) stays available. Promotion is a **candidate** queue (not auto-graded), gated behind
  human review by `reviewed_at`.

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

| #       | Decision                                                                    | Status                                                          | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------- | --------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D1**  | **AI stack: first-party `effect/unstable/ai`**                              | ✅ **decided 2026-07-20** (ADR-I1)                              | Phase 5 clones reference-ai-chat; reference-ai-lib stays a drop-in adapter behind the ports and the likely `jina` embedder source (R3). Reversible one-file if multi-provider answering is later needed                                                                                                                                                                                                                                                                                                                                                                          |
| D2      | Monorepo (pnpm, 3 packages) + **Node runtime**                              | ✅ **decided 2026-07-20** (ADR-I2)                              | Node + `@effect/platform-node`. Swap Node→Bun is 1 file if desired                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D3      | Effect beta pin + path audit                                                | ✅ **pinned `4.0.0-beta.99`** (newest coherent set); re-audited | `Config.*` are functions now (not consts); `PgClient` has no `prepare/fetchTypes` (node-`pg`) → `SqlLive` adapted, §14 hazard structurally absent; `Context.Service` 1-arg port form confirmed                                                                                                                                                                                                                                                                                                                                                                                  |
| D4      | Transport SSE (not RPC-WS)                                                  | ✅ ADR-I4                                                       | Internals from effect-ai-chat port regardless                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D5      | Dual SQL client :5432/:6432                                                 | ✅ ADR-I5                                                       |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **D6**  | Durable workflow vs table-driven resume                                     | ✅ **table-driven** (2026-07-20, ADR-I6)                        | `crawl_run` + per-page observation make resume a query and the sweep ordering explicit; Phase 1 does not ride on the v4 workflow backend. Revisit if multi-activity durability is later needed                                                                                                                                                                                                                                                                                                                                                                                  |
| **D8**  | Deterministic `page_fields` jsonb capture in M1                             | ✅ **added** (2026-07-20)                                       | Owner asked for RAG/ML-friendly capture. Faithful label/value mirror (no normalization/derivation) alongside `raw_markdown`; the typed/validated schema stays M2. `course_data` (legacy) left untouched                                                                                                                                                                                                                                                                                                                                                                         |
| **D9**  | **Real-data pivot: one extraction schema, no A/B/C families**               | ✅ **decided 2026-07-20** (`docs/real-data-findings-1.md`)      | Verified first-hand on the 995-page crawl: `course_data` empty on all → families were legacy-scraper-only. Extract with ONE `ExtractedCourse` schema over `page_fields` (core + optional tail). Term from `dates` not `session`; `unit_id` nullable; course id = couID/`group_url`; `courseId` verified not trusted. Moots §9.1's three prompts and §9.3's courseCode oracle                                                                                                                                                                                                    |
| **D7**  | **Regenerate scrape approach; capture & extract full page**                 | ✅ **decided 2026-07-20** (ADR-I7)                              | Store whole page as `raw_markdown` (+`raw_html`); extraction reads full page (ADR-010). Moots §17 Q3                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **D11** | **Web frontend: lean Astro + vanilla TS, not effect-atom**                  | ✅ **decided 2026-07-21** (owner-chosen)                        | Phase 6. effect-atom is React + RPC-over-WebSocket — it conflicts with ADR-I4 (SSE), adds a pre-1.0 dep the §4 ports don't need, and has NONE of §10's bespoke surface (cards/chips/relaxation/freshness) to reuse; reference-ai-chat's real value (agent loop, streaming internals, test harness) was already taken in Phase 5. So `apps/web` is Astro-shell + one vanilla-TS island importing the domain contracts, calling the server's JSON endpoints. Reversible: the ports/endpoints are unchanged, so an effect-atom client could slot in later                     |
| **D10** | **AI stack in practice: Gemini REST, not first-party `effect/unstable/ai`** | ✅ **de-facto since Phase 2, formalized Phase 5**               | D1 chose first-party `ai`, but no Effect-v4 Google provider exists at beta.99 and every AI seam (extraction/router/embedder) already runs on a thin Gemini REST adapter (`ai-gemini.ts` `generateJson` + domain-Schema decode). Phase 5's answerer + judge follow suit for consistency; ADR-008 is enforced by the `Answer` schema regardless of provider. Ports (§4) keep it contained — swapping to `effect/unstable/ai` or reference-ai-lib is one adapter file each. Frontier judge tiers restricted/503 on this key → judge defaults to flash-lite, a `JUDGE_MODEL` swap (§11.5) |

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
| 2026-07-21 | 9   | **Phase 6 / M6 implemented & RUN — the product surface (§10).** `apps/web` Astro + lean vanilla-TS island (decision **D11**, not effect-atom) importing the domain `Card`/`ListingFilter`/`ObservationWindow`: cards (§10.1), editable filter chips that re-run without an LLM (§10.2), zero-result relaxation (§10.3), freshness (§10.4), feedback→eval (§5.5). New backend: `retrieval/relax.ts` + `KnowledgeBase.relaxFilter` + `POST /relax` (single-predicate drop counts); `POST /hydrate` (chip re-runs render the same live cards); `http/compat.ts` OpenAI-compatible `/v1/chat/completions`+`/v1/models` (§10.5, markdown-table degrade); `promoteFeedbackToEval` (a 👎 → CANDIDATE eval_item, `reviewed_at` NULL — runner + seed now scope to reviewed items so a candidate can't move the gate). `deploy/quadlet/open-webui.container` (§13). **Ran end-to-end on the real Docker DB:** `/relax` on an impossible filter → per-predicate drop counts; `/chat` handled the ×100 fee trap with 5 live cards; compat `/v1` returned a hydrated markdown table; Astro proxied `/api/*` → :3000. **120 tests green** (+ `astro check` 0 errors; 7.7 kB client bundle).                                                                                                         |
| 2026-07-21 | 8   | **Phase 5 / M5 implemented & RUN — the chat surface (§10).** Domain `answer.ts` (`Answer`/`CardRef` §4.2 contract + hydrated `Card`/`ObservationWindow`); Answerer port reshaped to structured output; KnowledgeBase gained `hydrate`/`listingsForCourses`/`observationWindow`. `agent/answer-agent.ts` (router→retrieve∩→answer→live-hydrate, `run`+`runStream`); Gemini answerer (`answerer-gemini`/`answerer-prompt`, candidate-grounded decode); `retrieval/hydrate.ts` (live `Card` from Postgres, §10.4); migration `0006_chat` (`chat_session`/`chat_message`/`feedback`) + `db/repos/chat.ts` (single-active-run lock); `http/chat.ts` (JSON `/chat`, SSE `/chat/stream` §10.3, `/feedback`) wired into `api.ts`/`main.ts`; `judge-gemini` LlmJudge + opt-in `prose_faithful` runner pass. **Ran on the real Docker DB:** grounded answers with live-hydrated cards, chips echo the ×100-safe filter, refusals empty-carded; SSE emits the exact §10.3 sequence; `prose_faithful ~81%` recorded; gate still green (filter_exact 100%, nDCG 0.99). **108 tests green.** D10 (Gemini REST formalized).                                                                                                                                                                          |
| 2026-07-21 | 7   | **Phase 4 / M4 implemented & RUN — eval harness before the chat UI (ADR-009).** Domain `Router` port + `RouteDecision` + `RouterError`; **`router-gemini`** adapter turning NL → `ListingFilter` (the §8 traps: `$2,000`→200000 ×100, evenings, "still open"→status, campus/online, relative dates vs a fixed `EVAL_TODAY`, out-of-scope/recurrence → refuse). Migration `0005_eval` (`eval_item`/`eval_run`/`eval_result`, §5.5). Pure tested core: retrieval metrics (nDCG@10/recall@10/MRR), `filter_exact` + per-field near-miss (`fee_x100`), §11.4 gate. **87-item golden set** (7 shapes at §11.1 shares, grounded in the real 731-course corpus; `expected_ids` resolved live + reconciled) via `eval:seed`; `runner` (`forEach` conc 5 → `eval_run`/`eval_result`) + shape-broken report; `main-eval` with committed baseline + CI gate; secret-guarded `eval-gate` workflow. **Ran on the real Docker DB:** `filter_exact` **100%**, nDCG@10 **0.99**, refusal **100%**, **0** fee-×100 errors, router p50 ~1 s; baseline recorded, gate green. Prompt tuned twice off eval findings (over-refused comparatives/eligibility; over-read course-name tokens as filters). **95 tests green** (`tsc`·`lint`·`dprint`·`vitest`). `prose_faithful` deferred to Phase 5 (LlmJudge) |
