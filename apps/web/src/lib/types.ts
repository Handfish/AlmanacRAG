import type { Card, ObservationWindow } from "@catalog/domain/answer";
import type { ListingFilter } from "@catalog/domain/filter";

// The web surface renders the SAME domain contracts the server hydrates (plan §10 —
// "imports Answer/Card/Filter from packages/domain for type safety"). `Card` is the §10.1
// result object: every field except `why` is read live from Postgres, so the UI never
// invents a fact — it only lays out what the server hydrated (§10.4).
export type { Card, ObservationWindow };

// Over the wire, the router's `ListingFilter` arrives as plain JSON: `Schema.DateFromString`
// encodes the two Date fields to ISO strings, and absent predicates are simply missing.
// Keyed by ListingFilter's own fields, so a renamed predicate is a compile error here too.
export type FilterKey = keyof ListingFilter;
export type FilterWire = { readonly [K in FilterKey]?: string | number | boolean; };

/** The JSON `/chat` answer (server `ChatResponse`): the whole hydrated turn. */
export interface ChatResponse {
  readonly sessionId: string;
  readonly messageId: string;
  readonly refused: boolean;
  readonly prose: string;
  readonly filter: FilterWire | null;
  readonly cards: ReadonlyArray<Card>;
  readonly followups: ReadonlyArray<string>;
  readonly window: ObservationWindow;
}

/** A listing that passed a filter (server `FilteredListing`) — the chip re-run result
 * before hydration. `listingId` feeds `/hydrate` to get the full live `Card`. */
export interface FilteredListing {
  readonly listingId: string;
  readonly courseId: string;
  readonly courseTitle: string;
  readonly term: string | null;
  readonly campus: string | null;
  readonly deliveryMode: string | null;
  readonly status: string;
  readonly isEvening: boolean | null;
  readonly startsOn: string | null;
  readonly endsOn: string | null;
  readonly totalFeeCents: number | null;
  readonly contactHours: number | null;
  readonly detailUrl: string;
  readonly registrationUrl: string | null;
}

export interface SearchResponse {
  readonly courses: ReadonlyArray<{ courseId: string; score: number; courseTitle: string | null; }>;
  readonly listings: ReadonlyArray<FilteredListing>;
}

/** One predicate the user can drop to escape a zero-result search (§10.3). */
export interface Relaxation {
  readonly key: string;
  readonly label: string;
  readonly count: number;
}

export interface RelaxResponse {
  readonly total: number;
  readonly relaxations: ReadonlyArray<Relaxation>;
}

export interface HydrateResponse {
  readonly cards: ReadonlyArray<Card>;
}

export interface FeedbackResponse {
  readonly ok: true;
  readonly promotedEvalItemId: string | null;
}
