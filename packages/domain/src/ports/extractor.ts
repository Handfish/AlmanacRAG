import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { ExtractError } from "../errors.js";
import type { ExtractedCourse } from "../extraction.js";

// Structured extraction from a full page (architecture.md §9). The Phase-2 adapter
// runs `generateObject` against the single `ExtractedCourse` schema and decodes
// before the DB; a value outside a closed enum, or a field that will not parse, is
// a typed `schema_error` row (§5.5), never a silent null.
//
// No `family` parameter: the A/B/C template families were a legacy-scraper artifact
// absent from the real corpus (`course_data` is empty on all 995 pages) — extraction
// is one schema over one template. See docs/real-data-findings-1.md.

export type ExtractionInput = {
  readonly rawMarkdown: string;
};

export type ExtractorShape = {
  readonly extract: (
    input: ExtractionInput,
  ) => Effect.Effect<ExtractedCourse, ExtractError>;
};

export class Extractor extends Context.Service<Extractor, ExtractorShape>()("catalog/Extractor") {}
