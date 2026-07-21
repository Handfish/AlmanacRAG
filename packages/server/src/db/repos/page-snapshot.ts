import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

// page_snapshot (§5.3.3). Keyed on the content hash, so an unchanged page writes
// nothing and only byte-distinct content is ever stored. This is the re-crawlable
// archive M2 extraction replays against — the past cannot be re-fetched.

/** Store a snapshot if this (page, content-hash) is new. Returns whether it was inserted. */
export const snapshotIfAbsent = (sourcePageId: string, contentHash: string, rawMarkdown: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ inserted: boolean; }>`
      INSERT INTO page_snapshot (source_page_id, content_hash, raw_markdown)
      VALUES (${sourcePageId}, decode(${contentHash}, 'hex'), ${rawMarkdown})
      ON CONFLICT (source_page_id, content_hash) DO UPDATE SET last_seen_at = now()
      RETURNING (xmax = 0) AS inserted
    `;
    return rows[0]?.inserted ?? false;
  });
