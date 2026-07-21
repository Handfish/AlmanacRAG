# CECC Course Catalog — RAG & Chat Architecture

**Status:** Draft · rev 7
**Last updated:** 2026-07-16
**Supersedes:** revs 1–6

---

## 1. Thesis

> **The model chooses rows. The database speaks the facts. And it remembers what the catalog forgot.**

The LLM never emits a price, a date, a location, or a seat status. It emits `listing_id`s and
connective prose. Every factual field is hydrated from Postgres at render time and shown as a
card. A hallucinated `$450` where the catalog says `$415` is not a faithfulness score to be tuned
toward 1.0 — it is unreachable, because the number was never in the model's output path.

Four properties fall out, each measured rather than asserted.

**Facts are guaranteed; prose is measured.** Card contents cannot drift. Connective prose can, and
§11.2 scores exactly that, on exactly the narrow surface where it's possible.

**The user's goal is enrollment, not an answer.** Nobody asks a course catalog a question for the
joy of the answer. They want to find a thing and sign up for it. So responses terminate in the
shortest path that _actually exists_ to enrolling, plus a live seat status — not a paragraph.

_"Actually exists"_ is load-bearing. The source page says: **"To Register: Click on 'Register
Here' on our Menu. Then use the Keyword 'Alternate Route' and click search!"** — there may be **no
registration URL at all**. Rendering a `[Register →]` button fabricates an affordance, which is
the failure ADR-008 prevents, leaking back in through the UI (§10.1).

**Most queries are structured queries in natural-language costume.**

> _"What evening cybersecurity classes start before September, under $2,000, in Newark?"_

Four hard predicates, one soft. Cosine distance serves exactly one. So retrieval is
**structured-first**: extraction produces typed rows at ingest; hard predicates route to SQL, soft
predicates to hybrid search over 868 short descriptions.

**It remembers what the catalog forgot.** The site publishes only what is currently offered. Last
fall's price, last summer's schedule, the date section 289 filled up — none of it is on the web
today and none of it is recoverable later. A crawler that overwrites is destroying the only copy
that will ever exist. §5.3 makes retention the default, and it is the one capability in this
document with a **deadline that money cannot buy back** (§16).

### 1.1 The competitor

