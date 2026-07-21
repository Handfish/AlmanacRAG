# Real-data findings — ce-catalog vs architecture.md §5.2/§9

**Doc:** `real-data-findings-1.md` · rev 1 · 2026-07-20
**Source:** the live Phase-1 crawl — 995 pages, Docker pgvector `:5433`, table
`cecc_course_index_course_listing`. **Verified first-hand** (not relayed).
**Purpose:** hand-off for the `architecture.md` §2.1/§5.2/§9 amendment, and the basis for
Phase-2 migration 0003 + the single-schema extractor.

The typed schema in §5.2/§9 was close-read from **one** legacy page (ALT10). The real
corpus diverges materially. The four load-bearing corrections:

---

## 1. The A/B/C template families do not exist in the real corpus

The families were defined by `course_data` keys. In the real crawl `course_data` is `{}`
on **995/995** rows — the 345/153/585 split was the legacy reference-scraper scraper's
output, describing _that scraper_, not ce-catalog. Every family-defining key is absent:
`courseCode` 0, `certificateDisplay` 0, plural `instructors` 0.

The real signal is **`page_fields`** — a **flat** jsonb (fields at the top level, not
nested under a `fields` key). It is **one template**: a required core + a long optional
tail (28 distinct keys, a smooth 8→20 key-count gradient, 144 signatures — a gradient, not
3 bins).

| tier                | keys (share of 995)                                                                                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| core (≈100%)        | `fees`, `title`, `status`, `session`                                                                                                                                                                                                                     |
| near-core (≈95–99%) | `sectionId`, `prerequisites`, `courseId`, `instructor`, `location`, `refundPolicy`                                                                                                                                                                       |
| common (50–89%)     | `dates` 89, `times` 69, `days` 66, `category` 63, `format` 53                                                                                                                                                                                            |
| tail (<50%)         | `cancellationPolicy` 46, `availableSlots` 21, `alternateSchedule` 19, `abstract` 17, `admissionRequirements`/`audience`/`instructorBio` 13, `creditSEarned` 9, `outline` 7, `ofMonths` 6, `locationAndMapLink` 5, `ageRequirement` 1, `conferenceCode` 1 |

**⇒ Extraction is ONE schema (required core + optional tail), not one-prompt-per-family.**
Stratify hand-labels by field-presence / key-count, not by family.

## 2. `courseId` is a field to verify, not an oracle

`courseId` is present on **987/995 (99%)** — not the rare, clean key Family A assumed — and
the values are heterogeneous: `PP-2216`, `RootsRockRoll-`, `SAC_AGES7-10`, `Leadership`,
`VeryShortAI-`, `DAM572`, `520024`. So §9.3's tier-1 premise ("345 clean `courseCode`
labels as a free answer key") is inverted: `external_course_id` must be **verified** (is it
a code, a slug, or a bare section-id?), and `title_normalized` carries more of the identity
load. `unit`/`root_url`/`program`/`cecc_unit` are **null on all 995**.

## 3. Term: derive from `dates`, not `session`

Real `session` is a **year / year-range / cohort suffix** — `2026`, `2025-26`, `2025 -
2026`, `2024-EBP`, `2025-SLP`, `2023CSOC` — **not** "Summer 2026". There is no season in
it. But `dates` is clean and near-universal (89%): `MM/DD/YYYY - MM/DD/YYYY`
(`10/05/2026 - 1/10/2027`, cross-year ranges included).

**⇒ Derive `starts_on`/`ends_on` from `dates`; derive `term_season`/`term_year` from the
start month** (Jun–Aug→Summer, …). Keep `session` verbatim as a cohort label, not a term.
`term_rank`'s source changes accordingly.

## 4. Unit: `course.unit_id NOT NULL` cannot hold

§5.2.1 models ~10 units owning refund/cancellation policy. In the real data `cecc_unit` is
**null on all 995**, and the policies are **per-page**: `refundPolicy` 94%,
`cancellationPolicy` 46% — captured in `page_fields`, not per-unit. **⇒ `course.unit_id`
must be nullable** (or units inferred by clustering distinct policy/contact tuples). The
"what's the refund policy?" question is answerable per-listing today; the unit rollup is a
later, optional normalization.

---

## Real vocabularies (for the enums + `derive` maps)

**status** (4 values) → closed `Status` enum:
`Registration Available` 651 → `open` · `Registration Not Available` 264 → `closed` ·
`Waiting List Available` 78 → `waitlist` · `Course Full` 2 → `full`. Unknown → `unknown` + alert.

**format** (messy; → `DeliveryMode`): `-Online: Instructor Led` / `Distance Education: Online
Scheduled` / `Instructor Led: Online` → `online_sync`; `Asynchronous/Self-Paced` / `Online:
Self Paced` → `online_async`; `Instructor Led: Classroom` / `-In Person: Instructor Led` →
`in_person`; `Hybrid` → `hybrid`. Note `Instructor Led: Evening & Weekend` — an **evening
signal in the Format field**, not just `times`.

**fees**: `Total Fees` 754 (→ `is_total`), `Registration Fee` 337, `Tuition` 196, plus
footnote/tier prose in the label (`Tuition - for non-member. MEMBER is $50…`, `* Registration
Fee`). Keep the label verbatim; parse `"$ 415"` → cents in derive.

**instructor**: concatenated `Last, First` pairs (`Ahn, Haemee Hu, Fiona` = two people);
non-name leaks (`Asynchronous, Self Paced`) must be dropped. → multiple `listing_instructor` rows.

**location** (free-form): `100 Rock, Room 3031 100 Rockafeller Rd Piscataway , NJ 08854`,
`65 Bergen-Newark, *, Rm213`, out-of-state (`Alexandria, VA`, `Cincinnati, OH`). → `campus`
by keyword map (Busch/Cook/College Ave/Piscataway→New Brunswick; Newark→Newark;
out-of-state→Other; online→Online), `location_room` by regex.

**prerequisites**: 919 sentinel (`None`/`n/a`/`-`) vs **68 real** → low-volume
`course_relation` candidates; resolve best-effort, publish the rate (§5.2.5).

**dates**: clean `MM/DD/YYYY - MM/DD/YYYY`, some cross-year → `starts_on`/`ends_on` via the
ported `dates.ts`.

---

## What this changes in the code (Phase 2)

- `packages/domain/src/course.ts` — enums grounded above.
- `packages/domain/src/extraction.ts` — **one** `ExtractedCourse` `generateObject` schema
  (closed enums + raw-verbatim capture for deterministic derivation), replacing the 3 family
  schemas.
- `packages/domain/src/ports/extractor.ts` — `family` param dropped.
- Migration 0003 (pending): drop `course.template_family` and `extraction.family`; make
  `course.unit_id` nullable; source `term_*` from `dates`. Aligns to the amended §5.2.
