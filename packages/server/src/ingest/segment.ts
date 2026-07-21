import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { extractFields, type PageFields } from "./fields.js";
import { contentHashOf, hashSegment } from "./hash.js";

// ── Parse a fetched page (plan §9, decision D7). We keep two artifacts:
//
//   raw_html      the exact bytes fetched — the archival source of truth. M2
//                 re-extraction (ADR-010) reads title/fields/footnotes/prose
//                 from here; nothing is curated away.
//   raw_markdown  a clean markdown view of the MAIN content region — readable,
//                 chunk-ready (Phase 3), and stable for segmented hashing.
//
// raw_markdown is scoped to the page's main content, not the whole document,
// for one specific reason: the site's global nav/footer is byte-identical across
// all 1,083 pages. Folding it into the hash would make a site-wide nav tweak
// re-hash every course. raw_html still preserves the entire page.

// Tags that never carry course facts. Removed before conversion.
const NON_CONTENT = "script, style, noscript, template, svg, iframe, link, head";

// Where the meaningful content lives, best-first. Mirrors the old crawler, which
// hashed `[role="main"]`. Falls back to <body> so nothing is ever lost.
const MAIN_SELECTORS = ["main", "[role=\"main\"]", "article", "#content", "#main", ".content"];

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});

/** The main content element (chrome removed) — shared by markdown and prose. */
const mainEl = ($: cheerio.CheerioAPI) => {
  $(NON_CONTENT).remove();
  for (const selector of MAIN_SELECTORS) {
    const el = $(selector).first();
    if (el.length > 0 && el.text().trim().length > 0) return el;
  }
  return $("body");
};

/** The main-content HTML fragment (chrome stripped), or the cleaned body. */
const mainHtml = (rawHtml: string): string => mainEl(cheerio.load(rawHtml)).html() ?? "";

/** Convert the main content of a page to markdown. */
export const htmlToMarkdown = (rawHtml: string): string =>
  turndown.turndown(mainHtml(rawHtml)).replace(/\n{3,}/g, "\n\n").trim();

/**
 * The "More offerings like this" link (§5.2.6 / §6.1.2) — the site's own
 * statement of which listings are the same course, so `course_id` grouping is
 * ground truth in Phase 2 rather than a title heuristic. Returned as an absolute
 * URL. `undefined` when the page carries no such link (§17 Q1 is "open a page
 * and look" — we detect it if present and never fabricate one).
 */
export const extractGroupUrl = (rawHtml: string, baseUrl: string): string | undefined => {
  const $ = cheerio.load(rawHtml);
  let found: string | undefined;
  $("a").each((_, a) => {
    if (found) return;
    const $a = $(a);
    // On the real page the link is an IMAGE link — the phrase lives in the
    // anchor's title or the child <img> alt/title, not in anchor text. The href
    // resolves to searchResults.cfm?couID=… — the authoritative course id (§5.2.6).
    const img = $a.find("img");
    const hay = [$a.text(), $a.attr("title") ?? "", img.attr("alt") ?? "", img.attr("title") ?? ""]
      .join(" ")
      .replace(/\s+/g, " ");
    if (/more offerings like this/i.test(hay)) {
      const href = $a.attr("href");
      if (href) {
        try {
          found = new URL(href, baseUrl).toString();
        } catch {
          found = undefined;
        }
      }
    }
  });
  return found;
};

/**
 * Absolute hrefs of anchors matching `selector` (e.g. `a.chart` on the index —
 * the detail-page links, per the catalog owner). Deduplicated. This is the whole
 * of discovery: one static index fetch → the re-crawl set (ADR-002, no browser).
 */
export const extractLinks = (
  rawHtml: string,
  baseUrl: string,
  selector: string,
): Array<string> => {
  const $ = cheerio.load(rawHtml);
  const out = new Set<string>();
  $(selector).each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;
    try {
      out.add(new URL(href, baseUrl).toString());
    } catch {
      // skip unparseable hrefs
    }
  });
  return [...out];
};

/** The non-table prose within the main region — the course description (§5.2). */
const extractProse = (rawHtml: string): string => {
  const $ = cheerio.load(rawHtml);
  const parts: Array<string> = [];
  mainEl($).find("p").each((_, p) => {
    if ($(p).closest("table").length === 0) {
      const t = $(p).text().replace(/\s+/g, " ").trim();
      if (t.length > 0) parts.push(t);
    }
  });
  return parts.join("\n");
};

// ── Segmented hashing (§5.1) from STRUCTURED fields, not markdown lines. turndown
// renders the label/value <table> as a text run, so line heuristics are fragile;
// the field map is deterministic. The two lifetimes:
//   course  — title, description prose, prerequisites, audience, course id (slow)
//   listing — status, session, days, dates, instructor, location, section, fees (fast)
// A status flip moves only the listing hash; a description edit only the course hash.
const courseSegmentOf = (fields: PageFields, description: string): string =>
  [
    fields.title ?? "",
    description,
    fields.fields.prerequisites ?? "",
    fields.fields.audience ?? "",
    fields.fields.courseId ?? "",
  ].filter((s) => s.length > 0).join("\n");

const listingSegmentOf = (fields: PageFields): string =>
  [
    fields.fields.status ?? "",
    fields.fields.session ?? "",
    fields.fields.days ?? "",
    fields.fields.dates ?? "",
    fields.fields.instructor ?? "",
    fields.fields.location ?? "",
    fields.fields.sectionId ?? "",
    fields.fields.courseIdSectionId ?? "",
    fields.fields.format ?? "",
    fields.fields.registrationDeadline ?? "",
    ...fields.fees.map((x) => `${x.amount} ${x.label}`),
  ].filter((s) => s.length > 0).join("\n");

export interface PageAnalysis {
  readonly groupUrl: string | undefined;
  readonly title: string | undefined;
  readonly fields: PageFields;
  readonly courseHash: string;
  readonly listingHash: string;
  readonly contentHash: string;
}

export interface ParsedPage extends PageAnalysis {
  readonly rawMarkdown: string;
}

/**
 * Analyze a fetched page: structured fields, grouping link, segmented hashes, and
 * the snapshot content hash (over the markdown the fetcher already produced).
 */
export const analyzePage = (
  rawHtml: string,
  rawMarkdown: string,
  baseUrl: string,
): PageAnalysis => {
  const fields = extractFields(rawHtml);
  return {
    groupUrl: extractGroupUrl(rawHtml, baseUrl),
    title: fields.title,
    fields,
    courseHash: hashSegment(courseSegmentOf(fields, extractProse(rawHtml))),
    listingHash: hashSegment(listingSegmentOf(fields)),
    contentHash: contentHashOf(rawMarkdown),
  };
};

/** Convenience for tests: convert then analyze in one call from raw HTML. */
export const parsePage = (rawHtml: string, baseUrl: string): ParsedPage => {
  const rawMarkdown = htmlToMarkdown(rawHtml);
  return { rawMarkdown, ...analyzePage(rawHtml, rawMarkdown, baseUrl) };
};
