// The extraction contract's prose half (architecture.md §9). Shared verbatim by
// every provider adapter — the Anthropic `generateObject` path and the Gemini
// batch path both feed the SAME instructions against the SAME `ExtractedCourse`
// schema, so a provider swap (§11.5 ablation) compares models, not prompts.

/** Bumped when the prompt or schema changes; recorded on every `extraction` row. */
export const PROMPT_VERSION = "extract-v1";

// Accuracy-first instructions (the "don't let hallucinations bite" requirement):
// the model transcribes raw values and does the genuinely-semantic work; tested
// `derive` code parses/validates. See docs/real-data-findings-1.md for the shapes.
export const SYSTEM =
  `You extract ONE continuing-education course listing from the full text of its catalog page into a strict JSON object. Accuracy over completeness — never invent a value.

- Copy raw values VERBATIM where the field says so: statusRaw, datesText, timesText, formatText, locationText, sessionLabel, and each fee's amount. Downstream code parses these — do not normalize, reformat, or "clean up".
- deliveryMode and campus MUST be one of the allowed enum values. If the page is genuinely ambiguous, choose "unknown" rather than guessing.
- Every field is required: emit null when the fact is absent from the page. Never fill a field by inference from unrelated text.
- instructors: the page prints "Last, First" and may concatenate several ("Ahn, Haemee Hu, Fiona" is two people). Split into separate {lastName, firstName}. Drop anything that is not a person's name (e.g. "Asynchronous, Self Paced").
- fees: one entry per fee line, verbatim label and amount; set isTotal true ONLY for the "Total Fees" line.
- externalCourseId: copy the printed course id/code exactly as shown; do not tidy it.
- track / contactHours / subject: parse from the title when present ("45 - Hour" → contactHours 45).
- relations: list prerequisite/corequisite/concurrent course references found in BOTH the Prerequisites field AND the description prose — the prose often states relations the field omits. Keep the raw text.
- registrationDeadlineText: copy any footnote stating a registration-deadline rule verbatim.`;
