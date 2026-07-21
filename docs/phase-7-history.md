# The Temporal Layer — Phase 7 Results

**Milestone M7 · Almanac (CECC Course Catalog RAG) · run 2026-07-21 against the live 736-course / 993-section corpus**

> The catalog has no memory — this system is the only place one will ever exist. So the one thing it must never do is _fake_ one. Phase 7 makes the system answer temporal questions, and the whole engineering problem is honesty: at one term of observation, the correct answer to "does it run every year?" is **"I don't know yet"**, and a system that pattern-matches a single sighting into a schedule is worse than one that says nothing.

| Capability              | Result                                   | What it means                                                                                                                        |
| ----------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **`course_history`**    | per-term rollup + change log + window    | The §5.3.5 queries over **live + disappeared** listings — the past is reported, never hidden by a `WHERE`                            |
| **Honesty verdict**     | a **pure, deterministic** function       | §10.6 ("I've only seen it once") is derived from data, not written by the model — so a recurrence pattern **cannot** be hallucinated |
| **Router**              | temporal → history, **not refuse**       | A temporal question about a real course now routes to `course_history` (the Phase-4 refusal was a stopgap)                           |
| **Synthetic history**   | a deterministic **test double**, guarded | Turns the n=1 corpus multi-term so the _positive_ branch is testable — test/scratch DBs only, never the real catalog                 |
| **Both branches, live** | grounded + honest, on real data          | Verified on the running corpus and, for multi-year recurrence, on a synthetic scratch DB                                             |
| **CI gate**             | green, **unchanged**                     | Temporal is scored (routing + honesty) but non-gating; the §11.4 headline metrics are untouched                                      |

Scope: **140 tests green** (`tsc` · `lint` · `dprint` · `vitest`), +20 for Phase 7; the honesty logic and the synthetic-history generator are pure and unit-tested with **no database and no vendor call**; the SQL rollup and the loader are proven against a testcontainer.

---

## 1. Why history is the M7 deliverable — and why n=1 makes it hard

The temporal layer (§5.3) is the one capability this system has that a bigger context window can never buy: last summer's catalog isn't on the web to paste into a prompt. Phase 1 started the clock — retention columns, `system_epoch`, snapshots — because **it cannot be backfilled** and every crawl without it destroys data permanently. Phase 7 is where that recorded history becomes a question you can ask.

The subtlety is that **most of "history" already works and the interesting part barely exists yet.** Different terms are different sections at different URLs, so "what terms is this offered in?" is a `GROUP BY` over rows that are already there. What's genuinely missing is _time_: a single crawl is **one observation**. Seeing a summer section once is not evidence it runs every summer. The failure mode isn't a wrong number — it's a **confident false pattern**, and it is exactly the thing §10.6 exists to forbid. So the M7 deliverable is not "a history endpoint." It is **an honesty guarantee with a tool attached.**

---

## 2. `course_history` — the tool

One tool, `course_history(courseId)`, returns three things that always travel together (§8.1):

- **The per-term rollup** (§5.3.5 q1&2) — one row per observed term: sections, min/max total fee, the set of statuses seen, and whether any section of that term is **still listed**. It groups over **every** listing of the course, `disappeared_at` or not — because "has it gotten more expensive?" is only answerable across terms that have _fallen off the site_. The live-vs-history distinction is a `stillListed` flag per term, never a filter that hides the past.
- **The change log** (§5.3.5 q3) — the watched-field deltas (status flips, fee changes) with the time each was observed. The narrow log of §5.3.2, not row versions.
- **The evidence count + the window** — `termsSeen` (distinct _dated_ terms this course appears in) alongside the global observation window (`observing_since` / `terms_observed`). These are the two facts §10.6 refuses a claim against.

Like `Card`, the result is a plain server-built row read from Postgres — **never decoded from model output.** Every fact here is a database fact.

---

## 3. The honesty logic — deterministic, and that is the point

**The prose is not written by the model.** The answer to a temporal question is composed by a **pure function** of `(CourseHistory, ObservationWindow)` — `composeHistory` — with three verdicts:

