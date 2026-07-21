import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

// Prerequisite chains (architecture.md §7.4) — the one place a graph is warranted, in
// fifteen lines of recursive SQL. Walks `course_relation` from a course to everything
// it (transitively) requires. The depth guard is NOT optional: catalog data contains
// cycles, and the guard both bounds recursion and de-dupes via UNION.
//
// Only resolved edges (requires_id NOT NULL) participate — the extractor stores raw
// prerequisite text with a NULL FK until a later resolution pass, so this returns the
// portion of the chain that has been linked to real courses.

export interface PrereqRow {
  readonly courseId: string;
  readonly courseTitle: string;
  readonly depth: number;
}

export const prereqChain = (courseId: string, maxDepth = 10) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    return yield* sql<PrereqRow>`
      WITH RECURSIVE chain AS (
        SELECT requires_id, 1 AS depth
        FROM course_relation
        WHERE course_id = ${courseId} AND requires_id IS NOT NULL
        UNION
        SELECT r.requires_id, chain.depth + 1
        FROM course_relation r
        JOIN chain ON r.course_id = chain.requires_id
        WHERE chain.depth < ${maxDepth} AND r.requires_id IS NOT NULL
      )
      SELECT c.id::text AS course_id, c.course_title, chain.depth
      FROM chain
      JOIN course c ON c.id = chain.requires_id
      ORDER BY chain.depth
    `;
  });
