import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

// The provenance table `cecc_course_index_course_listing` (§5.1) — adopted, not
// replaced. This repo is the whole write path for Phase 1: read prior validators
// + hashes for conditional GET and change detection, write the full page back,
// and bump the observation clock (§5.3.1).

/** Prior state of a page, for conditional GET and segmented change detection. */
export interface ExistingPage {
  readonly id: string;
  readonly courseHash: string | null;
  readonly listingHash: string | null;
  readonly contentHash: string | null;
  readonly etag: string | null;
  readonly httpLastModified: string | null;
}

export const getExistingByUrl = (url: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    // Result keys are camelCase — pgConfig transformResultNames snake→camel.
    const rows = yield* sql<{
      id: string;
      courseHash: string | null;
      listingHash: string | null;
      contentHash: string | null;
      etag: string | null;
      httpLastModified: string | null;
    }>`
      SELECT
        id::text AS id,
        encode(course_hash, 'hex')  AS course_hash,
        encode(listing_hash, 'hex') AS listing_hash,
        content_hash,
        etag,
        http_last_modified
      FROM cecc_course_index_course_listing
      WHERE url = ${url}
    `;
    const row = rows[0];
    return row === undefined ? null : {
      id: row.id,
      courseHash: row.courseHash,
      listingHash: row.listingHash,
      contentHash: row.contentHash,
      etag: row.etag,
      httpLastModified: row.httpLastModified,
    } satisfies ExistingPage;
  });

export interface ObserveInput {
  readonly url: string;
  readonly rawHtml: string;
  readonly rawMarkdown: string;
  readonly pageFields: unknown;
  readonly courseHash: string;
  readonly listingHash: string;
  readonly contentHash: string;
  readonly httpStatus: number;
  readonly etag: string | undefined;
  readonly lastModified: string | undefined;
  readonly groupUrl: string | undefined;
}

const toIsoOrNull = (httpDate: string | undefined): string | null => {
  if (!httpDate) return null;
  const d = new Date(httpDate);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * Write a fetched (200) page. Insert-or-update keyed on `url` (page identity):
 * stores the whole page (raw_html + raw_markdown — the blocking gap, §2.2),
 * the segmented hashes, conditional-GET validators, the grouping link, and bumps
 * `last_seen_at` while clearing any prior `disappeared_at` (a page that came
 * back is live again). `first_seen_at` is set once, on insert, by the column
 * default. Returns the row id.
 */
export const observePage = (input: ObserveInput) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    const lm = toIsoOrNull(input.lastModified);
    // page_fields is passed as a JSON string cast to jsonb, so its keys survive
    // verbatim (the client's transformJson would otherwise snake_case them).
    const pageFieldsJson = JSON.stringify(input.pageFields ?? {});
    const rows = yield* sql<{ id: string; }>`
      INSERT INTO cecc_course_index_course_listing
        (url, raw_markdown, raw_html, page_fields, course_hash, listing_hash, content_hash,
         http_status, etag, http_last_modified, group_url,
         last_hash_comparison_at, updated_at, last_seen_at)
      VALUES
        (${input.url}, ${input.rawMarkdown}, ${input.rawHtml}, ${pageFieldsJson}::jsonb,
         decode(${input.courseHash}, 'hex'), decode(${input.listingHash}, 'hex'),
         ${input.contentHash}, ${input.httpStatus}, ${input.etag ?? null}, ${lm},
         ${input.groupUrl ?? null}, now(), now(), clock_timestamp())
      ON CONFLICT (url) DO UPDATE SET
        raw_markdown            = EXCLUDED.raw_markdown,
        raw_html                = EXCLUDED.raw_html,
        page_fields             = EXCLUDED.page_fields,
        course_hash             = EXCLUDED.course_hash,
        listing_hash            = EXCLUDED.listing_hash,
        content_hash            = EXCLUDED.content_hash,
        http_status             = EXCLUDED.http_status,
        etag                    = EXCLUDED.etag,
        http_last_modified      = EXCLUDED.http_last_modified,
        group_url               = COALESCE(EXCLUDED.group_url,
                                           cecc_course_index_course_listing.group_url),
        last_hash_comparison_at = now(),
        updated_at              = now(),
        last_seen_at            = clock_timestamp(),
        disappeared_at          = NULL
      RETURNING id::text AS id
    `;
    const row = rows[0];
    if (row === undefined) return yield* Effect.die("observePage upsert returned no row");
    return row.id;
  });

/**
 * A 304 response: the page is byte-identical to what we hold, so there is no
 * body to store. Just record that we saw it this run (bump last_seen_at, clear
 * disappeared_at) and refresh the comparison timestamp.
 */
export const touchObservation = (url: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient;
    yield* sql`
      UPDATE cecc_course_index_course_listing
      SET last_seen_at = clock_timestamp(), disappeared_at = NULL, last_hash_comparison_at = now()
      WHERE url = ${url}
    `;
  });
