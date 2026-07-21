import { KnowledgeBaseError } from "@catalog/domain/errors";
import type { CourseId } from "@catalog/domain/ids";
import { Embedder } from "@catalog/domain/ports/embedder";
import { KnowledgeBase, type SearchHit } from "@catalog/domain/ports/knowledge-base";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { filterListings } from "../retrieval/filter-listings.js";
import { hybridRrf } from "../retrieval/hybrid-rrf.js";
import { hydrateCards, listingsForCourses, readObservationWindow } from "../retrieval/hydrate.js";
import { relaxFilter } from "../retrieval/relax.js";

// The KnowledgeBase adapter (architecture.md §7, Phase 3) — the retrieval port over
// Postgres. `search` embeds the query (RETRIEVAL_QUERY), resolves the active model
// row, and runs the single hybrid-RRF statement (§7.2). `filterListings` compiles a
// `ListingFilter` to parameterized SQL (§8.4). Both fold vendor/SQL failures into one
// typed `KnowledgeBaseError`, so the port's error channel stays clean (§4). No
// generation here — `/search` is retrieval only (§16 M3).
export const PgKnowledgeBaseLive = Layer.effect(
  KnowledgeBase,
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const embedder = yield* Embedder;

    return {
      search: (query, limit) =>
        Effect.gen(function*() {
          const embedded = yield* embedder.embed([query], "query");
          const vec = embedded[0];
          if (vec === undefined) return [] as ReadonlyArray<SearchHit>;
          // Resolve the model row; if nothing is indexed yet, there's nothing to fuse.
          const models = yield* sql<{ id: number; }>`
            SELECT id FROM model WHERE name = ${embedder.modelName} AND kind = 'embedding'`;
          const modelId = models[0]?.id;
          if (modelId === undefined) return [] as ReadonlyArray<SearchHit>;
          const hits = yield* hybridRrf({
            queryEmbedding: vec,
            modelId,
            queryText: query,
            limit,
          });
          return hits.map((h): SearchHit => ({
            courseId: h.courseId as CourseId,
            score: h.rrf,
            courseTitle: h.courseTitle,
          }));
        }).pipe(
          Effect.provideService(SqlClient, sql),
          Effect.mapError((cause) => new KnowledgeBaseError({ message: "search failed", cause })),
        ),

      filterListings: (filter, limit) =>
        filterListings(filter, limit).pipe(
          Effect.provideService(SqlClient, sql),
          Effect.mapError((cause) =>
            new KnowledgeBaseError({ message: "filterListings failed", cause })
          ),
        ),

      relaxFilter: (filter) =>
        relaxFilter(filter).pipe(
          Effect.provideService(SqlClient, sql),
          Effect.mapError((cause) =>
            new KnowledgeBaseError({ message: "relaxFilter failed", cause })
          ),
        ),

      listingsForCourses: (courseIds, perCourse) =>
        listingsForCourses(courseIds, perCourse).pipe(
          Effect.provideService(SqlClient, sql),
          Effect.mapError((cause) =>
            new KnowledgeBaseError({ message: "listingsForCourses failed", cause })
          ),
        ),

      hydrate: (listingIds) =>
        // The model authors nothing here — `why` lines are attached by the answer
        // agent (agent/answer-agent.ts); this call reads only live facts (§10.4).
        hydrateCards(listingIds, new Map()).pipe(
          Effect.provideService(SqlClient, sql),
          Effect.mapError((cause) => new KnowledgeBaseError({ message: "hydrate failed", cause })),
        ),

      observationWindow: () =>
        readObservationWindow().pipe(
          Effect.provideService(SqlClient, sql),
          Effect.mapError((cause) =>
            new KnowledgeBaseError({ message: "observationWindow failed", cause })
          ),
        ),
    };
  }),
);
