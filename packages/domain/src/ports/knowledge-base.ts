import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Card, ObservationWindow } from "../answer.js";
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
  // ── Phase 5 (the answer path) ──────────────────────────────────────────────
  /** The current live listing for each course id (most recent term, `disappeared_at
   * IS NULL`) — turns `search` course hits into candidate listings for the answer
   * agent (§8). Preserves the input course order. */
  readonly listingsForCourses: (
    courseIds: ReadonlyArray<CourseId>,
    perCourse: number,
  ) => Effect.Effect<ReadonlyArray<FilteredListing>, KnowledgeBaseError>;
  /** The §1 guarantee (§10.4): resolve each `listingId` to a fully hydrated `Card`
   * by reading live `listing` + `listing_fee` + `course`. Facts come from Postgres,
   * never from the model. Order follows the input; unknown ids are dropped. */
  readonly hydrate: (
    listingIds: ReadonlyArray<ListingId>,
  ) => Effect.Effect<ReadonlyArray<Card>, KnowledgeBaseError>;
  /** The observation window (§5.3.4/§10.6): when the clock started (`system_epoch`)
   * and how many terms have been observed — the honesty bound on recurrence claims. */
  readonly observationWindow: () => Effect.Effect<ObservationWindow, KnowledgeBaseError>;
};

export class KnowledgeBase
  extends Context.Service<KnowledgeBase, KnowledgeBaseShape>()("catalog/KnowledgeBase")
{}