| Verdict            | Condition         | The answer                                                                                                                                          |
| ------------------ | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`insufficient`** | `termsSeen ≤ 1`   | _"I've only seen it once — it's listed for Fall 2026. I've only been watching since July 2026, so I can't yet tell you whether it runs regularly."_ |
| **`grounded`**     | `termsSeen ≥ 2`   | Reports the observed terms + the fee trajectory, **bounded to the window** — never an absolute like "every year", only the terms actually seen      |
| **`not_found`**    | course unresolved | _"I couldn't find a course matching that in the catalog."_                                                                                          |

Two design choices carry the guarantee:

1. **Per-course evidence, not a global flag.** A course first seen this term is `termsSeen = 1` and gets the honest answer **even in a database that holds years of other history.** The refusal is about _this course's_ evidence, so it survives inside a rich corpus.
2. **The model only routes.** It identifies that the question is temporal and which course it names; it authors **none** of the facts and **none** of the hedge. This is ADR-008 taken to its conclusion — the same reason card facts are hydrated from Postgres rather than emitted by the model. A recurrence claim can't be hallucinated from thin data because **no model ever writes the recurrence claim.**

The payoff: the exit criterion — _"'does this run every year?' answers 'I don't know yet' at n=1"_ — is a **unit test**, not a vibe check. `composeHistory` is total and pure; both branches are asserted directly.

---

## 4. The router flip — temporal is answerable now

In Phase 4, a temporal question was a **refusal** — there was no history tool, so "when does the LSAT prep run again?" landed in the same bucket as "a PhD in astrophysics." Phase 7 flips it. The router (`router-v4`) grows a third, mutually-exclusive route, `historyQuery`: a temporal question about a real course routes there, and **only** an out-of-scope temporal question ("when will you offer a PhD again?") still refuses. The agent resolves the named course by search, calls `course_history`, and composes the honesty-bounded answer; a live current-offering card rides along, its facts hydrated live like any other card.

This is why the `temporal` eval slice was rebuilt (see §7): its correct answer is no longer "refuse" — it is "route to history and answer honestly."

---

## 5. Synthetic history — the clever test double

Here is the problem the honesty guarantee creates for itself: **the real corpus is n=1**, so at the time of writing, the _positive_ branch — the one that reports a real multi-year history and a fee trajectory — has almost nothing to exercise. You cannot test "seen in Fall '24/'25/'26, fee rose $83→$90" against a catalog you've crawled once, and **you cannot wait years for the data.**

So we built a **deterministic test double for the temporal layer** — the direct analogue of the mock-`LanguageModel` harness that lets the agent loop be tested without a provider. It fabricates plausible _prior_ terms for real courses, across three archetypes chosen to exercise both branches:

| Archetype          | What it adds                                          | Verdict it produces                                             |
| ------------------ | ----------------------------------------------------- | --------------------------------------------------------------- |
| **`recurring`**    | +2 consecutive prior-year same-season terms → 3 total | `grounded` — the multi-term answer, with a fee trajectory       |
| **`returning`**    | +1 prior term two years back (a gap) → 2 total        | `grounded` — seen twice, years apart                            |
| **`current_only`** | **+0** — left at n=1                                  | `insufficient` — the honesty branch, **inside** a multi-term DB |

That third archetype is the important one: it proves the refusal is per-course evidence, not a global "we have history now" flag — a course the generator leaves alone still answers _"I've only seen it once"_ even though the database around it now spans years.

**It is deterministic by construction** — no `Date.now`, no `Math.random`. Archetype assignment and fee drift are hashed off the course's couID; synthetic page UUIDs are derived from a hash of `(course, term)`; fees drift ~4%/year below the current price so "has it gotten more expensive?" has a real, monotone answer. Same input → same fixture, every run and every machine — the same property the golden set's fixed `EVAL_TODAY` gives Phase 4.

---

## 6. The iron rule — how synthetic data is contained

**Synthetic history is a test/scratch fixture only. It must never touch, and must be self-identifying apart from, the real observed catalog.** This is not a style preference — it is the whole product thesis turned into a constraint. If we backfilled fabricated terms into the real corpus and bumped `terms_observed`, we would have _built the exact lie the system exists to prevent_: a future real user asking "does this run every summer?" would be told "yes" from data we invented. History cannot be backfilled (§5.3), so faking it is the one unforgivable move.

