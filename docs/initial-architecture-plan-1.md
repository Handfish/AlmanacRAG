# CECC Course Catalog RAG — Implementation Plan

**Doc:** `initial-architecture-plan-1.md` · rev 2 · 2026-07-20 (D1 + runtime + §17 Q1/Q3 folded in)
**Companion tracker:** [`initial-architecture-progress-1.md`](./initial-architecture-progress-1.md)
**Authoritative design:** [`../architecture.md`](../architecture.md) (rev 7)

---

## 0. What this document is (and is not)

`architecture.md` is the **product/domain architecture** — the _what_ and the _why_: the §1 thesis
(the model chooses rows, the database speaks facts), the data model (§5), retrieval (§7), query
understanding (§8), extraction (§9), the chat surface (§10), evaluation (§11), and 11 ADRs. It is
authoritative and this plan does **not** restate it. Read it first.

This document is the **implementation plan** — the _how_: how the design becomes an EffectTS v4
codebase, which packages, which module boundaries, which concrete idioms (drawn from the four
reference projects checked out under this repo), and in what order to build it. Where a decision
here refines or operationalizes an `architecture.md` decision, it cites the section (e.g. §5.2).
Where it adds an implementation-level decision the product doc doesn't cover, it records an
**ADR-I_n_** (implementation ADR, §3).

The one structural gap this plan fills: `architecture.md`'s roadmap (§16) starts at **M1 (re-crawl)**
and assumes an Effect application already exists to crawl _into_. It doesn't. reference-scraper
— the thing being "rewritten" — turns out to be a **Crawlee + Playwright + Drizzle** app with **zero
Effect** in it. So there is a **Phase 0 (Foundations)** before M1: stand up the Effect v4 workspace,
runtime, SQL layer, migration runner, config, errors, observability, and test harness. Phases 1–9
then map 1:1 onto `architecture.md` M1–M9.

---

## 1. Source material — what each reference contributes

Four projects sit under this repo. A deep survey of each produced the following. (All four carry
their own `.git`; they are **reference material, not part of the build** — see §4.1.)

| Project                    | What it actually is                                                                                                                                                                                                                                          | What we take                                                                                                                                                                                                                                                                                                                                                                       | What we ignore                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **`architecture.md`**      | The rev-7 design spec                                                                                                                                                                                                                                        | Everything — it is the target                                                                                                                                                                                                                                                                                                                                                      | —                                                                                                            |

**The single most important cross-cutting fact:** all three Effect repos are **Effect v4 beta**, and v4
has **collapsed the `@effect/*` ecosystem into the one `effect` package under `effect/unstable/*`**.
`effect/unstable/{ai,sql,httpapi,http,workflow,rpc,schema,encoding,observability,persistence,reactivity}`
are all present in the installed `effect` package's exports map. Only **drivers and providers** remain
separate packages (`@effect/sql-pg`, `@effect/platform-node`, `@effect/ai-anthropic`, …). This is
exactly the churn `architecture.md` ADR-001 warns about — so **Phase 0's first task is a path audit**
against the pinned beta.

---

## 2. Target shape in one picture

```
                         ┌───────────────────────────────────────────────┐
  Astro + effect-atom ──▶│  http (effect/unstable/httpapi + SSE §10.3)   │
  Open WebUI (compat) ──▶│  api.ts · chat.ts(SSE) · hydrate.ts · compat  │
                         └───────────────┬───────────────────────────────┘
                                         │  Answer{prose,cards,filter,followups}  (§4.2)
                         ┌───────────────▼───────────────────────────────┐
                         │  agent: router + Toolkit loop  (effect/unstable/ai)
                         │  tools: search_catalog · filter_listings ·     │
                         │         get_course · compare_courses · course_history (§8.1)
                         └───────┬───────────────────────────────┬────────┘
             ports (domain, no vendor imports — §4)              │ hydrate reads live status/fees (§10.4)
  ┌──────────────┬───────────────┼───────────────┬──────────────┴──────────┐
  ▼              ▼               ▼               ▼                          ▼
Extractor      Embedder       Reranker       Answerer                 KnowledgeBase / PageSource
(Anthropic)    (OpenAI/jina)  (bge http)     (Anthropic)              (Postgres pgvector · fetch)
  └──────────────┴───────────────┴───────────────┴──────────────────────────┘
                                         │
                         ┌───────────────▼───────────────────────────────┐
                         │  Postgres (pgvector/halfvec) — §5 data model   │
                         │  ingest workflow (effect/unstable/workflow)    │
                         │  admin :5432 (DDL) · pooled :6432 prepare:false │
                         └───────────────────────────────────────────────┘
```

Ports and adapters exactly as `architecture.md` §4 draws them; the boxes above are the concrete
Effect services. Every vendor lib lives behind one adapter file, so "the AI provider libraries are
pre-1.0 … the blast radius is one file under `src/adapters/`" (§4) holds literally.

---

## 3. Implementation decisions (ADR-I_n_)

These operationalize `architecture.md` without contradicting it. Format mirrors §15.

