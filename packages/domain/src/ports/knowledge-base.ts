import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Campus, DeliveryMode, Status } from "../course.js";
import type { KnowledgeBaseError } from "../errors.js";
import type { ListingFilter } from "../filter.js";
import type { CourseId, ListingId } from "../ids.js";

// Retrieval over the catalog (architecture.md §7). The Phase-3 adapter
// (adapters/pg-knowledge-base.ts) runs the single hybrid-RRF statement (§7.2 — one
// round trip, exact scan, no vector index, ADR-004) for `search`, and compiles a
// `ListingFilter` to parameterized SQL (§8) for `filterListings`. Generation stays
// out: `/search` returns fused course ids + filtered listings, nothing model-authored.

/** A course surfaced by hybrid fusion, with its RRF score (higher = better). */
export type SearchHit = {
  readonly courseId: CourseId;
  readonly score: number;
  readonly courseTitle: string | null;
};

/** A listing that passed a `ListingFilter`. Lean projection — the full card is
 * hydrated live at render (§10.4), a Phase-5 concern. */
export type FilteredListing = {
  readonly listingId: ListingId;
  readonly courseId: CourseId;
  readonly courseTitle: string;
  readonly term: string | null;
  readonly campus: Campus | null;
  readonly deliveryMode: DeliveryMode | null;
  readonly status: Status;
  readonly isEvening: boolean | null;
  readonly startsOn: string | null; // ISO YYYY-MM-DD
  readonly endsOn: string | null;
  readonly totalFeeCents: number | null;
  readonly contactHours: number | null;
  readonly detailUrl: string;
  readonly registrationUrl: string | null;
};

export type KnowledgeBaseShape = {
  readonly search: (
    query: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<SearchHit>, KnowledgeBaseError>;
  readonly filterListings: (
    filter: ListingFilter,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<FilteredListing>, KnowledgeBaseError>;
};

export class KnowledgeBase
  extends Context.Service<KnowledgeBase, KnowledgeBaseShape>()("catalog/KnowledgeBase")
{}
