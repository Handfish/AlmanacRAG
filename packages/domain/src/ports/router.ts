import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { RouterError } from "../errors.js";
import { ListingFilter } from "../filter.js";

// The query-understanding seam (architecture.md §8) — "the highest-leverage component
// in the system". 868 short documents are trivially searchable; the failure mode is
// misreading *"under $2,000"*, *"evenings"*, *"before September"*, *"still open"* into
// a wrong `ListingFilter`. So the router gets its own eval slice with directly-labelable
// ground truth (`eval_item.expected_filter`) and the headline metric `filter_exact`
// (§11.2). This port is the contract the Phase-4 eval measures; the Phase-5 answer
// agent (§10) will call the same router in front of the Toolkit loop.
//
// A route decomposes the query into its two independent halves (§8):
//   • `filter`      — the HARD predicates (campus/fee/date/status/…) → `filter_listings`.
//                     `null` when the query carries no hard predicate (a pure lookup).
//   • `searchQuery` — the SOFT predicate (the topic) → `search_catalog` (hybrid RRF).
//                     `null` when the query is pure-structured ("everything in Newark").
// The caller intersects the two on `course_id`. `refuse` is the §10.6 grounded-refusal
// signal: the query is out of scope ("a PhD in astrophysics"), too ambiguous to route
// ("the AI class"), or needs a capability we don't have yet (recurrence → history, §8) —
// in which case neither half is trustworthy and the honest answer is "I can't answer that".
export class RouteDecision extends Schema.Class<RouteDecision>("RouteDecision")({
  filter: Schema.NullOr(ListingFilter),
  searchQuery: Schema.NullOr(Schema.String),
  refuse: Schema.Boolean,
}) {}

export type RouterShape = {
  // `today` is passed EXPLICITLY (not read from the clock) so relative dates resolve
  // deterministically and the eval is reproducible — `eval_run.config` records it, so a
  // "before September" item means the same thing on every replay (§11.3).
  readonly route: (
    question: string,
    today: Date,
  ) => Effect.Effect<RouteDecision, RouterError>;
};

export class Router extends Context.Service<Router, RouterShape>()("catalog/Router") {}
