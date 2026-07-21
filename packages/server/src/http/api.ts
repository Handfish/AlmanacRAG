import { ListingFilter } from "@catalog/domain/filter";
import { KnowledgeBase } from "@catalog/domain/ports/knowledge-base";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";

// The typed HttpApi surface (ADR-I4). Phase 0 shipped GET /health; Phase 3 adds the
// `search` group — retrieval only, no generation (§16 M3). Phases 5/6 add `chat`
// (SSE §10.3), `hydrate` (the §1 guarantee — live status/fees at render), `feedback`,
// and `compat` (OpenAI-compatible §10.5).

const HealthStatus = Schema.Struct({
  status: Schema.Literal("ok"),
  service: Schema.String,
});

export class HealthGroup extends HttpApiGroup.make("health").add(
  HttpApiEndpoint.get("health", "/health", { success: HealthStatus }),
) {}

// ── search (§16 M3) ──────────────────────────────────────────────────────────
// POST /search decomposes a query into its two independent halves (§8): the soft
// predicate → hybrid RRF over course chunks (`courses`); the hard predicates →
// `filter_listings` (`listings`). The caller intersects on `courseId`. Both fields
// are optional: a pure lookup sends only `query`, a pure filter only `filter`.

const SearchRequest = Schema.Struct({
  query: Schema.optional(Schema.String),
  filter: Schema.optional(ListingFilter),
  limit: Schema.optional(Schema.Int),
});

const SearchHitSchema = Schema.Struct({
  courseId: Schema.String,
  score: Schema.Number,
  courseTitle: Schema.NullOr(Schema.String),
});

const FilteredListingSchema = Schema.Struct({
  listingId: Schema.String,
  courseId: Schema.String,
  courseTitle: Schema.String,
  term: Schema.NullOr(Schema.String),
  campus: Schema.NullOr(Schema.String),
  deliveryMode: Schema.NullOr(Schema.String),
  status: Schema.String,
  isEvening: Schema.NullOr(Schema.Boolean),
  startsOn: Schema.NullOr(Schema.String),
  endsOn: Schema.NullOr(Schema.String),
  totalFeeCents: Schema.NullOr(Schema.Number),
  contactHours: Schema.NullOr(Schema.Number),
  detailUrl: Schema.String,
  registrationUrl: Schema.NullOr(Schema.String),
});

const SearchResponse = Schema.Struct({
  courses: Schema.Array(SearchHitSchema),
  listings: Schema.Array(FilteredListingSchema),
});

export class SearchGroup extends HttpApiGroup.make("search").add(
  HttpApiEndpoint.post("search", "/search", {
    payload: SearchRequest,
    success: SearchResponse,
  }),
) {}

export class CatalogApi extends HttpApi.make("catalog").add(HealthGroup).add(SearchGroup) {}

// Handlers for the `health` group.
const HealthGroupLive = HttpApiBuilder.group(
  CatalogApi,
  "health",
  (handlers) =>
    handlers.handle("health", () => Effect.succeed({ status: "ok" as const, service: "catalog" })),
);

// Handlers for the `search` group. Retrieval failures become 500s (`orDie`) — the
// port already folds every vendor/SQL fault into one typed KnowledgeBaseError.
const SearchGroupLive = HttpApiBuilder.group(
  CatalogApi,
  "search",
  (handlers) =>
    handlers.handle("search", ({ payload }) =>
      Effect.gen(function*() {
        const kb = yield* KnowledgeBase;
        const limit = payload.limit ?? 20;
        const query = payload.query?.trim() ?? "";
        const courses = query.length > 0 ? yield* kb.search(query, limit) : [];
        const listings = payload.filter !== undefined
          ? yield* kb.filterListings(payload.filter, limit)
          : [];
        return { courses, listings };
      }).pipe(Effect.orDie)),
);

// The API registered into an HttpRouter, with its group handlers provided.
export const ApiLive = HttpApiBuilder.layer(CatalogApi).pipe(
  Layer.provide(HealthGroupLive),
  Layer.provide(SearchGroupLive),
);