Four mechanisms enforce it:

- **The generator is pure and additive.** It emits _prior_-term siblings only; it never mutates a real current listing.
- **Every synthetic row is tagged.** `detail_url` / `url` carry a `synthetic://` prefix; `extraction.prompt_version = 'synthetic-history'`. A synthetic row is greppable and deletable.
- **The database is self-identifying.** The loader sets an `app_meta` marker `synthetic_history = true`, so any DB carrying fabricated terms announces itself — code and humans can both check.
- **The CLI refuses by default.** `main-synth-history.ts` will not run without an explicit `ALLOW_SYNTHETIC_HISTORY=1`, and its own message tells you to point `POSTGRES_URL` at a throwaway scratch DB. The load is idempotent — a reload clears prior synthetic rows first.

The workflow is: clone the catalog to a scratch DB, load synthetic history there, ask questions of the scratch DB. The real catalog is never a valid target.

---

## 7. Honesty about the synthetic data

**Synthetic history is a fixture, and this document says so.** It is _fabricated_ data with a plausible shape — monotone fee drift, clean season alignment, a tidy three-archetype split. It is exactly as real as the mock `LanguageModel`'s scripted responses: a controlled input that lets us assert the code's behavior, **not** evidence about the world.

What the synthetic run actually demonstrates:

- The **`course_history` SQL is correct** — the per-term rollup, the live-plus-disappeared grouping, the change log, and the `termsSeen` count all produce the right structure over real Postgres.
- The **honesty logic is correct in both directions** — `grounded` when the evidence exists, `insufficient` when it doesn't, and — the subtle case — `insufficient` for a single-term course _even in a database full of other history_.
- The **guardrails hold** — the CLI refuses without the flag; the marker and tags make the fixture self-identifying.

What it does **not** demonstrate: that any real course actually runs on the schedule shown. When you read _"the fee has risen from $83 to $90,"_ that trajectory was computed by a deterministic drift rule, not observed. Presenting a synthetic answer without that framing would be inventing a result — the framing is the result.

One thing worth noting, because it is real and not synthetic: the live corpus already spans **20 distinct season/year terms in a single crawl** — different terms are different URLs (§5.3, "already works"), including genuine multi-year pairs (a course listed for Spring 2025 _and_ Spring 2026). So the `grounded` branch has real signal today; synthetic history is what's needed to exercise the deeper multi-year recurring and gone archetypes on demand.

---

## 8. What the run shows

**Grounded — on real data, no synthetic anything:**

> _Q: "Has the LSAT Test Prep Live-Online course gotten more expensive over time?"_
> "Since July 2026 I've seen the LSAT Test Prep Live-Online in 5 terms: Winter 2026, Summer 2026, Fall 2026, Winter 2027, and Summer 2027. The fee has risen from $999 in Winter 2026 to $1099 in Summer 2027. It's currently listed for Summer 2027. **That's only what I've observed since July 2026; I can't see the catalog's history before then.**"

**Honest "I don't know yet" — the refusal that isn't a refusal:**

> _Q: "Does the Professional Grant Writing course run every year?"_
> "I don't have a dated term on record for the Professional Grant Writing, and **I've only been watching this catalog since July 2026 — so I can't tell you how often it runs or when it's next offered.**" `(refused: false — this is an answer, not a refusal.)`

**Grounded multi-year — on the synthetic scratch DB:**

> _Q: "Has the Group Therapy for Complex Trauma course gotten more expensive over the years?"_
> "Since January 2022 I've seen the Group Therapy for Complex Trauma in 3 terms: Fall 2024, Fall 2025, and Fall 2026. The fee has risen from $83 in Fall 2024 to $90 in Fall 2026. It's currently listed for Fall 2026. That's only what I've observed since January 2022."

The tell for which database answered is baked into the honesty clause itself: the synthetic scratch DB says _"since January 2022,"_ the real corpus says _"since July 2026."_ The window is not decoration — it is the bound on every claim.

