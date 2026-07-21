// Crawl-wide politeness constants (ADR-002, §6.1). One place so the fetcher and
// the robots check agree on identity and timeouts. It's our own institution's
// site: identify honestly, time out fast, stay well under any rate the origin
// would notice.

/** Sent as `User-Agent` and matched against robots.txt user-agent groups. */
export const USER_AGENT =
  "CECC-Catalog-Recrawl/0.1 (+https://github.com/rutgers-cecc; polite re-crawl)";

/** Per-request wall-clock ceiling. A static page answers in well under a second. */
export const FETCH_TIMEOUT_MS = 20_000;

/** Default politeness knobs for a full re-crawl (overridable per run). */
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_MIN_DELAY_MS = 250;
