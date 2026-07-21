import * as Crypto from "node:crypto";

// ── Ported from reference-scraper `src/utils.ts` (plan §4.1 / §5.3.3).
// Only the pure, dependency-free helpers travel across: `generateHash` (the
// sha256 the old crawler used for its content gate) and `removeQueryParam` (URL
// normalization — the business scraper stripped `cid` before deduping). The
// crawlee/jsdom-bound helpers are left behind (ADR-002: no browser).

/** sha256 hex of `content`. The primitive under all segmented hashing (§5.1). */
export function generateHash(content: string): string {
  const hash = Crypto.createHash("sha256");
  hash.update(content);
  return hash.digest("hex");
}

/** Drop a query parameter from each URL — e.g. the business scraper's `cid`. */
export function removeQueryParam(
  uris: ReadonlyArray<string>,
  paramToRemove: string,
): Array<string> {
  return uris.map((uri) => {
    const url = new URL(uri);
    url.searchParams.delete(paramToRemove);
    return url.toString();
  });
}

/** The substring strictly between the first `start` and the following `end`. */
export function getSubstringBetween(
  str: string,
  startSubstr: string,
  endSubstr: string,
): string | null {
  const startIdx = str.indexOf(startSubstr);
  if (startIdx === -1) return null;

  const endIdx = str.indexOf(endSubstr, startIdx + startSubstr.length);
  if (endIdx === -1) return null;

  return str.substring(startIdx + startSubstr.length, endIdx);
}