---

## 9. What is deliberately **not** done yet

- **`system_epoch.terms_observed` on the live DB is still `0`.** `refreshTermsObserved` exists and the synthetic loader calls it, but the real crawl path doesn't yet — so the stored global count is stale. The honesty prose keys off `observing_since` (a date, always correct), so this is cosmetic today; wiring it into the crawl is the clean follow-up.
- **Temporal is scored, not gated.** The eval runner records `temporalRouted` (did it route to history) and `temporalVerdict` (was the answer honest), and the report prints them — but they don't move the §11.4 gate, which stays on the `filter_exact` / nDCG headlines. The deterministic honesty logic is asserted by unit + integration tests instead, which is stronger than a sampled metric.
- **Recurrence _inference_ is out of scope, by design.** The system reports the terms it observed and refuses to extrapolate. "It has run each of the last three falls" is grounded; "it runs every fall" is a claim the observation window can't support, and the prose never makes it.

Naming what isn't done is part of the discipline — the same reason Phase 4 marked `prose_faithful` as `NULL` rather than quietly omitting it.

---

## Appendix — implementation notes

- **Domain:** `history.ts` (`CourseHistory` / `TermRun` / `ChangeEvent`) — plain hydrated rows, never model-decoded. `KnowledgeBase.courseHistory` is the port; `RouteDecision` gains `historyQuery`.
- **The SQL:** `retrieval/course-history.ts` — the §5.3.5 rollup (`GROUP BY` term over all listings, `bool_or(disappeared_at IS NULL)` for `stillListed`) + the change log, `termsSeen` counting distinct dated terms. `refreshTermsObserved` recomputes the global count.
- **The honesty formatter:** `history/format-history.ts` `composeHistory` — pure, total, three verdicts, unit-tested on both branches.
- **The agent:** `answer-agent.ts` `answerHistory` requires only `KnowledgeBase` (no answerer, no LLM spend on facts) and returns the verdict; `run` branches to it and emits a typed §10.3 **`history`** SSE event (the term timeline) before `window`.
- **Synthetic history:** `history/synth-history.ts` (pure generator, FNV-1a-seeded, no clock) → `history/load-synth.ts` (tags rows, sets the marker, idempotent) → `main-synth-history.ts` (the guarded CLI). The integration test (`synth-history.integration.test.ts`) proves grounded / insufficient / gone / not_found over a testcontainer.
- **Provider:** the router is Gemini (same adapter as Phase 4); the history answer uses **no** generation model at all — its prose is deterministic. This is the cheapest possible answer path.

**Reproduce it — honest branch, real corpus:**

```bash
cd packages/server
CHAT_Q="Does the Professional Grant Writing course run every year?" pnpm chat
```

**Reproduce it — grounded multi-year, synthetic scratch DB:**

```bash
# 1. Clone the catalog to a throwaway DB (embeddings included, so search works)
docker exec catalog-pg psql -U postgres -c "DROP DATABASE IF EXISTS catalog_synth;"
docker exec catalog-pg psql -U postgres -c "CREATE DATABASE catalog_synth WITH TEMPLATE catalog;"

# 2. Load synthetic history into the SCRATCH DB (guarded — refuses without the flag)
cd packages/server
SYNTH_URL="$(grep -E '^POSTGRES_URL=' ../../.env | head -1 | cut -d= -f2- | sed 's#/catalog$#/catalog_synth#')"
ALLOW_SYNTHETIC_HISTORY=1 SYNTH_LIMIT=60 POSTGRES_URL="$SYNTH_URL" pnpm synth:history

# 3. Ask a temporal question OF THE SCRATCH DB (note the POSTGRES_URL override)
CHAT_Q="Has the Group Therapy for Complex Trauma course gotten more expensive over the years?" \
  POSTGRES_URL="$SYNTH_URL" pnpm chat

# 4. Clean up
docker exec catalog-pg psql -U postgres -c "DROP DATABASE catalog_synth;"
```

The window clause in every answer tells you which database replied: _"since January 2022"_ is synthetic, _"since July 2026"_ is real.