**ADR-I1 — Build the AI layer on first-party `effect/unstable/ai`, behind our own ports; keep
reference-ai-lib as an optional adapter.**
reference-ai-chat proves an end-to-end Effect v4 stack (loop + tools + structured output +
persistence + workflow + streaming + tests) on the first-party `effect/unstable/ai`
(`LanguageModel`, `Prompt`, `Tool`, `Toolkit`). Choosing it minimizes exposure to a second pre-1.0
dependency and gives us a working template to diff against. But the _ports_ are ours (§4 mandates
it), so the choice is contained to `adapters/answerer-anthropic.ts` and `adapters/extractor-*.ts`. We
adopt reference-ai-lib's **patterns** (dual-tag provider layer, subset-aware retry, typed `AiError`,
`StructuredFormat` streaming, tool-kinds) and keep reference-ai-lib itself as a drop-in adapter if/when we
want multi-provider `TurnEvent` normalization or its `jina` embeddings. _Revisit if_ we need
OpenAI+Anthropic+Gemini cross-provider answering (reference-ai-lib's canonical union then earns its place)
or if `effect/unstable/ai` stalls. **Decided 2026-07-20: first-party `effect/unstable/ai`**
(decision D1). Contained to `adapters/`, reversible by design; reference-ai-lib stays a drop-in adapter and
is the likely source of the `jina` embedder (§5.2 / R3).

**ADR-I2 — pnpm workspace monorepo, Node 22 LTS, three packages.**
Both AI references and reference-ai-lib are pnpm monorepos; reference-ai-chat's `domain/server/client`
split is the right precedent because our Astro web app (§10.5) must import the `Answer`/`Card`/
`Filter` schemas for type-safe rendering. Packages: **`packages/domain`** (schemas + ports, zero
vendor imports — §4), **`packages/server`** (adapters/agent/workflows/http/evals/migrate/main —
mirrors §4.1's `src/` tree exactly), **`apps/web`** (Astro + effect-atom). Node over Bun for boring
container ops (§13 deploys quadlets); both AI references run fine on `@effect/platform-node`. _Reject
if_ the team standardizes on Bun — the swap is `@effect/platform-node` → `-bun` and `NodeRuntime` →
`BunRuntime`, one file (`main.ts`). _Confirmed 2026-07-20: Node + `@effect/platform-node`._

**ADR-I3 — Pin one exact Effect beta workspace-wide via `pnpm.overrides`; audit `unstable/*` paths
before writing code.**
reference-ai-chat pins `effect` via `pnpm.overrides` so every package resolves the identical
beta — non-negotiable given `effect/unstable/*` moves between releases. We pin the newest beta on
which every module we need (`ai, sql, httpapi, http, workflow, schema, encoding, observability`) is
present, starting from the surveyed `4.0.0-beta.88`+ and moving up only after a path audit. ADR-001
lives here operationally.

**ADR-I4 — Transport is HttpApi + SSE (per §10.3/§10.5), not RPC-over-WebSocket.**
`architecture.md` §10.3 specifies typed SSE events (`filter`/`prose`/`card`/`window`/`done`) and §10.5
an OpenAI-compatible `/v1/chat/completions` SSE surface. reference-ai-chat uses RPC-over-WS
instead — but its _internals_ (PubSub mailbox producer, `Stream.runFoldEffect` accumulator,
`Workflow`-per-run, replayable late-subscriber streams) are transport-agnostic and we keep them. SSE
via `effect/unstable/encoding/Sse` + `effect/unstable/http` `HttpServerResponse.stream`. _Revisit if_
we want live bidirectional features (chip edits pushed server→client mid-stream) — RPC-over-WS is the
documented fallback and the client atoms port either way.

**ADR-I5 — Two `SqlClient` layers, always.**
Per §5 and §13: `SqlAdmin` (direct `:5432`, session mode, DDL/migrations only) and `SqlLive` (pooled
`:6432` via PgBouncer, `prepare: false`, `fetch_types: false` — transaction pooling invalidates
cached prepared statements). Both are `@effect/sql-pg` `PgClient.layer` with different config; every
runtime query uses `SqlLive`, only `migrate.ts` uses `SqlAdmin`. This makes the §14 failure "stale
prepared statement" structurally impossible.

**ADR-I6 — Durable ingest via `effect/unstable/workflow`, with a table-driven resume fallback.**
§6/§6.2/§14 want a durable workflow so `sweep` cannot run before `closeCrawlRun` and a crash resumes
mid-batch. reference-ai-chat uses `Workflow.make` + `WorkflowEngine`. We target that. **But** if
the v4 workflow _persistence_ backend proves immature at our pinned beta, the schema already affords a
deterministic fallback: `crawl_run` + `extraction` rows make resume a query ("which pages lack a
current extraction for this run?"), and the sweep gate (§6.2) is a plain `WHERE` guard. We do not
block Phase 1 on workflow-engine maturity. Decision recorded per-run in `crawl_run`.

**ADR-I7 — Regenerate the scrape approach; capture and extract from the full page (decision D7).**
Rather than trust the existing `description` snippet, Phase 1 re-designs the fetch/parse pipeline and
stores the **whole page** as `raw_markdown` (+ optional `raw_html`), snapshotted by hash (§5.3.3).
Extraction (Phase 2) reads the full page as four sources — title, fields, footnotes, prose (ADR-010) —
so no fact is lost to a curated column. This **moots §17 Q3** (we no longer depend on `description`'s
adequacy) and strengthens the §2.2 blocking-gap fix. The old per-site selectors become field-location
hints, re-derived against the captured markdown rather than ported wholesale. _Cost:_ a few KB more
per page (TOAST-compressed, still inside §5.3.3's ~15 MB/year).

---

## 4. Repository & workspace layout

### 4.1 Top of repo

`new-rag-courselist/` is greenfield (only `architecture.md`, `docs/`, and the four reference repos).
Plan:

- `git init` at the repo root. Track `architecture.md`, `docs/`, and the new workspace.
- **`.gitignore` the four reference dirs** (`reference-scraper/`, `reference-catalog/`,
  `reference-ai-chat/`, `reference-ai-lib/`) — each has its own `.git`; committing them would create
  embedded-repo noise. They stay on disk for reference during the build. (Alternative: relocate them
  to a sibling `../_refs/`. Ignoring is lower-friction and keeps `file:line` citations valid.)
- Reuse `src/dates.ts` and `src/utils.ts` from reference-scraper by **copying** the files into
  `packages/server/src/ingest/` with attribution, not by depending on the old package.

### 4.2 Workspace tree

```
new-rag-courselist/
├── architecture.md                 # the design (authoritative)
├── docs/                           # this plan + progress + future ADRs
├── pnpm-workspace.yaml             # packages: [packages/*, apps/*]
├── package.json                    # root: pnpm.overrides pins effect beta; shared devDeps
├── tsconfig.base.json              # @effect/language-service plugin, strict, ES2022, NodeNext
├── .env.example                    # POSTGRES_URL(:6432) POSTGRES_ADMIN_URL(:5432) ANTHROPIC_API_KEY …
├── packages/
│   ├── domain/                     # §4 ports + §4.2 contracts. ZERO vendor imports.
│   │   └── src/
│   │       ├── course.ts           #   Course, Listing, Fee, Unit, Campus, Status, DeliveryMode
│   │       ├── answer.ts           #   Answer, CardRef        ← the §1 contract (Schema.Class)
│   │       ├── filter.ts           #   ListingFilter          ← the §8 contract
│   │       ├── history.ts          #   TermRun, ChangeEvent, ObservationWindow
│   │       ├── ids.ts              #   branded ListingId, CourseId, UnitId, ChunkId
│   │       ├── errors.ts           #   Schema.TaggedError (cross-wire) + Data.TaggedError (internal)
│   │       └── ports/              #   KnowledgeBase, Extractor, Embedder, Reranker,
│   │                               #     Answerer, PageSource, Judge  (Context.Service tags, no impl)
│   ├── server/                     # mirrors architecture.md §4.1 src/ tree
│   │   └── src/
│   │       ├── adapters/           #   sql-live · sql-admin · pg-knowledge-base ·
│   │       │                       #     fetch-page-source · embedder-* · answerer-anthropic ·
│   │       │                       #     extractor-anthropic · reranker-bge
│   │       ├── agent/router.ts + tools/{search-catalog,filter-listings,get-course,compare-courses,course-history}.ts
│   │       ├── ingest/             #   crawl-workflow · segment · hash · sweep · dates.ts · utils.ts (ported)
│   │       ├── retrieval/          #   hybrid-rrf.ts · prereq-chain.ts
│   │       ├── extraction/         #   family-a|b|c prompts · derive · listing-change
│   │       ├── db/                 #   models (Model.Class) · repos (SqlSchema) · migrations/ · migrate.ts
│   │       ├── evals/              #   runner · judge · fixtures/
│   │       ├── http/               #   api.ts(HttpApi) · chat.ts(SSE §10.3) · hydrate.ts · compat.ts(§10.5)
│   │       ├── telemetry/          #   NodeSdk OTel layer (§12)
│   │       └── main.ts             #   the ONE file that composes every layer (§4.1)
│   └── (client shared lib — optional; fold into apps/web unless reused)
└── apps/
    └── web/                        # Astro + effect-atom (§10.5 primary surface)
```

`packages/domain` importing no vendor code is the enforceable version of §4's thesis — add an
`oxlint`/`@effect/language-service` boundary rule so a stray `effect/unstable/sql` import in `domain`
fails CI.

---

## 5. Technology stack & dependency manifest

Versions are the surveyed betas; **Phase 0 pins the newest that passes the path audit**.

### 5.1 Runtime & core

| Concern                | Package / module                                                     | Notes                                                                                                         |
| ---------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Core                   | `effect` `4.0.0-beta.88`+ (pinned via `pnpm.overrides`)              | Brings `effect/unstable/*`. ADR-001/ADR-I3                                                                    |
| Runtime + HTTP server  | `@effect/platform-node`                                              | `NodeRuntime.runMain`, `NodeHttpServer`. (`-bun` is a 1-file swap)                                            |
| HTTP API               | `effect/unstable/httpapi`, `effect/unstable/http`                    | `HttpApi`/`HttpApiGroup`/`HttpApiEndpoint`; `HttpServerResponse.stream` for SSE                               |
| SSE codec              | `effect/unstable/encoding/Sse`                                       | typed events (§10.3)                                                                                          |
| SQL core               | `effect/unstable/sql` (`SqlClient`, `SqlSchema`)                     | query tag, decoded results                                                                                    |
| PG driver              | `@effect/sql-pg` (`PgClient`, `PgMigrator`)                          | dual client (ADR-I5); `PgMigrator.fromFileSystem`                                                             |
| Schema/models          | `effect/Schema`, `effect/unstable/schema` (`Model`)                  | `Schema.Class`, `Model.Class`, `Model.JsonFromString`, `Model.GeneratedByDb`, `Model.DateTime{Insert,Update}` |
| Durable ingest         | `effect/unstable/workflow` (`Workflow`, `WorkflowEngine`)            | ADR-I6 (+ fallback)                                                                                           |
| Config                 | `effect/Config`, `effect/Redacted`                                   | `Config.all`, `Config.redacted`, `Config.withDefault`                                                         |
| Errors                 | `effect/Data`, `effect/Schema`                                       | `Data.TaggedError` internal; `Schema.TaggedError` cross-wire                                                  |
| Observability          | `effect/unstable/observability`, `@effect/opentelemetry` (`NodeSdk`) | OTLP → collector (§12)                                                                                        |
| Concurrency/resilience | `Effect`, `Schedule`, `Queue`, `Stream`, `PubSub`                    | `Effect.forEach({concurrency})`, `Schedule.jittered`, worker-pool (from ccpd)                                 |

### 5.2 AI (ADR-I1)

| Port (§4)   | Module / provider                                                                                              | Idiom source                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `Answerer`  | `effect/unstable/ai` `LanguageModel.streamText` + `Toolkit`; provider `@effect/ai-anthropic` `AnthropicClient` | reference-ai-chat `chat-processor.ts`, `ai-models.ts`                                          |
| `Extractor` | `LanguageModel.generateObject({schema})` (structured, §9); Anthropic                                           | reference-ai-chat structured-output seam; reference-ai-lib `StructuredFormat`                        |
| `Embedder`  | thin `Context.Service` over `FetchHttpClient` → OpenAI `/v1/embeddings` (or `text-embedding-3-large`)          | reference-ai-chat `weather-api.ts` template; **or** reference-ai-lib `EmbeddingModel`+`jina` drop-in |
| `Reranker`  | `Context.Service` → HTTP call to bge-reranker-v2-m3 container (§11.6/§13)                                      | our own; degrade-to-identity on failure (§14)                                                       |
| `Judge`     | `LanguageModel.generateObject` with a frontier model, eval-only (§11.3)                                        | —                                                                                                   |

`@effect/ai-openai-compat` (what the example actually uses, against Ollama) is the fallback provider
for local models (§17.10). Provider selection is a `Schema.Literals` model family + `Model.model(name)
.captureRequirements` → `Layer<LanguageModel>`, injected via an `AiModels.use(model)` seam
(reference-ai-chat `ai-models.ts`) — this is also how the §11.5 ablation table swaps models.

### 5.3 Ingest / crawl (ADR-002: fetch, not a browser)

| Concern    | Choice                                                                                                  | Notes                                                                                                                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fetch      | built-in `fetch` via `FetchHttpClient` + `Effect.retry(Schedule.jittered(...))` + `AbortSignal.timeout` | ccpd `ed2go-api.ts` pattern; conditional GET via `etag`/`if-modified-since` (§6.1)                                                                                                           |
| Parse      | `cheerio` (server DOM) + `turndown` (HTML→markdown)                                                     | **regenerate the scrape approach; capture the FULL page** as `raw_markdown` (+ optional `raw_html`), not a description snippet (§2.2, decision D7); old selectors inform field-location only |
| Dates      | `chrono-node` via ported `dates.ts`                                                                     | verbatim from reference-scraper                                                                                                                                                           |
| Hash       | `node:crypto` sha256 via ported `utils.ts`                                                              | **segmented** (course-hash / listing-hash, §5.1)                                                                                                                                             |
| Politeness | `robots.txt` check, bounded concurrency, off-hours, rate cap                                            | §6.1; `Effect.forEach({concurrency})`                                                                                                                                                        |

### 5.4 Data & tooling

- **Postgres** with **pgvector** (+ pgvectorscale available but unused per ADR-004); `halfvec`
  columns; no vector index (ADR-004). Extensions created in the first migration on `SqlAdmin`.
- **Toolchain:** pnpm 10, TypeScript 5.9+, `@effect/language-service` (lint + `import * as X`
  convention), `dprint` (fmt), `oxlint` (lint). Match reference-ai-chat's `RULES.md` conventions
  (no barrel `index.ts`; `Effect.fnUntraced` wrappers; typed errors only; final layers typed
  `Layer.Layer<Provided>`).
- **Test:** `@effect/vitest` (`it.effect`/`it.live`), `@testcontainers/postgresql` +
  `withTransactionRollback`, and the **mock-`LanguageModel` harness** (`LM.make({streamText,
  generateText})`) — the single most valuable test idiom for the agent loop.

---

## 6. Cross-cutting foundations (Phase 0 deliverables)

Concrete idioms, lifted from the surveys, that every later phase depends on.

### 6.1 Service / port definition (v4)

Ports in `packages/domain` are tags with an explicit shape and **no** implementation:

```ts
// packages/domain/src/ports/embedder.ts  — no vendor import
import { Context, Effect } from "effect";
export type EmbedderShape = {
  readonly embed: (
    texts: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, EmbedError>;
};
export class Embedder extends Context.Service<Embedder, EmbedderShape>()("catalog/Embedder") {}
```

Adapters in `packages/server` provide the tag and carry the vendor dep + its `static Default`/`layer`
(the ccpd `Context.Service … { make } → static Default = Layer.effect(...)` idiom, deps `yield*`-ed
in `make`, wired with `.pipe(Layer.provide(Dep.Default))`).

### 6.2 Dual SQL client (ADR-I5)

```ts
// adapters/sql-live.ts — pooled :6432, transaction-pooling-safe
export const SqlLive = Layer.unwrap(Effect.gen(function*() {
  const url = yield* Config.redacted("POSTGRES_URL"); // :6432 PgBouncer
  return PgClient.layer({
    url,
    prepare: false,
    fetchTypes: false,
    transformQueryNames: camelToSnake,
  });
})).pipe(Layer.orDie);

// adapters/sql-admin.ts — direct :5432, DDL/migrations only
export const SqlAdmin = Layer.unwrap(Effect.gen(function*() {
  const url = yield* Config.redacted("POSTGRES_ADMIN_URL"); // :5432 session mode
  return PgClient.layer({ url });
})).pipe(Layer.orDie);
```

Harden the pool the way ccpd's `db/pg.ts` does (keepAlive, error handler, `SELECT 1` health gate) via
`PgClient` options where exposed.

### 6.3 Config, errors, logging, telemetry

- **Config:** one `AppConfig` service (`Config.all({...})` + `Config.redacted` for keys, `Redacted.value`
  only at the boundary), `Effect.catchTag("ConfigError", printBanner)` at `main.ts` (ccpd `main.ts`).
- **Errors:** `Data.TaggedError` for internal failures + a `Match.typeTags` exhaustive formatter
  (ccpd `errors.ts`); `Schema.TaggedError` for anything crossing the HTTP boundary (effect-ai-chat's
  `ChatNotFoundError` style) so it serializes.
- **Telemetry:** `@effect/opentelemetry` `NodeSdk.layer` exporting OTLP (effect-ai-chat `tracer.ts`);
  one span per request (§12), `cost_micros` as a span attribute.

### 6.4 Migration runner + models

`PgMigrator.run({ loader: PgMigrator.fromFileSystem("db/migrations") })` on `SqlAdmin` (effect-ai-chat
`migrate.ts`). Rows are `Model.Class` with `Model.GeneratedByDb(Id)`, `Model.JsonFromString(schema)`
for jsonb, `Model.DateTime{Insert,Update}`; queries are `SqlSchema.findOne/findAll/findOneOption`
(effect-ai-chat `chat-repo.ts`). This is the entire DB access pattern — no ORM.

### 6.5 The composition root (`main.ts`)

The only file that imports every adapter. `Layer.provide` the ports with their chosen adapters, merge
the HTTP server layer, `NodeRuntime.runMain(Layer.launch(AppLive))`. Swapping a provider (Anthropic→
local, OpenAI-embed→jina, reranker on/off for §11.5) is editing this one file.

---

## 7. Data model → migrations & repos

`architecture.md` §5 fully specifies the schema; this maps it to files. No redesign.

- **Adopt & extend the provenance table** (§5.1): the existing `cecc_course_index_course_listing`
  already matches field-for-field (confirmed in reference-scraper). Migration 1: `CREATE EXTENSION`
  (vector), then the `ALTER TABLE … ADD COLUMN raw_markdown, raw_html, course_hash, listing_hash,
  http_status, etag, http_last_modified` (§5.1). `raw_markdown` stores the **whole page** (decision
  D7), and `page_snapshot` keeps full-page fidelity for re-extraction (§5.3.3).
- **Migration sequence** (one file per concern, forward-only):
  1. extensions + provenance ALTERs + `page_snapshot` + `crawl_run` + `system_epoch` (§5.1, §5.3, §6.2) — **Phase 1**
  2. `unit`, `course`, `listing`, `listing_fee`, `listing_instructor`, `course_relation`,
     `listing_change`, `extraction`, `model` (§5.2, §5.3.2, §5.5) — **Phase 2**
  3. `chunk` (+ `tsv` gin), `chunk_embedding` (halfvec, no index — ADR-004) (§5.4) — **Phase 3**
  4. `eval_item`, `eval_run`, `eval_result` (§5.5) — **Phase 4**
  5. `chat_message`, `feedback` (§5.5) — **Phase 5**
- **`term_rank` generated column, `listing_live_idx`/`listing_hist_idx` partial indexes, the RRF CTE,
  the recursive prereq CTE** (§5.2.3, §5.3.1, §7.2, §7.4) go in verbatim — they are already SQL. Repos
  wrap them in `SqlSchema` with decoded `Result` schemas.
- **halfvec marshalling:** embeddings are written as `halfvec` literal strings via the `sql` tag;
  the RRF query casts `$1::halfvec(1024)`. No driver-level vector type needed.

---

## 8. AI layer design (Phases 2 & 5)

### 8.1 The agent loop (§8, §10) — from reference-ai-chat `chat-processor.ts`

The router is `LanguageModel.streamText({ prompt, toolkit })` folded with `Stream.runFoldEffect`,
looping while `finishReason === "tool-calls"`. Tool execution is automatic (the framework runs the
handler and feeds the `tool-result` back). Our adaptation:

- **Five tools** as `Tool.make(name, { parameters, success, failure, failureMode: "return",
  dependencies: [KnowledgeBase] })` in a `Toolkit.make(...)` (§8.1). `filter_listings`'s `parameters`
  **is** the `ListingFilter` schema (§4.2) — the model fills a typed struct, we compile it to
  parameterized SQL. `failureMode: "return"` means a bad filter comes back to the model, not a crash.
- **Prompt builder** (`makePrompt`, effect-ai-chat `chat-processor.ts:161`) is the seam where the
  system prompt and any injected context go. For this catalog most retrieval is _tool-driven_ (agentic
  RAG), so the loop stays lean.
- **`Answer` is structured output, not free text.** The final turn produces an `Answer{prose, cards:
  CardRef[], filter, followups}` via `LanguageModel.generateObject({ schema: Answer })` — this is the
  §1/ADR-008 guarantee mechanically enforced: the schema has **no** price/date/status field, so the
  model _cannot_ emit one. An eval-time test asserts no numeric literal ever appears in `cards` (§11.2).

### 8.2 Streaming (§10.3) — PubSub mailbox → SSE

Reuse effect-ai-chat's producer internals with an SSE transport (ADR-I4): tool/prose deltas
`PubSub.publish` to a per-request `ChatMailbox`; a `Stream.fromPubSubTake(...)` with `replay` feeds
the SSE writer; `hydrate.ts` resolves each `CardRef.listingId` → a full `card` event by reading live
`listing`/`listing_fee`/`status` (§10.4 — read at render, never from the message row). Typed events
map straight to §10.3: `filter` (echoed chips), `prose` (text deltas), `card` (hydrated), `window`
(observation window §5.3.4), `done` (traceId, costMicros).

### 8.3 Extraction (§9) — structured, per-family, decoded before DB

`Extractor` port with three family prompts (A/B/C, §9.1). Each call is `generateObject` against a
family-specific `Schema.Class`; a field that fails to parse is a **typed** `extraction` row with
`status = 'schema_error'`, never a silent `null` (§9). The adapter also writes `listing_change` on
watched-field deltas (§5.3.2/§9.1) and enforces the 13 §9.2 hazards as decode/derivation logic with a
test each. Free labels (`courseCode`/`instructors`) are **verified first** (§9.3) before use.

### 8.4 Embeddings & retrieval (§7) — Embedder port + one SQL statement

`Embedder` adapter (§5.2). Contextual prefixes (§7.3) are a cheap `generateText` per chunk written to
`chunk.context_prefix`. Retrieval is the single hybrid-RRF statement (§7.2) in `retrieval/hybrid-rrf.ts`,
one round trip, no app-side merge; exact scan, no index (ADR-004). `filter_listings` compiles a
`ListingFilter` to parameterized SQL with `disappeared_at IS NULL` unless `includeGone`.

### 8.5 Resilience patterns to adopt at the adapters

- **Subset-aware retry** (reference-ai-lib `Retry`): only replay `RateLimited | Unavailable | Timeout`;
  never replay `InvalidRequest`/`ContentFiltered`. Map HTTP status → typed `AiError` at the adapter
  (reference-ai-lib `Responses.ts:245`).
- **Bounded concurrency** for embed/extract batches: `Effect.forEach(pages, f, { concurrency: N })`
  (ccpd), with the `Queue`-worker-pool variant if a circuit breaker / dead-worker respawn is needed.
- **Reranker degrades to identity** on failure so the service stays up (§14/§11.6).

### 8.6 reference-ai-lib as an optional adapter

If ADR-I1 is revisited toward multi-provider answering, reference-ai-lib slots in behind the same ports:
its `LanguageModel` port's **dual-tag layer** already exposes a generic tag, its `TurnEvent` union
maps onto our SSE events, and `Tool.fromEffectSchema` bridges our `Schema` tools. Nothing above
`adapters/` changes.

---

## 9. Ingest / crawler rewrite (Phase 1 = §6, M1)

A ground-up Effect rewrite (reference-scraper has no Effect to port). Shape from §6:

```
openCrawlRun → discover → fetch → segment → hash-compare ─┬ course_hash Δ  → (M2) extract → embed
                                                          ├ listing_hash Δ → (M2) extract → log Δ
                                                          └ neither → stop
             → closeCrawlRun → sweep (GATED §6.2)
```

- **PageSource adapter** (`fetch`, ADR-002): conditional GET (`etag`/`if-modified-since`), robots.txt,
  bounded concurrency, off-hours, jittered retry. Benchmark fetch-vs-browser once and publish the
  number (ADR-002).
- **Regenerate the scrape approach; capture the full page** (decision D7): fetch → `turndown` →
  **store the whole page** as `raw_markdown` (+ optional `raw_html`) + snapshot by hash (§2.2, §5.3.3).
  Extraction (Phase 2) then reads the full page (ADR-010), not a curated `description` snippet. Reuse
  the ported `dates.ts` (range parsing) and `utils.ts` (sha256); the old per-site CSS selectors inform
  field-location but are re-derived against the captured markdown, not trusted wholesale.
- **Course identity is ground truth, not a heuristic** (confirmed §17 Q1): the "More offerings like
  this" link groups sibling sections (§5.2.6). Follow it → `course_id` grouping is authoritative;
  `external_course_id` is the natural key; `title_normalized` is a rarely-hit fallback for code-less
  family-C rows. Retires ADR-007's weakest argument and makes 868 a measurement.
- **Segmented hashing** (§5.1): course-hash vs listing-hash so a status flip doesn't re-embed an
  unchanged description.
- **Retention is the irreversible M1 deliverable** (§5.3, §16): `first_seen_at`/`last_seen_at`/
  `disappeared_at`, `crawl_run`, `system_epoch`, `page_snapshot`. **Start the clock.**
- **The sweep gate** (§6.2): sweep only if `crawl_run.status='ok'` and `pages_seen ≥ 0.8×` the last
  good run — the durable-workflow ordering (ADR-I6) enforces "sweep after closeCrawlRun" for free;
  the 80% threshold is a plain guard. This is the §14 "eats your history" mitigation and is
  **non-negotiable before the first real crawl**.
- **Zero AI in Phase 1** (§16 M1).

---

## 10. HTTP surface (Phase 5–6 = §10)

- `http/api.ts` — `HttpApi` with groups: `search` (Phase 3), `chat` (Phase 5), `hydrate`, `feedback`,
  `compat` (Phase 6). `effect/unstable/httpapi`.
- `http/chat.ts` — SSE per §10.3 (§8.2 above).
- `http/hydrate.ts` — `CardRef → Card`; **the §1 guarantee lives here** (reads live status/fees §10.4).
- `http/compat.ts` — OpenAI-compatible `/v1/chat/completions` SSE (§10.5); ~100 lines; degrades to a
  markdown table (no cards) but data still hydrated.
- **Single-active-run** per session via the DB-enforced conditional `UPDATE … WHERE active_run_id IS
  NULL RETURNING id → Option.isSome` (effect-ai-chat `chat-repo.ts:98`).

`apps/web` (Astro + effect-atom, §10.5): cards, editable filter chips (§10.2 — re-run without an LLM
call), zero-result relaxation (§10.3), freshness "checked 3h ago" (§10.4), feedback→eval promotion
(§5.5). Imports `Answer`/`Card`/`Filter` from `packages/domain` for type safety.

---

## 11. Phased roadmap (maps 1:1 to architecture.md §16)

Each phase lists the key Effect deliverables and an **exit criterion** (from §16, made concrete).
Full task checklists live in the progress doc.

| Phase               | = §16                 | Deliverables (Effect)                                                                                                                                                                                                                                                                                                                                              | Exit criterion                                                                                                                                                     |
| ------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **0 · Foundations** | _(new — precedes M1)_ | pnpm workspace; effect beta pinned + **unstable path audit**; `tsconfig`/lint/fmt; `AppConfig`; `SqlLive`+`SqlAdmin` (ADR-I5); `PgMigrator`; error/telemetry skeletons; `@effect/vitest` + testcontainers harness; `main.ts` composition root; empty port tags in `domain`; CI green                                                                               | `pnpm test` runs a testcontainer migration + a trivial `it.effect` against `SqlLive`; `main.ts` boots and serves a health endpoint                                 |
| **1 · Re-crawl**    | M1 🔴                 | PageSource (fetch); **regenerated scrape approach, full-page capture** (D7); ingest workflow; migrations set 1; segmented hashing; **full-page `raw_markdown`(+`raw_html`)**+`page_snapshot`; **grouping link as authoritative course id** (§17 Q1); retention columns + `system_epoch`; **gated sweep**; ported `dates.ts`/`utils.ts`; fetch-vs-browser benchmark | All 1,083 re-fetched politely; **whole page** stored as `raw_markdown`; course grouping from the link; clock started; sweep refuses on a short crawl. **Zero AI.** |
| **2 · Extract**     | M2                    | Extractor (Anthropic, `generateObject`); 3 family prompts; migrations set 2; 13 §9.2 hazards each tested; `listing_change` writer; free labels verified then 30 family-stratified hand labels                                                                                                                                                                      | Per-field P/R **per family** published; typed `extraction` rows; no silent nulls                                                                                   |
| **3 · Retrieve**    | M3                    | Embedder; migrations set 3; contextual prefixes; hybrid-RRF; `filter_listings` from `ListingFilter`; KnowledgeBase; `/search` (no generation)                                                                                                                                                                                                                      | `/search` returns fused `course_id`s + filtered listings; exact-scan latency measured                                                                              |
| **4 · Evaluate**    | M4                    | Golden set fixtures (150–200, stratified §11.1); runner (`Effect.forEach({concurrency:5})`); `LlmJudge`; migrations set 4; **`filter_exact`** headline; **CI gate** (−2pt fails)                                                                                                                                                                                   | Golden set + runner + CI gate green; `filter_exact` reported                                                                                                       |
| **5 · Answer**      | M5                    | Router + Toolkit loop; `Answer`/`CardRef` schema (structured); 5 tools; `hydrate.ts`; SSE typed events; grounded refusal (§10.6); migrations set 5; single-active-run; **assert no factual field leaves the model**                                                                                                                                                | Streaming grounded answers with hydrated cards; baseline eval recorded; the ADR-008 assertion is a passing test                                                    |
| **6 · Surface**     | M6                    | Astro + effect-atom: cards, chips, zero-result relaxation, freshness, feedback→eval; `compat.ts`; Open WebUI quadlet                                                                                                                                                                                                                                               | The product demo works end-to-end; feedback promotes to eval items                                                                                                 |
| **7 · History**     | M7                    | `course_history` tool; observation-window honesty (§10.6); `temporal` eval slice                                                                                                                                                                                                                                                                                   | "does it run every year?" answers _"I don't know yet"_ at `n=1`, correctly, as a scored eval item                                                                  |
| **8 · Ablate**      | M8                    | Ablation runner; §11.5 table by shape; both baselines (compact index, whole-catalog); ADR-004 crossover curve; reranker adapter + keep/drop decision                                                                                                                                                                                                               | The §11.5 table filled; ADR-004 crossover published                                                                                                                |
| **9 · Ship**        | M9                    | Podman quadlets (§13); traces; README + ablation table; 3-min demo                                                                                                                                                                                                                                                                                                 | Deployed; ADRs + README complete                                                                                                                                   |

**The M1/M7 split is the whole point (§16):** retention _recording_ (Phase 1) is urgent and
irreversible; history _querying_ (Phase 7) can wait. Phase 1's retention columns are non-negotiable
because every crawl without them destroys data permanently.

---

## 12. Testing & eval strategy

- **Unit/layer:** `@effect/vitest` `it.effect` with mock layers (`Layer.mock`). The **mock
  `LanguageModel`** (`LM.make({streamText, generateText})` + `withLanguageModel(...)`, effect-ai-chat
  `test/utils`) drives the agent loop deterministically — script `tool-calls` then `text-delta` and
  assert the loop iterates. This is how §11 gets tested without spending on a provider.
- **DB:** `@testcontainers/postgresql` boots a real PG; each test runs in a transaction rolled back at
  the end (`withTransactionRollback`). Migrations run against the container in `globalSetup`.
- **Extraction hazards (§9.2):** one test per hazard, feeding a fixture `raw_markdown` and asserting
  the derived row (e.g. `$ 415 Tuition`/`$ 415 Total Fees` → two `listing_fee` rows, `is_total` flag).
- **The §1 guarantee as a test:** parse every `Answer.cards`; fail if any factual literal appears
  (ADR-008 asserted, not scored).
- **Eval harness (§11) is Phase 4 — before the chat UI (ADR-009).** `filter_exact` is the headline;
  CI blocks a PR that drops it or nDCG@10 by >2pt.

---

## 13. Deployment (§13)

Rootless Podman + Quadlet, extending the existing stack. Units per §13 (`catalog-api`,
`catalog-migrate` oneshot on `:5432`, `catalog-ingest` timer with gated sweep, `reranker`,
`catalog-web`, `open-webui`, `otel-collector`). Config via `Config.redacted` from `secrets/` env
files; two connection strings always (`POSTGRES_URL` :6432, `POSTGRES_ADMIN_URL` :5432). No new backup
story — the existing pgBackRest schedule already covers every table, and the temporal layer is the
only irreplaceable data in the system (§14).

---

## 14. Risks & open questions

Implementation-level risks:

- **R1 — Effect v4 beta churn (ADR-001/ADR-I3).** `unstable/*` paths move. _Mitigation:_ pin exact
  beta, Phase-0 path audit, contain vendor libs to `adapters/`.
- **R2 — Workflow-engine maturity (ADR-I6).** _Mitigation:_ table-driven resume fallback; sweep gate
  is a `WHERE` guard regardless.
- **R3 — Provider embeddings in v4.** `effect/unstable/ai` core has no `EmbeddingModel`. _Mitigation:_
  thin HTTP adapter (WeatherApi template) or reference-ai-lib `jina` — either is one file.
- **R4 — AI-stack choice (ADR-I1 / decision D1).** Contained by the ports; recommend first-party,
  flagged for the user before Phase 5.

The **product** open questions (§17): **Q1 — answered** (the grouping link groups sibling sections →
course identity is ground truth, §5.2.6). **Q3 — superseded** by decision D7: we regenerate the scrape
approach and capture the **full page**, so the adequacy of the existing `description` column no longer
gates anything — we re-capture everything. Still open and worth a Phase-1 SQL check: Q2 (do families
track `cecc_unit`? — drives extraction prompts, §9.1) and Q5 (how much history has already been thrown
away? — the strongest argument for §5.3).

---

## 15. Immediate next steps (start of Phase 0)

1. ~~Decide D1~~ **Done: first-party `effect/unstable/ai`** on Node (ADR-I1/I2). Phase 5 clones
   reference-ai-chat; reference-ai-lib stays a drop-in adapter for `jina` embeddings.
2. ~~Run §17 Q1/Q3~~ **Done: Q1 = grouping link is authoritative course id; Q3 superseded by D7**
   (regenerate scrape, capture full page). Still worth a check during Phase 1: §17 Q2 & Q5.
3. `git init`; `.gitignore` the four reference repos; scaffold the pnpm workspace (§4.2).
4. Pin the newest `effect@4.0.0-beta.x`; **audit `effect/unstable/*` export paths** (ADR-I3); write
   `main.ts` + `SqlLive`/`SqlAdmin` + `PgMigrator` + one testcontainer `it.effect` to prove the spine.
5. Port `dates.ts`/`utils.ts`; stub the port tags in `packages/domain`.

Then Phase 1, and the clock starts (§16).