At 1,083 listings the honest baseline is not naive prompt-stuffing (~870k tokens — doesn't fit).
It is a **compact index**: one ~50-token line per listing, ~54k tokens, in-window and cacheable.
It will likely match or beat this system on lookup and comparison, cheaply.

It loses on four things, and they are the project's entire justification:

|                            | Compact index                                                                         | This system                                       |
| -------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Exhaustive filtered recall | Attention is not a `WHERE` clause. It will miss rows.                                 | Deterministic                                     |
| Factual guarantee          | Model reads the fee and retypes it. Can drift.                                        | Hydrated. Cannot drift (§1)                       |
| Freshness                  | Prompt text is as stale as the last rebuild                                           | `status` read at render (§10.4)                   |
| **Memory**                 | **Impossible at any price** — last fall's catalog isn't on the web to put in a prompt | `listing.disappeared_at`, `listing_change` (§5.3) |

The memory row is qualitatively different from the other three. The first three are _harder_ for
the baseline. The fourth is **unavailable to it**, permanently, because the information doesn't
exist anywhere it can reach. Nobody at Rutgers can currently answer _"what did this cost last
fall?"_ without digging through archives.

So the claim is narrow, defensible, and measured — not "I built a RAG":

> The compact-index baseline is competitive on lookup and comparison. Structured extraction wins
> decisively on filtered-exhaustive recall, factual guarantee, and freshness — and history is a
> capability it cannot have. Here is the crossover.

A permanent row in §11.5, not a strawman.

---

## 2. What is measured

Milestone 0 is complete. Facts, not estimates. Several killed earlier design arguments; §15 records
which.

| Quantity                            | Value                               | Consequence                                                               |
| ----------------------------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| Listings                            | **995** (re-crawled; M0 est. 1,083) | Small. Almost every scale-driven instinct is wrong here.                  |
| Distinct courses (by grouping link) | **732** → 1.36 sections/course      | Course/listing split is real but _thin_ (§5.2)                            |
| Raw corpus                          | ~870k tokens                        | Naive context baseline is dead                                            |
| Compact index                       | ~54k tokens                         | The real competitor (§1.1)                                                |
| Expected chunks                     | **~870** (1 course = 1 chunk)       | ADR-004: no vector index                                                  |
| Vector set                          | ~1.7 MB `halfvec(1024)`             | Exact scan, sub-millisecond                                               |
| Full extraction pass                | **~$4**                             | Hash gate is correct, not existential                                     |
| `course_data` populated             | **0/995**                           | Legacy column empty in the real crawl; facts live in `page_fields` (§2.1) |
| `page_fields` populated             | **995/995**                         | One template, field-presence gradient — not 3 families (§2.1)             |
| Structured facts stored             | **none**                            | 🔴 Blocking (§2.2)                                                        |
| Observation history                 | **n = 1 term**                      | Cannot be backfilled (§5.3, §17.5)                                        |

### 2.1 The field-presence gradient

An earlier revision claimed three disjoint `course_data` families (A `courseCode` / B
`audience`+`certificateDisplay`+`instructors` / C `'{}'`). **Measured against the real re-crawl, that
model is wrong.** `course_data` is empty (`'{}'`) on all 995 pages; those keys were the
`reference-scraper` reference scraper's output, not this catalog's. The real structured signal is
the deterministic `page_fields` capture (§9 preview), populated on **995/995** pages.

`page_fields` does **not** partition into disjoint templates. It is one template with a required core
and a long optional tail:

| Band     | Present on | Fields                                                                                                                 |
| -------- | ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| Core     | ≥99%       | `status`, `title`, `fees`, `session`, `courseId`, `sectionId`, `prerequisites`                                         |
| Common   | 89–95%     | `instructor`, `location`, `refundPolicy`, `dates`                                                                      |
| Optional | 46–69%     | `times`, `days`, `category`, `format`, `cancellationPolicy`                                                            |
| Rare     | ≤21%       | `availableSlots`, `alternateSchedule`, `abstract`, `admissionRequirements`, `audience` (13%), `instructorBio` (13%), … |

**144 distinct key-signatures** across 995 pages, with key-count per page a smooth distribution
(8→20, peaking 14–18) — a gradient, not three bins. The consequence inverts the old design: not one
prompt per family, but **one extraction schema with a required core and nullable optional fields**
(§9.1); hand labels stratified by **field-presence**, not family (§9.3); eval reported **per field**
(§11.5). A uniform sample still under-represents rare fields — stratify by key-count band, not by a
family that doesn't exist.

Two former load-bearing claims are now falsified against real data:

- _"Only 345 pages carry a course code — use them as a free answer key."_ `courseId` is present on
  **987/995 (99%)**, but its values are inconsistent (`YD0805`, `Polestar`, `RagoneAUDprep`,
  `ULA-2026-20274`). It is a field to **verify**, not an oracle (§9.3).
- _"Families track `cecc_unit` / `root_url`."_ Both columns are **null on every row** — the flat
  `searchResults.cfm` index the crawl discovered from never carried them (§17.2).

### 2.2 The blocking gap

`description` holds description prose only. The facts this system exists to serve — `Section ID`,
`Session: Summer 2026`, `Dates 7/20–8/03`, `Status: Course Full`, `$415 Tuition`, `Format`,
`Location` — exist on the origin pages and **nowhere in the database**. `course_data` has no
temporal or financial field at all.

You cannot extract what you did not store. Milestone 1 is a re-crawl that keeps `raw_markdown`
(§6.1); everything downstream is blocked until it lands.

---

## 3. Non-goals

| Non-goal                               | Why                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-tenancy                          | One catalog, one owner.                                                                                                               |
| High availability                      | Single well-operated node; the existing Postgres quadlet is the standard.                                                             |
| Fine-tuning                            | 868 documents. Retrieval isn't the bottleneck either — query parsing is (§8).                                                         |
| Multi-agent orchestration              | One router, five tools, auditable in one file.                                                                                        |
| Graph database                         | Prerequisite chains are a recursive CTE (§7.4).                                                                                       |
| Free-form text-to-SQL as primary       | ADR-005. Gated fallback, measured separately.                                                                                         |
| **Bitemporal modelling**               | ADR-011. We have observation time only; claiming valid time would claim precision the data can't support.                             |
| **SCD-2 row versioning**               | ADR-011. Status churns daily; row-per-change generates thousands of near-identical rows. A field-level change log is the right shape. |
| Authenticated pages, student data, PII | Public catalog only.                                                                                                                  |
| Republishing page text                 | Extracted facts and links out; prose stays at the source.                                                                             |

---

## 4. Architecture

Ports and adapters. The domain layer imports no vendor code. Postgres, the embedder, the LLM, the
reranker, the fetcher — each enters through one `ServiceMap.Service` port with exactly one adapter
Layer.

Not decoration: containment for two known churn sources. Effect v4 is in beta and its
`unstable/*` paths move between releases (ADR-001); the AI provider libraries are pre-1.0. When
either breaks, the blast radius is one file under `src/adapters/`.

```
┌─ domain ──────────────────────────────────────────────────┐
│  Course · Listing · Chunk · Answer · CardRef · Filter      │
│  KnowledgeBase · Extractor · Embedder · Reranker           │
│  Answerer · PageSource · Judge          (ports, no impl)   │
└───────────────────────────────────────────────────────────┘
          ▲                                    ▲
┌─────────┴──────────────┐        ┌────────────┴────────────┐
│  agent · workflows     │        │  adapters               │
│  router · tools        │        │  PgKnowledgeBase        │
│  ingest · sweep        │        │  FetchPageSource        │
│  eval runner           │        │  OpenAiEmbedder         │
│  (pure orchestration)  │        │  AnthropicAnswerer      │
└────────────────────────┘        │  BgeReranker            │
                                  └─────────────────────────┘
```

### 4.1 Module layout

```
src/
├── domain/                 # Schemas + ports. Zero vendor imports.
│   ├── course.ts           #   Course, Listing, Fee
│   ├── answer.ts           #   Answer, CardRef       ← the §1 contract
│   ├── filter.ts           #   ListingFilter         ← the §8 contract
│   ├── history.ts          #   TermRun, ChangeEvent, ObservationWindow
│   ├── knowledge-base.ts
│   ├── extractor.ts · embedder.ts · reranker.ts · answerer.ts · page-source.ts
├── adapters/
│   ├── sql-live.ts         # PgBouncer :6432, prepare:false, fetch_types:false
│   ├── sql-admin.ts        # direct :5432, DDL only
│   ├── pg-knowledge-base.ts
│   ├── fetch-page-source.ts
│   ├── embedder-*.ts · answerer-*.ts · reranker-bge.ts
├── agent/
│   ├── router.ts
│   └── tools/{search-catalog,filter-listings,get-course,compare-courses,course-history}.ts
├── workflows/{ingest,sweep,reembed}.ts
├── evals/{runner,judge}.ts + fixtures/
├── http/
│   ├── api.ts              # HttpApi
│   ├── chat.ts             # SSE, typed events (§10.3)
│   ├── hydrate.ts          # CardRef → Card. The §1 guarantee lives here.
│   └── compat.ts           # OpenAI-compatible; degraded surface (§10.5)
├── migrate.ts
└── main.ts                 # Layer composition; the only file that knows every adapter
```

> **Effect v4.** V4 has moved from `effect-smol` into the canonical `Effect-TS/effect` repo; `main`
> is the v4 branch and `effect-smol` is archived. Still beta — the team recommends v3 for
> production, but v3 is feature-frozen (bug fixes and security only; new features are v4-only).
> ADR-001. Pin exact betas; verify `effect/unstable/*` paths against the installed version.

### 4.2 The two contracts

Everything in §1 reduces to two schemas. The most load-bearing code in the project.

```ts
// src/domain/answer.ts — what the model is allowed to emit
export class CardRef extends Schema.Class<CardRef>("CardRef")({
  listingId: ListingId,
  why: Schema.String, // one line. Prose — may drift, is measured (§11.2)
}) {}

export class Answer extends Schema.Class<Answer>("Answer")({
  prose: Schema.String, // connective tissue only
  cards: Schema.Array(CardRef),
  filter: Schema.NullOr(ListingFilter), // echoed as chips (§10.2)
  followups: Schema.Array(Schema.String),
}) {}
```

No `price`, no `date`, no `status`. The model _cannot_ return one. `http/hydrate.ts` turns each
`listingId` into a full card by reading Postgres. That is the whole mechanism.

```ts
// src/domain/filter.ts — what the model is allowed to ask for
export class ListingFilter extends Schema.Class<ListingFilter>("ListingFilter")({
  campus: Schema.optional(Campus),
  program: Schema.optional(Schema.String),
  ceccUnit: Schema.optional(Schema.String),
  term: Schema.optional(Schema.String),
  startsBefore: Schema.optional(Schema.DateFromString),
  startsAfter: Schema.optional(Schema.DateFromString),
  maxFeeCents: Schema.optional(Schema.Int),
  minFeeCents: Schema.optional(Schema.Int),
  deliveryMode: Schema.optional(DeliveryMode),
  isEvening: Schema.optional(Schema.Boolean),
  status: Schema.optional(Status),
  openForReg: Schema.optional(Schema.Boolean), // registration_deadline >= today
  minHours: Schema.optional(Schema.Number),
  maxHours: Schema.optional(Schema.Number),
  includeGone: Schema.optional(Schema.Boolean), // default false — see §5.3
}) {}
```

Compiles to a parameterized query. No injection surface, no hallucinated columns, no unbounded
scans — and because it round-trips to the UI as editable chips (§10.2), the model's interpretation
is visible and correctable.

---

## 5. Data model

One database. DDL via `migrate.ts` against `:5432` in session mode; everything else through
PgBouncer at `:6432` with `prepare: false` and `fetch_types: false` — transaction pooling hands you
a different backend mid-transaction and any cached prepared statement is invalid. A permanent
property of the adapter layer, not a workaround.

### 5.1 Provenance — extend, don't replace

`cecc_crawler.cecc_course_index_course_listing` exists and is `source_page`:

```
id uuid PK · url text UNIQUE · content_hash text · last_hash_comparison_at · updated_at
created_at · school · cecc_unit · program · root_url · course_title · description
course_data jsonb DEFAULT '{}'
```

Adopt it. `url UNIQUE` is page identity; `content_hash` + `last_hash_comparison_at` are the change
gate; `school`/`cecc_unit`/`program`/`course_title` are already carved out. Additions:

```sql
ALTER TABLE cecc_course_index_course_listing
  ADD COLUMN raw_markdown  text,     -- 🔴 the blocking gap (§2.2)
  ADD COLUMN course_hash   bytea,    -- title + description + prereqs
  ADD COLUMN listing_hash  bytea,    -- term/dates/status/instructor/fees
  ADD COLUMN http_status   smallint,
  ADD COLUMN etag          text,
  ADD COLUMN http_last_modified timestamptz;
```

**Segmented hashing.** One hash over a whole page conflates two lifetimes:

| Segment | Contents                                      | Churn          |
| ------- | --------------------------------------------- | -------------- |
| course  | title, description, prerequisites             | years          |
| listing | term, dates, status, instructor, format, fees | daily → termly |

`Status: Course Full` flipping when someone drops would otherwise re-hash the row, re-extract a
180-word description that didn't move, and re-embed a byte-identical chunk. Split the hash and
status churn costs a cheap typed re-extract and zero embedding spend.

This is also the **primary** argument for §5.2's course/listing split. At a measured 1.25
sections/course the embedding-economics argument is worth ~20% and cannot carry the design; the two
lifetimes are visible on a single page and are real regardless of the ratio.

### 5.2 Typed layer — the primary answer path

Derived by close reading of a representative page (`ALT10` section 289), field by field. The page hides
facts in three places a naive schema doesn't look: **inside the title**, **inside footnotes**, and
**inside the description prose** (ADR-010). Every column traces to something observed.

#### 5.2.1 Unit — where policies actually live

~10 CECC units, not 1,083 pages. Refund and cancellation policies, the contact address, and
registration instructions are **unit-scoped boilerplate with per-course amendments** — not page
duplication (ADR-006) and not absent.

```sql
CREATE TABLE unit (
  id                        smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name                      text NOT NULL UNIQUE,   -- 'Effective School Practices'
  school                    text,                   -- 'New Brunswick' | 'Newark' | 'Camden'
  contact_email             text,                   -- 'altroute@gse.rutgers.edu'
  refund_policy             text,
  cancellation_policy       text,
  registration_instructions text                    -- 'Click Register Here… use the Keyword…'
);
```

Ten rows answers _"what's the refund policy?"_ and _"who do I contact?"_ — both real questions with
nowhere to live in earlier revisions.

#### 5.2.2 Course — keyed on the catalog's identifier, not on a string

```sql
CREATE TABLE course (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  unit_id            smallint REFERENCES unit(id),   -- NULLABLE: cecc_unit null on all 995; policies are per-page (§2.1)

  group_url          text UNIQUE,              -- couID grouping = course identity (§5.2.6): 732 distinct
  external_course_id text,                     -- verified attribute, NOT unique (messy: PP-2216, 520024; ⚠ §9.2 misalignment)
  course_title       text NOT NULL,            -- verbatim
  title_normalized   text NOT NULL,            -- casefold, collapse ws/hyphens; fallback key only

  -- Parsed out of the title: 'Alternate Route 45 - Hour Math Across the Curriculum Online Course'
  track              text,                     -- 'Alternate Route'
  contact_hours      numeric(5,1),             -- 45   ← was sitting inside a string
  subject            text,                     -- 'Math Across the Curriculum'

  program            text,                     -- 'NUMERACY ACROSS THE CURRICULUM' (normalize case)
  description        text,                     -- the only field worth embedding
  audience           text,                     -- optional; present on ~13% of pages (§2.1)
  prerequisite_text  text,                     -- verbatim; usually 'None' — and often wrong (§9.2)
  registration_keyword text,                   -- 'Alternate Route'
  refund_policy_override text,                 -- 'amended refund policy for the Summer Sessions…'

  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX course_fallback_key ON course (title_normalized)
  WHERE group_url IS NULL;
```

**The couID grouping (`group_url`) is the natural key** (§5.2.6): the "More offerings like this" link
is the site's own statement of which sections are one course — 732 distinct across 995 pages. Earlier
revisions keyed on `external_course_id` (or on `(cecc_unit, course_title)`), but the printed `courseId`
is present on ~99% of pages yet **heterogeneous** (`PP-2216`, `RootsRockRoll-`, `520024`) — a value to
**validate, not trust** (§9.3), and never unique. `title_normalized` is the fallback only for the rare
page with no grouping link. The field-presence band (§2.1) is computed from `page_fields` at eval time,
not stored as a column.

#### 5.2.3 Listing — one row per crawled page

```sql
CREATE TABLE listing (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_page_id      uuid NOT NULL REFERENCES cecc_course_index_course_listing(id),
  extraction_id       bigint NOT NULL REFERENCES extraction(id),
  course_id           bigint NOT NULL REFERENCES course(id) ON DELETE CASCADE,
  external_section_id text,                     -- '289'

  session_label       text,                     -- raw 'session' ('2025-26', '2024-EBP') — a cohort label, NOT a term
  -- term_* are DERIVED from the START MONTH of `dates` (real `session` carries no season). term_rank sorts chronologically.
  term                text,                     -- derived label, e.g. 'Summer 2026'
  term_year           smallint,
  term_season         text CHECK (term_season IN ('Winter','Spring','Summer','Fall')),
  term_rank           integer GENERATED ALWAYS AS (
                        term_year * 10 + CASE term_season
                          WHEN 'Winter' THEN 1 WHEN 'Spring' THEN 2
                          WHEN 'Summer' THEN 3 WHEN 'Fall'   THEN 4 ELSE 0 END
                      ) STORED,

  starts_on           date,                     -- 'Dates 7/20/2026 - 8/03/2026'
  ends_on             date,
  schedule_text       text,                     -- verbatim 'Alternate Schedule' block
  is_evening          boolean,                  -- NULL is legal and common (§8)

  -- The footnote is a rule: '*deadline … two business days prior to the start of the course'
  registration_deadline      date,              -- derived
  registration_deadline_rule text,              -- verbatim footnote, for display

  -- 'Distance Education: Online e-College' → {category}: {platform}
  format_text         text,
  format_category     text,                     -- 'Distance Education'
  format_platform     text,                     -- 'Online e-College'
  delivery_mode       text CHECK (delivery_mode IN
                        ('in_person','online_sync','online_async','hybrid','unknown')),

  -- 'Online, n/a' → {site}, {room}
  location_text       text,
  location_site       text,                     -- 'Online'
  location_room       text,                     -- 'n/a' → NULL
  campus              text CHECK (campus IN
                        ('New Brunswick','Newark','Camden','Online','Other','unknown')),

  status              text NOT NULL CHECK (status IN
                        ('open','full','waitlist','closed','unknown')),  -- 4 real values map here; unmatched → 'unknown' + alert (§9.2)
  is_new              boolean NOT NULL DEFAULT false,   -- 'NEW OFFERING' badge
  total_fee_cents     integer,                  -- denormalized from listing_fee

  -- The terminal action — §10.1. There may be NO register URL.
  detail_url          text NOT NULL,
  registration_url    text,                     -- often NULL; the flow is keyword search

  -- Retention (§5.3). Not versioning — observation bookkeeping.
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  disappeared_at      timestamptz               -- NULL = still published
);
```

**`delivery_mode` needs two sources.** `Format: Distance Education: Online e-College` is silent on
sync vs. async; the evidence is in the description — _"Candidates work asynchronously as they engage
with readings…"_. Deriving it from the Format field alone loses the distinction users care most
about.

**`registration_deadline` answers a question `status` cannot.** _"Is it too late to sign up?"_ and
_"is it full?"_ are different, and both are asked.

#### 5.2.4 Children — because the source is plural

```sql
-- 'Instructor: N/A, -' is {last}, {first}. A listing may carry several, so instructors are children.
CREATE TABLE listing_instructor (
  listing_id bigint NOT NULL REFERENCES listing(id) ON DELETE CASCADE,
  ord        smallint NOT NULL,
  last_name  text,                              -- NULL when 'N/A'
  first_name text,                              -- NULL when '-'
  PRIMARY KEY (listing_id, ord)
);

-- '$ 415 Tuition' / '$ 415 Total Fees' — a breakdown, not a scalar
CREATE TABLE listing_fee (
  listing_id   bigint NOT NULL REFERENCES listing(id) ON DELETE CASCADE,
  ord          smallint NOT NULL,               -- labels are NOT unique per page (real data: tier prose) — key on ord
  label        text NOT NULL,                   -- 'Tuition', 'Registration Fee', 'Tuition - for non-member…'
  amount_cents integer NOT NULL,
  is_total     boolean NOT NULL DEFAULT false,  -- 'Total Fees' is itself a line
  PRIMARY KEY (listing_id, ord)
);
```

#### 5.2.5 Relations — extracted from prose, not just the field

```sql
CREATE TABLE course_relation (
  course_id   bigint NOT NULL REFERENCES course(id) ON DELETE CASCADE,
  raw_text    text NOT NULL,
  source      text NOT NULL CHECK (source IN ('prereq_field','description')),
  requires_id bigint REFERENCES course(id),     -- NULL when unresolvable
  kind        text CHECK (kind IN ('required','recommended','corequisite','concurrent')),
  PRIMARY KEY (course_id, raw_text)
);
```

**The Prerequisites field lies by omission.** On `ALT10` it reads `None` — while the description
says _"Because it is an online course, Numeracy Across the Curriculum can be taken simultaneously
with Phase I, II, or III."_ That is a real `concurrent` relation to three other courses, invisible
to anything reading only `prerequisite_text`. Hence `source`.

Most rows will be `'None'` and most of the rest won't resolve. Publish the resolution rate; don't
assume it.

#### 5.2.6 Course grouping is given, not inferred

**"More offerings like this."** — the link at the top of every page — is the site's own statement of
which listings are the same course. Crawl it in milestone 1 and `course_id` grouping becomes ground
truth rather than a title-matching heuristic (§17.1). The single highest-leverage change available
to the data model: it converts 868 from an estimate into a measurement and retires ADR-007's weakest
argument.

### 5.3 Temporal layer — retention, not versioning

**The catalog has no memory. This system is the only place one will ever exist.**

The site publishes what is currently offered. Fall 2026 is up; Summer 2025 is gone and is not
coming back. A crawler that overwrites is destroying the only copy. Everything here is cheap —
under 100 MB/year, roughly a day of work — and **none of it can be backfilled** (§16).

Get the framing right before the DDL: **most of this is not versioning.**

| Question                        | What it needs                            | Cost                  |
| ------------------------------- | ---------------------------------------- | --------------------- |
| "Does ALT10 run every summer?"  | Sections from different terms coexisting | **Already works**     |
| "Has it gotten more expensive?" | Same, plus terms that fell off the site  | **Don't delete**      |
| "When did section 289 fill up?" | Field-level change tracking              | A narrow log (§5.3.2) |

The first is free. Different terms are different sections at **different URLs** — Summer 2026 section 289
and Fall 2026 section 301 are two rows under the existing `url UNIQUE`. That is literally where the 1.25
sections/course figure comes from. `course_history` over currently-published terms is a tool, not a
migration.

What's missing is terms that have **fallen off the site**. That's retention.

#### 5.3.1 Stop deleting

The three columns on `listing` (§5.2.3) are the whole feature for questions 1 and 2. Every crawl
bumps `last_seen_at` on URLs it sees; a sweep afterward marks the rest gone. `filter_listings` adds
`AND disappeared_at IS NULL`; `course_history` doesn't. No row copies, no SCD-2, no valid-time
intervals.

```sql
CREATE INDEX listing_live_idx  ON listing (course_id) WHERE disappeared_at IS NULL;
CREATE INDEX listing_hist_idx  ON listing (course_id, term_rank);
```

#### 5.3.2 A change log, not row versions

Status churns daily. SCD-2 on `listing` would generate thousands of near-identical rows recording
`full → open → full`. You don't want the rows; you want the delta.

```sql
CREATE TABLE listing_change (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  listing_id  bigint NOT NULL REFERENCES listing(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL DEFAULT now(),
  field       text NOT NULL,        -- whitelist: status, total_fee_cents, starts_on,
                                    --            ends_on, instructor, registration_deadline
  old_value   text,
  new_value   text
);
CREATE INDEX listing_change_idx ON listing_change (listing_id, field, observed_at DESC);
```

Written by the extract activity when a re-extract yields a different value on a **watched** field —
a whitelist, not every column. Volume: 1,083 listings × a few status flips a year ≈ low thousands of
rows annually.

#### 5.3.3 Snapshot the markdown, keyed by hash

Extraction will improve. You will want to re-run milestone-2 prompts against last year's pages, and
you cannot re-crawl the past.

```sql
CREATE TABLE page_snapshot (
  source_page_id uuid NOT NULL REFERENCES cecc_course_index_course_listing(id) ON DELETE CASCADE,
  content_hash   bytea NOT NULL,
  raw_markdown   text NOT NULL,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_page_id, content_hash)
);
```

Keyed on the hash, so an unchanged page writes nothing. Only distinct content is ever stored. The
dominant storage consumer and still small: ~200 changed pages/week × ~5 KB, TOAST-compressed,
≈ 15 MB/year.

#### 5.3.4 The observation window is a first-class fact

**History accrues forward and cannot be backfilled.** Today `n = 1`. A single sighting of a summer
section is not evidence that it runs every summer, and the system must say so rather than imply a
pattern.

```sql
CREATE TABLE system_epoch (
  id                smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  observing_since   timestamptz NOT NULL,
  terms_observed    smallint NOT NULL DEFAULT 0
);
```

`course_history` returns its window alongside its data, and §10.6 refuses claims the window can't
support. This makes _"does this run every year?"_ against `n=1` an `eval_item` with a correct
answer — _"I don't know yet"_ — rather than a UI nicety (§11.1).

#### 5.3.5 Queries

```sql
-- "Does ALT10 run every summer?"
SELECT term_season, term_year, count(*) AS sections,
       min(total_fee_cents) AS fee,
       bool_or(disappeared_at IS NULL) AS still_listed
FROM listing WHERE course_id = $1
GROUP BY 1,2 ORDER BY term_year, min(term_rank);

-- "Has it gotten more expensive?"
SELECT term, min(total_fee_cents) FROM listing
WHERE course_id = $1 AND total_fee_cents IS NOT NULL
GROUP BY term, term_rank ORDER BY term_rank;

-- "When did 289 fill up?"
SELECT observed_at, old_value, new_value FROM listing_change
WHERE listing_id = $1 AND field = 'status' ORDER BY observed_at;
```

### 5.4 Semantic layer

```sql
CREATE TABLE model (
  id smallint PRIMARY KEY, name text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('embedding','llm','reranker')), dimensions smallint
);

CREATE TABLE chunk (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  course_id      bigint NOT NULL REFERENCES course(id) ON DELETE CASCADE,
  ord            smallint NOT NULL DEFAULT 0,
  context_prefix text,
  text           text NOT NULL,
  token_count    smallint NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(context_prefix,'') || ' ' || text)
  ) STORED,
  UNIQUE (course_id, ord)
);
CREATE INDEX chunk_tsv_idx ON chunk USING gin (tsv);

CREATE TABLE chunk_embedding (
  chunk_id  bigint NOT NULL REFERENCES chunk(id) ON DELETE CASCADE,
  model_id  smallint NOT NULL REFERENCES model(id),
  embedding halfvec NOT NULL,          -- unsized, deliberately
  PRIMARY KEY (chunk_id, model_id)
);
-- NO vector index. ADR-004. ~870 rows, ~1.7 MB, exact scan is sub-millisecond.
```

**Chunks hang off `course` only.** Listings carry no free text worth embedding — every fact on them
is a typed column and belongs to `filter_listings`. At ~180 words a description is already
chunk-sized; `ord` exists for the day that stops being true (§17.4).

**`model_id` in the primary key.** Multiple embedding models coexist per chunk; A/B becomes
`WHERE model_id = 2` instead of a destructive reindex. Cost: one smallint. Benefit: §11.5 exists.

**`halfvec`, unsized.** `vector` indexes to 2,000 dims with HNSW; `halfvec` to 4,000, and
`text-embedding-3-large` at 3,072 isn't indexable as `vector` at all. Unsized lets models of
different dimensionality coexist. If an index were ever needed (it isn't), the documented pattern is
a partial expression index per model.

### 5.5 Extraction, chat, eval, feedback

```sql
CREATE TABLE extraction (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_page_id uuid NOT NULL REFERENCES cecc_course_index_course_listing(id) ON DELETE CASCADE,
  crawl_run_id   bigint REFERENCES crawl_run(id),
  -- one whole-page attempt per row (the single ExtractedCourse schema, §9.1). Segmented
  -- re-extraction (§5.1) and the field-presence band (§2.1, derivable from page_fields) are
  -- deliberately not stored — reintroduce a `segment`/`field_count` column if/when needed.
  model_id       smallint NOT NULL REFERENCES model(id),
  prompt_version text NOT NULL,
  status         text NOT NULL CHECK (status IN ('ok','schema_error','refused','timeout')),
  raw_json       jsonb, error text,
  input_tokens   integer, output_tokens integer,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chat_message (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL,
  role       text NOT NULL,
  prose      text,
  card_ids   bigint[],          -- listing ids; re-hydrated on replay, never frozen
  filter     jsonb,
  trace_id   text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feedback (
  message_id bigint PRIMARY KEY REFERENCES chat_message(id) ON DELETE CASCADE,
  rating     smallint NOT NULL CHECK (rating IN (-1, 1)),
  note       text,
  promoted_to_eval_item bigint REFERENCES eval_item(id)
);

CREATE TABLE eval_item (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  question        text NOT NULL,
  shape           text NOT NULL CHECK (shape IN
                    ('lookup','filtered','availability','comparative',
                     'eligibility','temporal','unanswerable')),
  expected_filter jsonb,
  expected_ids    bigint[],
  rubric          text,
  reviewed_by     text, reviewed_at timestamptz
);

CREATE TABLE eval_run (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  git_sha text NOT NULL, config jsonb NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);

CREATE TABLE eval_result (
  run_id  bigint NOT NULL REFERENCES eval_run(id) ON DELETE CASCADE,
  item_id bigint NOT NULL REFERENCES eval_item(id),
  actual_filter jsonb, filter_exact boolean,
  retrieved_ids bigint[],
  ndcg_10 real, recall_at_10 real, mrr real,
  prose_faithful boolean, refused boolean,
  latency_ms integer, cost_micros integer,
  PRIMARY KEY (run_id, item_id)
);
```

`card_ids`, not card _contents_. Replaying a three-week-old conversation re-hydrates live status and
fees — the §1 guarantee applies retroactively. `feedback.promoted_to_eval_item` closes the loop: a
thumbs-down becomes a golden-set item becomes a regression test.

---

## 6. Ingest

A durable Effect workflow; each activity checkpoints to the same Postgres, same WAL stream, same
pgBackRest schedule as everything else. Crash at page 340 of 1,083 resumes at 340.

```
openCrawlRun
  → discover → fetch → segment → hash-compare ─┬─ course_hash changed  → extract → embed
  │                                            ├─ listing_hash changed → extract → log Δ
  │                                            └─ neither → stop
  → closeCrawlRun
  → sweep (gated — §6.2)
```

### 6.1 Milestone 1 is a re-crawl

Not "add a crawler" and not "mostly done." The crawler exists and dedupes by URL correctly; it
throws away everything §5.2 needs (§2.2). Milestone 1:

1. **Store `raw_markdown`** and snapshot it by hash (§5.3.3). The blocking gap.
2. **Follow "More offerings like this"** (§5.2.6) — grouping ground truth.
3. Segment each page; hash the halves independently (§5.1).
4. **Start the clock** — `first_seen_at` / `last_seen_at` / `disappeared_at`, `crawl_run`,
   `system_epoch` (§5.3). This is the irreversible one.
5. Conditional requests via `etag` / `http_last_modified`.
6. Re-fetch all 1,083. Politely: rate-limited, `robots.txt` respected, off-hours. It's our own
   institution's site.

**Use `fetch` + a parser, not a browser.** ADR-002.

### 6.2 The sweep gate — the bug that eats your history

The naive version:

```sql
UPDATE listing SET disappeared_at = now()
WHERE last_seen_at < $crawl_started AND disappeared_at IS NULL;
```

Crawl 500s at page 300, or robots.txt changes, or a redirect loop eats half the site — and you have
just declared 700 courses dead. Silently. **Forever, because you cannot re-observe the past.**

So the sweep is gated on a complete, plausible crawl:

```sql
CREATE TABLE crawl_run (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  pages_seen  integer,
  status      text NOT NULL CHECK (status IN ('running','ok','failed','aborted')),
  swept       boolean NOT NULL DEFAULT false
);
```

Sweep only if `status = 'ok'` **and** `pages_seen >= 0.8 × (last successful run)`. Below that,
refuse and alert — a 30% drop in page count is a site problem or a crawler problem, never 300
courses vanishing overnight.

The durable-workflow shape gives this to you for free: `sweep` is an activity that cannot run until
`closeCrawlRun` succeeded. Effect's workflow engine enforces the ordering you would otherwise
enforce with a nervous `if`.

### 6.3 Cost

A full extraction pass is ~1,083 × (1.5k in + 400 out) ≈ **$4** at a Haiku-class price. Embedding
870 chunks is cents. Un-gated nightly re-extraction would be ~$120/month — annoying, not
disqualifying. Retention adds under 100 MB/year, inside the existing pgBackRest schedule.

**So the hash gate is correct but not load-bearing on cost, and this document says so.** It earns
its place on politeness to the origin and on determinism. Claiming a cost constraint that doesn't
exist would be inventing a justification for a component — the exact failure this architecture is
written against.

---

## 7. Retrieval

### 7.1 No vector index

At ~870 chunks the entire vector set is ~1.7 MB. An exact sequential scan with distance computation
completes in well under a millisecond — **faster than HNSW, at 100% recall** — with no build step,
no `ef_search` tuning, no overfiltering hazard, no staleness. ADR-004.

This survived a 3× revision to the chunk estimate without moving, which is what happens when a
decision is written as a threshold instead of a guess.

### 7.2 Hybrid fusion

Vector kNN and BM25 fused by reciprocal rank fusion in one statement — one round trip, one plan, no
application-side merge:

```sql
WITH vec AS (
  SELECT c.course_id,
         row_number() OVER (ORDER BY e.embedding::halfvec(1024) <=> $1::halfvec(1024)) AS rank
  FROM chunk c JOIN chunk_embedding e ON e.chunk_id = c.id AND e.model_id = $2
  ORDER BY e.embedding::halfvec(1024) <=> $1::halfvec(1024) LIMIT 50
),
lex AS (
  SELECT c.course_id, row_number() OVER (ORDER BY ts_rank_cd(c.tsv, q) DESC) AS rank
  FROM chunk c, websearch_to_tsquery('english', $3) q
  WHERE c.tsv @@ q ORDER BY ts_rank_cd(c.tsv, q) DESC LIMIT 50
)
SELECT course_id, sum(1.0 / (60 + rank)) AS rrf
FROM (SELECT * FROM vec UNION ALL SELECT * FROM lex) u
GROUP BY course_id ORDER BY rrf DESC LIMIT $4;
```

`k = 60` is the conventional RRF constant and a knob in §11.5.

> **Iterative scans — recorded, not used.** With an ANN index, filtering applies _after_ the index
> scan: a predicate matching 10% of rows with HNSW's default `ef_search` of 40 yields ~4 usable rows
> — exactly our campus/fee/date shape. A genuine hazard the moment an index is introduced; the only
> reason it doesn't bite v1 is that there's no index to overfilter. If ADR-004 is revisited upward:
> `SET LOCAL hnsw.iterative_scan = 'relaxed_order'` and `hnsw.max_scan_tuples = 20000`.

### 7.3 Contextual retrieval

Before embedding, a cheap model writes a one-sentence situating prefix per chunk — _"Continuing
education course in the Effective School Practices unit on teaching numeracy across content areas,
offered online."_ — stored in `context_prefix` and prepended for both embedding and `tsv`. Under a
dollar for the whole corpus. In the architecture rather than the backlog because it's a clean
single-variable ablation row.

### 7.4 Prerequisite chains

The one place a graph is warranted, and it's fifteen lines:

```sql
WITH RECURSIVE chain AS (
  SELECT requires_id, 1 AS depth FROM course_relation
   WHERE course_id = $1 AND requires_id IS NOT NULL
  UNION
  SELECT r.requires_id, chain.depth + 1
    FROM course_relation r JOIN chain ON r.course_id = chain.requires_id
   WHERE chain.depth < 10 AND r.requires_id IS NOT NULL
)
SELECT c.* FROM chain JOIN course c ON c.id = chain.requires_id ORDER BY depth;
```

The depth guard is not optional; catalog data contains cycles.

---

## 8. Query understanding — the actual bottleneck

**868 short documents are trivially searchable.** Finding "cybersecurity" among them is not hard and
will not be where this fails. The failure mode is misreading _"under $2,000"_, _"evenings"_,
_"before September"_, _"still open"_ — turning intent into a `ListingFilter`.

This inverts the usual RAG priority. Retrieval is nearly free here; **query parsing is the
highest-leverage component in the system**, and it gets its own eval slice with directly labelable
ground truth (`eval_item.expected_filter`) and a headline metric (`filter_exact`, §11.2).

| Utterance                 | Trap                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| "under $2,000"            | `maxFeeCents: 200000`. Off-by-100 is silent and catastrophic.                                           |
| "before September"        | Which year? Relative to now, not to training data. **And it may not be a filter at all** — see below.   |
| "evenings"                | `isEvening: true` — but `is_evening` is NULL wherever it's underivable. NULL must not silently exclude. |
| "still open"              | `status: 'open'` — not a semantic property. Must not leak into `search_catalog`.                        |
| "cheap" / "soon"          | Vague quantifiers. Guess _visibly_ (§10.2) rather than asking or guessing silently.                     |
| "in Newark"               | `campus` — but online courses carry `location_text: 'Online, n/a'`. §17.6.                              |
| "the AI class"            | Ambiguous across four. Disambiguate, don't pick.                                                        |
| "when does it run again?" | **Not a filter.** Routes to `course_history`, and the answer is bounded by `system_epoch` (§5.3.4).     |

**Filters can work against the user.** _"Starting before September"_ usually means _"soon, I'm
desperate"_ — not _"exclude everything after Labor Day."_ Applied silently, it hides the Fall
section of the very course they wanted. §10.2's chips are what make that recoverable: the chip is
both the answer and the correction mechanism.

The router's job on the motivating query is decomposition: hard predicates → `filter_listings`; soft
predicate → `search_catalog` returning `course_id`s; intersect on `course_id`. Both sides are small
enough that the naive plan is fine.

### 8.1 Tools

| Tool              | Params                 | Backing                                                               |
| ----------------- | ---------------------- | --------------------------------------------------------------------- |
| `search_catalog`  | `query, topK?`         | Hybrid RRF over 868 chunks, exact scan                                |
| `filter_listings` | `ListingFilter` (§4.2) | Parameterized SQL; `disappeared_at IS NULL` unless `includeGone`      |
| `get_course`      | `id`                   | Course + live listings + fees + instructors + relations + unit policy |
| `compare_courses` | `ids[]`                | Batched `get_course`                                                  |
| `course_history`  | `id`                   | §5.3.5, **plus its observation window**                               |

`course_history` is a separate tool rather than a fatter `get_course`: history is only wanted when
asked, and the router should pay for it only then. It never returns bare rows — it returns rows _and_
`observing_since` / `terms_observed`, so §10.6 can refuse claims the window can't support.

---

## 9. Extraction

### 9.1 One schema — required core, nullable tail

§2.1's field-presence gradient is the shape of this component. There are no disjoint families to
split on: 995 pages, 144 key-signatures, one template whose optional fields fade out along a
gradient. So extraction is **one prompt against one Effect Schema** — a required core (`status`,
`courseId`, `sectionId`, `session`, fees, `title`) plus nullable optional fields — not three
per-family prompts. A field absent from a page is a legitimate `null`, not a template mismatch.

`courseId` is present on 99% of pages but its values are inconsistent (§2.1); the extractor must
_reproduce and verify_ it, not treat it as ground truth (§9.3).

Input is `raw_markdown` (once §6.1 lands). Output decodes through Effect Schema before touching the
database. A field that fails to parse is a typed failure with a row in `extraction` — never a `null`
that degrades an answer three weeks later.

Extraction owns the derivations retrieval can't do: `total_fee_cents` from `"$ 415"`, `is_evening`
from schedule prose, `delivery_mode` from the description, `status` from `"Course Full"`, campus
normalization, `contact_hours` from the title, `registration_deadline` from a footnote.

It also **writes `listing_change`** (§5.3.2): when a re-extract yields a different value on a watched
field, log the delta before the update.

### 9.2 Known hazards

Each observed in the milestone-0 sample; each silently produces a plausible wrong row.

| Hazard                       | Observed                                                                                            | Handling                                                                                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sentinel nulls               | `Instructor: N/A, -`                                                                                | Map `N/A`, `-`, `n/a`, `TBD`, `None` → NULL per field. Untreated they pass schema validation as strings and poison filters.                                                                                                         |
| Conflicting dates            | `Dates 7/20/2026 - 8/03/2026` **and** prose `Monday, July 20, 2026* - August 3, 2026`               | Structured field wins; prose cross-checks. Disagreement increments a conflict counter and is reported, not silently resolved.                                                                                                       |
| Fee breakdown                | `$ 415 Tuition` / `$ 415 Total Fees`                                                                | Every line to `listing_fee`; `is_total` flags the total. Never parse the first dollar figure and call it the price.                                                                                                                 |
| Entangled campus/format      | `Format: Distance Education: Online e-College`, `Location: Online, n/a`                             | Separate columns, separate derivations. `Online` is a legal campus _and_ a delivery mode; not the same fact.                                                                                                                        |
| Free-text prerequisites      | `Course Prerequisites: None`                                                                        | Store `raw_text` always, resolve best-effort, publish the rate. Don't force the FK.                                                                                                                                                 |
| Derived booleans             | `is_evening`                                                                                        | NULL is a legal answer. A guessed `false` is worse — §8's filter would silently exclude.                                                                                                                                            |
| Status vocabulary            | `Status: Course Full`                                                                               | Enumerate from the data. Unmatched → `unknown` **plus an alert**, never a silent default.                                                                                                                                           |
| **Label/value misalignment** | `Course ID` ⏎ `Section ID  ALT10` ⏎ `289`                                                           | The scrape shifts values by one row. A naive parser yields `Course ID = ""`, `Section ID = "ALT10"`; the truth is `ALT10` / `289`. **Plausibly how the inconsistent `courseId` values arise — verify before trusting them (§9.3).** |
| **Facts inside the title**   | `Alternate Route 45 - Hour Math Across the Curriculum Online Course`                                | `contact_hours = 45`, `track`, `subject`, delivery — all in one string, none in a field.                                                                                                                                            |
| **Rules inside footnotes**   | `*The deadline for online registration is two business days prior…`                                 | → `registration_deadline`. Answers a question `status` cannot. Keep the verbatim rule for display.                                                                                                                                  |
| **Relations inside prose**   | Prereq field says `None`; description says _"can be taken simultaneously with Phase I, II, or III"_ | Extract from **both** sources (§5.2.5). Reading only `prerequisite_text` silently loses three real edges.                                                                                                                           |
| **Async has no time of day** | `Monday, July 20, 2026 - August 3, 2026` — no clock time                                            | `is_evening` NULL. For a large async fraction it is _always_ NULL.                                                                                                                                                                  |
| Compound scalars             | `Location: Online, n/a` · `Format: Distance Education: Online e-College` · `Instructor: N/A, -`     | All `{a}, {b}` or `{a}: {b}`. Split at extraction, keep the verbatim text alongside.                                                                                                                                                |

### 9.3 Correctness — three tiers, ascending cost

1. **Cheap machine check — `courseId` consistency across the corpus.** `courseId` is on 987/995
   pages, but §9.2's misalignment hazard and heterogeneous values mean it is a field to _validate_,
   not a free answer key. **Profile it first:**
   ```sql
   SELECT page_fields->>'courseId' AS code, count(*)
   FROM cecc_course_index_course_listing
   WHERE page_fields ? 'courseId' GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
   ```
   Consistent alphanumeric patterns → usable cross-checks. Free-text noise (`Polestar`,
   `RagoneAUDprep`) → tier 3 is the floor for that field. _Reproducing a wrong value is worse than
   emitting `null`._
2. **Cheap — `extraction.status` over the full corpus.** Error rate and per-field null rate against a
   rolling baseline. Free, continuous, catches template drift.
3. **Expensive — 30 hand labels, stratified by field-presence.** Not uniform and not by family:
   sample across the §2.1 key-count bands so rare fields like `audience` (13%) and `instructorBio`
   (13%) are actually represented — uniform sampling draws ~4 of them and never sees their failure
   modes.

Publish per-field precision and recall **per field**. If F1 on `total_fee_cents` is 0.7, no
retrieval tuning downstream saves the answer.

---

## 10. The chat surface

This is the product. §5–§9 exist to make it possible.

### 10.1 Cards, not paragraphs

A course result is a structured object, hydrated server-side from `listing` + `listing_fee` +
`course` + `unit`:

```
┌──────────────────────────────────────────────────────┐
│ Alternate Route: Math Across the Curriculum   ALT10  │
│ Effective School Practices · 45 hours · online, async│
│                                                      │
│ Summer 2026 · Jul 20 – Aug 3 · $415                  │
│ ● Course full                     checked 3h ago     │
│                                                      │
│ “Asynchronous — can run alongside Phase I–III.”      │
│                                                      │
│ Register: search keyword “Alternate Route”           │
│ Deadline: Jul 16 (2 business days before start)      │
│                              [ View details → ]      │
└──────────────────────────────────────────────────────┘
```

Everything except the quoted line comes from Postgres — `contact_hours` from the title,
`registration_deadline` from a footnote, `delivery_mode` from description prose, the fee from
`listing_fee`. The quoted line is `CardRef.why`, the only model-authored text in the card, and it is
measured (§11.2), not trusted.

**The button says "View details", not "Register".** When `registration_url IS NULL` — which the
sample page suggests is common — the card shows the real path: the keyword to search. Inventing a
register button would be the UI fabricating an affordance the catalog doesn't offer, undoing ADR-008
one layer above where it's enforced.

`registration_deadline` is on the card because _"is it too late?"_ is distinct from _"is it full?"_ —
and on `ALT10` the answer is that it was too late four days before the course filled up.

Unit-scoped answers get their own card shape. _"What's the refund policy?"_ resolves through
`course.unit_id → unit.refund_policy`, with `course.refund_policy_override` rendered as an amendment
when present — as on `ALT10`, where Summer Math sessions carry a stricter 14-day rule than the unit's
standard 10-day one. Ten unit rows, not 1,083 duplicated policies (§5.2.1).

### 10.2 Filter chips — the model's reading, made correctable

When the router produces a `ListingFilter`, echo it as editable chips:

```
Newark ×    under $2,000 ×    evenings ×    starts before Sep 1 2026 ×
```

The single best affordance a catalog chat can have. It makes the model's interpretation visible,
turns §8's failure mode from a silent wrong answer into a one-click correction, and gives users a
faceted-search surface they never had to learn. Clicking a chip re-runs the query without an LLM
call.

It is also the antidote to §8's _"filters can work against the user"_ problem. When she drops
`starts before Sep 1` and the Fall section of the course she wanted appears with nine seats, the chip
is what made that discoverable.

### 10.3 Zero results is a design case

The strongest argument for typed filters over embeddings: **you know which predicate killed it.**

> No evening Newark courses under $2,000 starting before September.
> Closest matches — drop one?
> · **under $2,000** → 3 results ($2,400–$3,100)
> · **evenings** → 5 results
> · **before September** → 2 results (both start Sept 14)

A vector search returns its nearest neighbors and says nothing about why. A `WHERE` clause relaxes
one predicate at a time and counts. N+1 count queries — trivial at this scale — and it converts the
worst moment in a search UI into the most useful one.

### 10.4 Freshness is a UI element

`status` churns; a chat that says "open" about a full course is the worst failure this system can
produce. Therefore:

- `status` and fees are read at **render** time, never from the message row (§5.5).
- Every card shows `last_hash_comparison_at` as _"checked 3h ago"_.
- Stale beyond a threshold → the card says so and links out rather than asserting.

Precisely what the §1.1 baseline cannot do — its facts are frozen in a prompt at build time.

### 10.5 Two surfaces, honestly ranked

**Primary — Astro + effect-atom.** Cards, chips, zero-result relaxation, freshness, history, feedback
buttons, streaming prose. The product and the demo.

**Secondary — OpenAI-compatible `/v1/chat/completions`, SSE.** Drops Open WebUI in as another quadlet
with zero UI code, and lets anyone point LibreChat or `curl` at the catalog. ~100 lines. But **it
cannot render cards** — it degrades to a markdown table, forfeiting the §1 guarantee's _presentation_
even though the data is still hydrated. An interop and dogfooding surface, not the product.

Transport: prose streams as text deltas; cards arrive as discrete typed SSE events once `hydrate.ts`
resolves them.

```
event: filter   data: {"campus":"Newark","maxFeeCents":200000,"isEvening":true}
event: prose    data: {"delta":"Three sections match — "}
event: card     data: {"listingId":4471,"title":"…","status":"open","totalFee":"$415", …}
event: window   data: {"observingSince":"2026-07-16","termsObserved":1}
event: done     data: {"traceId":"…","costMicros":812}
```

### 10.6 Grounded refusal, and the observation window

Claims that can't be grounded aren't made. _"That isn't in the catalog"_ is a correct answer,
measured on the `unanswerable` slice (§11.1). Out-of-scope, non-existent courses, and ambiguity all
land here.

**History has its own refusal, and it's the subtle one.** Seeing one summer section is not evidence a
course runs every summer. With `terms_observed = 1` the correct answer to _"does this run every
year?"_ is:

> I've only been watching this catalog since July 2026, so I can't tell you whether it runs every
> spring — I've seen one term.

That is the `temporal` eval shape (§11.1). It has a correct answer, and at `n=1` the correct answer
is "I don't know yet." A system that pattern-matches one sighting into a schedule is worse than one
that says nothing.

---

## 11. Evaluation

Built at milestone 4 of 9 — **before** the chat UI. A system you can't measure can't be tuned, and
building the harness fourth rather than last is itself the engineering signal.

### 11.1 Golden set

150–200 items, generated from the catalog and human-reviewed, stratified by **field-presence band**
(§2.1) as well as shape:

| Shape          | Share | Example                                                        |
| -------------- | ----- | -------------------------------------------------------------- |
| `lookup`       | 25%   | "How many hours is the Alternate Route math course?"           |
| `filtered`     | 30%   | The motivating query (§1)                                      |
| `availability` | 10%   | "What's still open for summer?"                                |
| `comparative`  | 10%   | "Difference between the Newark and NB data analytics certs?"   |
| `eligibility`  | 5%    | "Can I take this while doing Phase II?"                        |
| `temporal`     | 5%    | "When does ALT10 run again?" / "Has it gotten more expensive?" |
| `unanswerable` | 15%   | "Do you offer a PhD in astrophysics?" / "the AI class"         |

The `unanswerable` slice is not padding (§10.6). Neither is `temporal` — at `terms_observed = 1`
most of its items have _"I don't know yet"_ as the correct answer, which makes it the sharpest test
of whether the system knows the edge of its own knowledge. Its expected answers change as the
window grows; that's intended, and `eval_run.config` records `terms_observed` so old runs remain
interpretable.

### 11.2 Metrics

**`filter_exact` is the headline.** Given a natural-language query, did the router produce the
correct `ListingFilter`? Directly labelable, cheap, and — per §8 — the thing that actually breaks.
Report it first; report per-field near-misses (`maxFeeCents` off by 100×) separately, because
they're silent and catastrophic.

- **Retrieval:** recall@10, nDCG@10, MRR. Valid here — 10 of 868 is ~1%.
- **Facts:** _not measured._ Guaranteed by construction (§1). The eval asserts the guarantee holds
  (no numeric literal in `Answer.cards`) as a **test**, not a score.
- **Prose:** `prose_faithful` — binary, judged. Narrow surface: connective tissue and `CardRef.why`.
- **Refusal:** accuracy on `unanswerable` **and** `temporal`. Both false answers and false refusals.
- **Freshness:** max staleness of a served card. §10.4 is a claim; this is its number.
- **Operational:** p50/p95, cost per query.

### 11.3 Runner

`Effect.forEach(items, { concurrency: 5 })` over `Agent.answer` → `eval_run` / `eval_result`.
`eval_run.config` captures the ablation knobs as jsonb so any two runs diff. An `LlmJudge` service
scores prose with a frontier model regardless of what serves production. Same OTel spans as
production, so a bad eval item debugs with the same tooling as a bad answer.

### 11.4 CI gate

A PR that drops `filter_exact` or nDCG@10 by more than 2 points against `main` fails. Retrieval
quality becomes a build artifact.

### 11.5 The ablation table

The README centerpiece. **Broken out by query shape** — a single aggregate hides the entire finding.

| Config                                         | filter_exact               | nDCG (lookup) | nDCG (filtered) | Refusal | Fresh | Memory         | p95 | $/q |
| ---------------------------------------------- | -------------------------- | ------------- | --------------- | ------- | ----- | -------------- | --- | --- |
| naive chunks, vector only                      |                            |               |                 |         |       | —              |     |     |
| + contextual prefixes                          |                            |               |                 |         |       | —              |     |     |
| + hybrid RRF                                   |                            |               |                 |         |       | —              |     |     |
| + reranker                                     |                            |               |                 |         |       | —              |     |     |
| + typed filter routing                         |                            |               |                 |         |       | —              |     |     |
| + retention & history                          |                            |               |                 |         |       | ✓              |     |     |
| **baseline: compact index (~54k tok, cached)** |                            |               |                 |         |       | **impossible** |     |     |
| baseline: whole catalog in context             | _does not fit — ~870k tok_ |               |                 |         |       |                |     |     |

Plus the **ADR-004 crossover curve**: exact / HNSW / DiskANN across synthetic corpora from 10³ to
10⁶ chunks. Cheap, and it converts "I didn't need an index" from an excuse into a finding.

The prediction from §1.1 is explicit: the compact-index baseline is competitive or better on
`lookup` and `comparative`, and loses on `filtered`, freshness, and factual guarantee — and cannot
compete at all on `temporal`, because last fall's catalog isn't on the web to put in a prompt. If
that holds, those columns are the result. **If it doesn't hold, that is a more interesting result
and it gets published too.**

### 11.6 Reranking

`bge-reranker-v2-m3` behind the `Reranker` port, cross-encoding the query against the top ~50 fused
candidates. Largest latency line item in the request path. Stays only if §11.5 shows it buys enough
nDCG to justify its p95. The port exists so that answer is swappable and "we removed it" is a
one-line change.

---

## 12. Observability

OpenTelemetry throughout; Effect emits spans natively.

- One trace per request: router → filter parse → each tool → SQL → embed → rerank → generate →
  hydrate.
- Token counts and cost as span attributes; `cost_micros` rolled up per request.
- `chat_message.trace_id` links any answer to its trace. A thumbs-down is one click from the exact
  retrieval that caused it.
- OTLP → collector → Tempo/Jaeger; metrics → Prometheus.
- **Crawl health is a first-class dashboard**, not a log: `crawl_run.pages_seen` over time, sweep
  gate trips, `disappeared_at` rate per run. A sweep that would have marked 300 courses gone is the
  alert you most want and least expect (§6.2).
- **Business metrics:** filter-parse failure rate, zero-result rate, chip-edit rate (users
  correcting the model — the best available production proxy for §8 quality), card click-through.

---

## 13. Deployment

Rootless Podman + Quadlet, extending the existing stack. One podman network.

| Unit                                | Role                                                |
| ----------------------------------- | --------------------------------------------------- |
| `postgres-db.container`             | existing — pgvector, pgvectorscale, pgBackRest → S3 |
| `pgbouncer.container`               | existing — `:6432`, transaction mode                |
| `catalog-api.container`             | Effect HttpApi + SSE chat + compat endpoint         |
| `catalog-migrate.service`           | oneshot, direct `:5432`, before api                 |
| `catalog-ingest.service` + `.timer` | nightly; full re-crawl weekly; sweep gated (§6.2)   |
| `reranker.container`                | bge-reranker-v2-m3                                  |
| `catalog-web.container`             | Astro                                               |
| `open-webui.container`              | secondary surface (§10.5)                           |
| `otel-collector.container`          | OTLP ingest                                         |

No `lightpanda.container` — ADR-002.

Config via `Config.redacted` from env files under `secrets/`, never baked into images. Two connection
strings, always: `POSTGRES_URL` (`:6432`) and `POSTGRES_ADMIN_URL` (`:5432`). The existing
`postgres-backup-full.timer` already captures every table in this document — including the temporal
layer, which is the only irreplaceable data in the system. No new backup story; a materially higher
stake in the existing one (§14).

---

## 14. Failure modes

| Failure                                       | Detection                                                                       | Response                                                                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sweep marks 300 live courses as gone**      | `crawl_run` gate; `disappeared_at` rate per run                                 | §6.2 — sweep requires `status='ok'` and `pages_seen ≥ 0.8×` the last good run. **Unrecoverable if it happens: you cannot re-observe the past.** The gate is the whole mitigation.                        |
| **Backup loss**                               | pgBackRest verify                                                               | Everywhere else, recoverable by re-crawling. The temporal layer is _not_ — it is the only copy of a catalog that no longer exists. Restore drills matter more here than the rest of the schema combined. |
| Card shows "open" for a full course           | Freshness metric; user reports                                                  | §10.4 — status read at render, staleness shown. The worst live failure this system can produce.                                                                                                          |
| Router misparses "$2,000" as 2000 cents       | `filter_exact`, per-field near-miss                                             | §11.2 headline metric. Silent otherwise.                                                                                                                                                                 |
| System implies a schedule from one sighting   | `temporal` eval slice                                                           | §10.6 — `system_epoch` bounds the claim. At `n=1`, "I don't know yet" is the correct answer.                                                                                                             |
| Page template changes; extraction degrades    | `extraction.status` error rate; per-field null rate vs. 7-day baseline          | Alert. Versioned by `prompt_version` — re-run against `page_snapshot`, no re-crawl (§5.3.3).                                                                                                             |
| A new field or key-signature appears          | Distinct `page_fields` key-set count vs. baseline (§2.1); unrecognized-key rate | Alert. The core+tail schema absorbs new optional fields as `null`; a genuinely new required field surfaces here, not silently.                                                                           |
| Embedding provider outage mid-ingest          | Workflow activity failure                                                       | Durable workflow resumes at the failed batch; no double-billing.                                                                                                                                         |
| PgBouncer stale prepared statement            | `prepared statement "S_1" already exists`                                       | Structurally impossible — `prepare: false`, `fetch_types: false`. If seen, the adapter regressed.                                                                                                        |
| Effect v4 beta breaks an import               | Build failure                                                                   | Contained to `src/adapters/`. Pinned betas mean it happens on our schedule.                                                                                                                              |
| Reranker OOM                                  | Health check                                                                    | `Reranker` port degrades to identity; fused order passes through. Quality drops, service stays up.                                                                                                       |
| Retrieval regression from a "harmless" change | CI eval gate                                                                    | PR blocked.                                                                                                                                                                                              |
| Model invents a course                        | `unanswerable` slice; hydration fails on a bogus `listingId`                    | A hallucinated ID doesn't hydrate — it errors. §1 catches this class structurally.                                                                                                                       |
| Crawl hammers the origin                      | Rate-limiter metrics                                                            | Bounded concurrency, conditional requests, off-hours, robots.txt. It's our own institution.                                                                                                              |

---

## 15. Decision record

**ADR-001 — Effect v4 beta over v3.**
V4 is beta and the team recommends v3 for production; v4 becomes LTS at stability. But v3 is
feature-frozen — new features are v4-only — so starting on v3 in July 2026 is starting on a dead
end. This system has no SLA. _Accepted:_ pin exact betas, contain churn in `src/adapters/`, budget
for import renames. _Reject if_ this becomes a production service on a deadline.

**ADR-002 — `fetch`, not a headless browser.**
Lightpanda is well-shaped for DOM-extraction workloads and now ships robots.txt, markdown output,
network interception, and MCP. But its argument — startup and memory amortized across a large fleet
of page loads — needs volume, and milestone 0 says there is none: 1,083 conditional GETs finish in
under a minute either way, and the pages are static. _Accepted:_ `fetch` + a parser. Benchmark once
in milestone 1 and publish the number; expect the boring answer. Lightpanda re-enters only if
discovery needs JS-driven pagination. _An unjustified browser is a liability, not a credential._

**ADR-003 — Postgres only; no vector database.**
Vectors live in the same heap as application data, so a filtered similarity search is one query
rather than two round trips across two services. Dedicated engines win above ~500M vectors; we have
~870 — six orders of magnitude short. The absence of a second datastore is the design.

**ADR-004 — Exact sequential scan. No vector index.**
~870 chunks ≈ 1.7 MB of `halfvec(1024)`. Exact scan is sub-millisecond at 100% recall, with no build
step, no `ef_search`, no overfiltering hazard, no staleness. HNSW is slower _and_ worse here.
DiskANN — whose case is storage pressure and ~9× compression at scale — is off by orders of
magnitude. _Still run the sweep_ (§11.5) and publish the crossover curve. _"I measured it and chose
the boring option, and here's the size at which that stops being true"_ is the strongest sentence in
this document.

**ADR-005 — Typed filter tool over free-form text-to-SQL.**
Text-to-SQL is the flashier demo and the worse engineering: injection surface, hallucinated columns,
unbounded scans, no compile-time contract. `ListingFilter` (§4.2) covers the queries that matter
_and_ round-trips to the UI as editable chips (§10.2) — an affordance free-form SQL can't offer.
Free SQL stays as a gated fallback, evaluated separately with its error rate published.

**ADR-006 — Policies are unit-scoped, not page-scoped.**
Rev 1 argued from one rendered page that >50% of each page is byte-identical boilerplate and that a
hash-deduplicated `policy` table was a correctness precondition. Measurement refuted it —
`description ILIKE '%full refund will be issued for written cancellations%'` returns **0**, because
`description` is not the page — and rev 4 deferred the idea entirely. Close reading gives the right
answer, which is neither: **policies attach to the ~10 CECC units** (§5.2.1), with per-course
amendments (`refund_policy_override`). Ten rows, no hashing, no dedup machinery, and _"what's the
refund policy?"_ becomes a foreign key rather than a retrieval problem. _The chunk-dedup framing was
solving a problem that didn't exist. The entity was always a unit._

**ADR-007 — The course/listing split survives on lifetimes and identity, not dedup.**
Rev 1 justified it with a 3–5× deduplication that measurement put at **1.25×**. The
embedding-economics argument is worth ~20% and cannot carry the design. _Accepted anyway,_ on three
legs that don't depend on the ratio: two lifetimes on one page (§5.1 segmented hashing); identity is
given, not inferred (§5.2.6, `external_course_id` + the grouping link); and term-over-term history
(§5.3), where the same course recurs at a new URL and fused rows make _"has this gotten more
expensive?"_ unanswerable. Worst case one join is redundant — a cheap premium. _It should not be sold
as a collapse it isn't._

**ADR-008 — Facts bypass the model.**
The `Answer` schema (§4.2) has no factual fields. Cards hydrate from Postgres. This trades
expressiveness — the model cannot say _"it's $415"_ in prose without that being a measured drift risk
— for a structural guarantee on the fields users act on. For a transactional catalog surface where a
wrong price or seat status is the worst possible output, that trade is obviously correct. _The
guarantee is scoped and stated as such: cards guaranteed, prose measured._

**ADR-009 — Eval harness before chat UI.**
Milestone 4 of 9. Non-negotiable ordering.

**ADR-010 — Parse the page, don't just read its fields.**
Rev 5's schema mirrored the page's visible labels. Close reading shows the labels are the _least_ of
it: `contact_hours` lives inside the title, `registration_deadline` inside an asterisk footnote,
`delivery_mode`'s sync/async distinction inside description prose, and three real course relations
inside a sentence while the Prerequisites field says `None`. A schema built from the field list alone
loses every one, silently. _Accepted:_ extraction reads title, fields, footnotes, and prose as four
distinct sources; §5.2 has a column for each fact regardless of where it hid. _Consequence:_ the
prompt is longer (one schema, required core + nullable tail, §9.1), and §9.2 grew from 7 hazards to
13. Cheaper than discovering
at milestone 6 that nobody can ask _"how many hours is it?"_

**ADR-011 — Observation-time retention. Not bitemporal, not SCD-2.**
Three distinct decisions, recorded together because they're one design.

_Retention over deletion._ The catalog publishes only what's current; last fall's prices are gone
from the web forever. A crawler that overwrites destroys the only copy that will ever exist.
`first_seen_at` / `last_seen_at` / `disappeared_at` on `listing`, plus `page_snapshot` keyed by hash.
Under 100 MB/year, ~a day of work, and **the only thing in this document with a deadline that money
can't buy back** — history accrues forward and cannot be backfilled.

_Observation time only — not bitemporal._ We know when we **saw** a price change, bounded by the
crawl interval. When it **actually** changed is unknowable. Calling this bitemporal would claim a
precision the data can't support. It is a slowly-changing dimension with observation-bounded
validity, and saying so precisely is worth more than the fancier word. `system_epoch` (§5.3.4) makes
the window a queryable fact so §10.6 can refuse claims it can't support.

_A change log, not row versions._ SCD-2 on `listing` would emit thousands of near-identical rows
recording `full → open → full`. `listing_change` stores field-level deltas on a whitelist instead —
low thousands of rows a year, and it answers _"when did 289 fill up?"_ directly.

_The gate is the feature._ An ungated sweep after a partial crawl silently declares hundreds of
courses dead, unrecoverably (§6.2). `crawl_run` + the 80% threshold is not defensive
programming — it is what makes retention trustworthy enough to build on.

---

## 16. Roadmap

| # | Milestone    | Exit criterion                                                                                                                                                                                                                                                                                                        |
| - | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 | Count        | ✅ **Done.** M0 est. 1,083 listings; M1 re-crawl measured 995 / 732 courses (1.36×), ~870 chunks, one template on a field-presence gradient (§2.1 — supersedes the earlier three-families claim), ~$4/pass. Killed the dedup and boilerplate theses; confirmed ADR-004 under a 3× estimate revision.                  |
| 1 | **Re-crawl** | 🔴 **Blocking, and the clock starts here.** `raw_markdown` + `page_snapshot`, grouping link followed, segmented hashes, `crawl_run` + gated sweep, retention columns, `system_epoch`. All ~1,000 re-fetched politely (995 measured). `fetch` vs. browser benchmarked once. Zero AI.                                   |
| 2 | Extract      | `unit`/`course`/`listing`/`listing_fee`/`listing_instructor`/`course_relation`, one schema, required core + nullable tail (§9.1). All 13 §9.2 hazards tested. `listing_change` written on watched fields. `courseId` **verified first** (§9.3), then 30 hand labels stratified by field-presence band. Per-field P/R. |
| 3 | Retrieve     | Hybrid RRF + `filter_listings` behind `/search`. No generation.                                                                                                                                                                                                                                                       |
| 4 | **Evaluate** | Golden set + runner + CI gate green. `filter_exact` reporting.                                                                                                                                                                                                                                                        |
| 5 | Answer       | Router, `Answer` schema, hydration, streaming, grounded refusal. **Assert no factual field ever leaves the model.** Baseline eval recorded.                                                                                                                                                                           |
| 6 | Surface      | Astro: cards, chips, zero-result relaxation, freshness, feedback → eval promotion. Open WebUI secondary.                                                                                                                                                                                                              |
| 7 | History      | `course_history` tool, observation-window honesty (§10.6), `temporal` eval slice. _Queryable — the data has been accruing since M1._                                                                                                                                                                                  |
| 8 | Ablate       | Every §11.5 row by shape, both baselines, ADR-004 crossover curve.                                                                                                                                                                                                                                                    |
| 9 | Ship         | Traces, ADRs, README with the ablation table, 3-minute demo.                                                                                                                                                                                                                                                          |

**The M1/M7 split is the point.** Recording is urgent; querying is not. The retention columns cost a
day and must land in milestone 1, because every crawl that runs without them destroys data
permanently. The `course_history` tool can wait until milestone 7 — by then it will have something to
say. Defer _recording_ to v2 and the clock starts a year later, and no amount of engineering buys
back the terms you didn't watch.

---

## 17. Open questions

1. **Does "More offerings like this" resolve to a course-grouping page?** §5.2.6 assumes it lists
   sibling sections. If it does, `course` identity is given and the title heuristic dies. If it's a
   fuzzy recommender ("you might also like"), it's useless for grouping and `external_course_id`
   carries identity alone — with `title_normalized` covering the ~8 rows with no `courseId` and any
   with unusable free-text values (§2.1). Open one page and look; a two-minute answer that decides
   §5.2.2's key strategy.

2. **~~Do template families track `cecc_unit`?~~ Resolved — there are no families.** Measured against
   the 995-page re-crawl: `course_data` is empty on every row, `page_fields` shows one template on a
   field-presence gradient (144 key-signatures, §2.1), and `cecc_unit` / `root_url` are **null on
   every row** — the flat `searchResults.cfm` index never carried them. Extraction is therefore one
   schema (§9.1), and there is no unit-to-template lookup to build. Remaining sub-question: should the
   crawl _backfill_ `cecc_unit` from each page so retrieval can facet by unit? Cheap if the label is
   on the page; deferred to Phase 2.

3. **Confirm `description` is prose-only.** Settles §2.2's blocking claim before anyone writes crawler
   code.
   ```sql
   SELECT round(avg(length(description)))::int AS avg_chars,
          min(length(description)), max(length(description)),
          count(*) FILTER (WHERE description ILIKE '%refund%')     AS refund,
          count(*) FILTER (WHERE description ILIKE '%Total Fees%') AS fees,
          count(*) FILTER (WHERE description ILIKE '%Section ID%') AS section_id
   FROM cecc_course_index_course_listing;
   ```
   ~1,000 chars + three zeros → confirmed, milestone 1 is a re-crawl. ~5,000 chars → the page _is_
   stored, the ILIKE was wrong, and both ADR-006 and milestone 1 need revisiting.

4. **Chunking unit.** A description is ~180 words — already chunk-sized. Chunking is probably a no-op.
   Ablate rather than assume; a negative result is still a row.

5. **How much history has the existing crawler already thrown away?** The crawler has been running —
   `created_at`, `updated_at`, `last_hash_comparison_at` are populated. This is the argument for doing
   §5.3 at milestone 1 instead of v2, and it'll be more persuasive than anything in ADR-011.
   ```sql
   SELECT min(created_at), max(created_at),
          count(*) FILTER (WHERE updated_at > created_at + interval '1 day') AS changed_since_first_seen,
          count(DISTINCT date_trunc('month', created_at)) AS months_observed
   FROM cecc_course_index_course_listing;
   ```
   If `created_at` spans months, every one of those `changed_since_first_seen` rows is a fact that was
   observed and overwritten. That number is what §5.3 exists to stop growing.

6. **Is an online course "in Newark"?** §8's campus hazard. Decide, document, test.

7. **Are unit policies uniform within a unit?** §5.2.1 assumes one refund policy per unit plus
   per-course overrides. If they vary by _program_, `unit` gains a level. Answerable from
   `raw_markdown` once §6.1 lands: group extracted policy text by `cecc_unit`, count distinct hashes.
   One per unit → the model is right.

8. **Does the compact-index baseline just win?** Live possibility (§1.1), and §11.5 is built to find
   out. If it wins on `lookup` and `comparative` and loses only on `filtered`, freshness, factual
   guarantee, and `temporal` — the honest project is _typed extraction + a filter tool + retention +
   a measured crossover_, with the retrieval stack documented as **measured and scoped, not
   assumed.** A stronger artifact than a system that exists to justify its own diagram. Decide on the
   numbers at milestone 8.

9. **Semantic caching.** Cheap; moves the `$/q` column. After §11.5 exists.

10. **Local vs. hosted generation.** With retrieval this precise and facts bypassing the model
    entirely (§1), an 8B model may be sufficient — its job is row selection and one line of prose.
    Behind the `Answerer` port either way; the table decides.

11. **Publication.** Extracted facts + links only; prose stays at the source. Confirm the position
    before anything is public.
