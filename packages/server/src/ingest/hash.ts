import { generateHash } from "./utils.js";

// ── Segmented hashing (§5.1). One hash over a whole page conflates two lifetimes:
//
//   course  — title, description, prerequisites          churns over years
//   listing — term, dates, status, instructor, fees       churns daily → termly
//
// `Status: Course Full` flipping when someone drops must NOT re-hash the course
// segment (that would re-extract a description that didn't move and re-embed a
// byte-identical chunk in later phases). Splitting the hash makes status churn
// cost a cheap typed re-extract and zero embedding spend.

/** sha256 hex — the primitive under every hash here. */
export const sha256Hex = (content: string): string => generateHash(content);

/**
 * Normalize before hashing so insignificant reflow (a wrapped line, a doubled
 * space) does not read as a content change, while real edits still do. Collapse
 * all whitespace runs to a single space and trim. Case is preserved — a change
 * from "Open" to "Closed" must register.
 */
export const normalizeForHash = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Hash one segment's text (course or listing). Empty segments hash stably. */
export const hashSegment = (text: string): string => sha256Hex(normalizeForHash(text));

/**
 * The whole-page snapshot key (§5.3.3). Hashed over the exact stored markdown
 * (no normalization) so `page_snapshot` stores one row per byte-distinct page
 * and an unchanged page writes nothing.
 */
export const contentHashOf = (rawMarkdown: string): string => sha256Hex(rawMarkdown);
