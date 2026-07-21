import { BadRequest } from "@catalog/domain/errors";
import { ListingFilter } from "@catalog/domain/filter";
import type { ListingId } from "@catalog/domain/ids";
import { KnowledgeBase } from "@catalog/domain/ports/knowledge-base";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { CardWire, chatEffect, ChatGroup, feedbackEffect, FeedbackGroup } from "./chat.js";
import * as RateLimit from "./rate-limit.js";

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

// ── relax (§10.3) — zero-result relaxation ─────────────────────────────────────
// When an editable-chip filter (§10.2) matches nothing, POST /relax counts each
// single-predicate drop so the UI can offer "under $2,000 → 3 results · drop one?".
// No LLM call — the client already holds the filter and re-runs `filter_listings`
// with the chosen chip removed. `total` is the current match count (0 is the case
// that matters); `relaxations` is only populated when `total` is 0 (§10.3).

const RelaxRequest = Schema.Struct({ filter: ListingFilter });

const RelaxationSchema = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  count: Schema.Int,
});

const RelaxResponse = Schema.Struct({
  total: Schema.Int,
  relaxations: Schema.Array(RelaxationSchema),
});

export class RelaxGroup extends HttpApiGroup.make("relax").add(
  HttpApiEndpoint.post("relax", "/relax", {
    payload: RelaxRequest,
    success: RelaxResponse,
  }),
) {}

// ── hydrate (§10.4, the §1 guarantee) ──────────────────────────────────────────
// POST /hydrate resolves listing ids → fully live cards (status/fees read at render).
// The web surface calls this after an editable-chip re-run (§10.2): `/search` returns
// listing ids, `/hydrate` turns them into the SAME live cards the chat answer shows —
// so a chip edit yields identical, freshness-stamped results with no LLM call. The
// model authors nothing here; `why` is empty (there is no answer prose on this path).

const HydrateRequest = Schema.Struct({ listingIds: Schema.Array(Schema.String) });
const HydrateResponse = Schema.Struct({ cards: Schema.Array(CardWire) });

export class HydrateGroup extends HttpApiGroup.make("hydrate").add(
  HttpApiEndpoint.post("hydrate", "/hydrate", {
    payload: HydrateRequest,
    success: HydrateResponse,
  }),
) {}

// The chat + feedback groups (Phase 5, §10) live in `http/chat.ts`; their JSON handlers
// run the answer agent under the single-active-run lock. The SSE surface (§10.3) is a
// separate raw route (`ChatSseRouteLive`) merged by `main.ts`.
export class CatalogApi extends HttpApi.make("catalog")
  .add(HealthGroup)
  .add(SearchGroup)
  .add(RelaxGroup)
  .add(HydrateGroup)
  .add(ChatGroup)
  .add(FeedbackGroup)
{}

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

// Handler for the `relax` group (§10.3). The KnowledgeBase counts the filter and, when
// empty, each single-predicate drop. SQL faults `orDie` (500).
const RelaxGroupLive = HttpApiBuilder.group(
  CatalogApi,
  "relax",
  (handlers) =>
    handlers.handle("relax", ({ payload }) =>
      Effect.gen(function*() {
        const kb = yield* KnowledgeBase;
        return yield* kb.relaxFilter(payload.filter);
      }).pipe(Effect.orDie)),
);

// Handler for the `hydrate` group (§10.4). Resolves listing ids → live cards; the model
// authors nothing (`why` empty). SQL faults `orDie` (500).
const HydrateGroupLive = HttpApiBuilder.group(
  CatalogApi,
  "hydrate",
  (handlers) =>
    handlers.handle("hydrate", ({ payload }) =>
      Effect.gen(function*() {
        const kb = yield* KnowledgeBase;
        const cards = yield* kb.hydrate(payload.listingIds.map((id) => id as ListingId));
        return { cards };
      }).pipe(Effect.orDie)),
);

// Handlers for the `chat` + `feedback` groups (Phase 5, §10). The effects live in
// http/chat.ts; here they bind to the concrete `CatalogApi`. Both require the agent ports
// + SqlClient, satisfied by `main.ts`.
// The JSON `/chat` handler rate-limits before the agent runs, so a throttled client never
// triggers the three-Gemini-call fan-out (§ abuse guard, mirrors the SSE route). This
// endpoint only declares `BadRequest`, so an over-limit request fails as one (message says
// so) rather than a 429 — the browser surface is SSE (`/chat/stream`), which does return a
// proper 429 with Retry-After. To return 429 here too, add an error type to `ChatGroup`.
const ChatGroupLive = HttpApiBuilder.group(
  CatalogApi,
  "chat",
  (handlers) =>
    handlers.handle("chat", ({ payload }) =>
      Effect.gen(function*() {
        const decision = yield* RateLimit.rateDecision;
        if (!decision.allowed) {
          return yield* Effect.fail(
            new BadRequest({
              message: `rate limit exceeded — retry after ${decision.retryAfterSec}s`,
            }),
          );
        }
        return yield* chatEffect(payload);
      })),
);

const FeedbackGroupLive = HttpApiBuilder.group(
  CatalogApi,
  "feedback",
  (handlers) => handlers.handle("feedback", ({ payload }) => feedbackEffect(payload)),
);

// The API registered into an HttpRouter, with its group handlers provided. The chat and
// feedback handlers require the agent ports (Router/KnowledgeBase/Answerer) + SqlClient,
// satisfied by `main.ts`.
export const ApiLive = HttpApiBuilder.layer(CatalogApi).pipe(
  Layer.provide(HealthGroupLive),
  Layer.provide(SearchGroupLive),
  Layer.provide(RelaxGroupLive),
  Layer.provide(HydrateGroupLive),
  Layer.provide(ChatGroupLive),
  Layer.provide(FeedbackGroupLive),
);
