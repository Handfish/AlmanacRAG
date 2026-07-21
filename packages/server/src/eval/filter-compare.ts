import { ListingFilter } from "@catalog/domain/filter";
import * as Schema from "effect/Schema";

// `filter_exact` — the headline metric (architecture.md §11.2). Given a natural-language
// query, did the router produce the CORRECT `ListingFilter`? We compare canonical wire
// forms: encode both filters through the domain schema (so a `startsBefore` Date and its
// ISO string compare equal, and absent optional keys simply don't appear), drop nothing
// but sort keys, and JSON-compare. `null` (no hard predicate at all — a pure lookup) is
// its own canonical form `""`, distinct from an empty filter `{}`.
//
// Beyond the binary, `fieldDiffs` surfaces the SILENT failures §11.2 warns about: a
// `maxFeeCents` off by 100× ("$2,000" → 2000 not 200000) is catastrophic and invisible
// in an aggregate, so it gets its own diff kind; `missing` is an under-read predicate,
// `extra` is the over-eager filter that "works against the user" (§8) by hiding the Fall
// section of the very course they wanted.

const encodeFilter = Schema.encodeSync(ListingFilter);

type Wire = Record<string, unknown>;

const toWire = (filter: ListingFilter | null): Wire =>
  filter === null ? {} : (encodeFilter(filter) as Wire);

/** Canonical JSON of a filter's wire form (sorted keys). `null` → `""`. */
export const canonicalFilter = (filter: ListingFilter | null): string => {
  if (filter === null) return "";
  const wire = toWire(filter);
  const keys = Object.keys(wire).filter((k) => wire[k] !== undefined).sort();
  const obj: Wire = {};
  for (const k of keys) obj[k] = wire[k];
  return JSON.stringify(obj);
};

/** The §11.2 headline: did the router's filter match the labelled one exactly? */
export const filterExact = (
  actual: ListingFilter | null,
  expected: ListingFilter | null,
): boolean => canonicalFilter(actual) === canonicalFilter(expected);

export type DiffKind = "missing" | "extra" | "mismatch" | "fee_x100";

export interface FieldDiff {
  readonly field: string;
  readonly actual: unknown;
  readonly expected: unknown;
  readonly kind: DiffKind;
}

const FEE_FIELDS = new Set(["maxFeeCents", "minFeeCents"]);

/** Per-field disagreement between actual and expected (§11.2 per-field near-misses). */
export const fieldDiffs = (
  actual: ListingFilter | null,
  expected: ListingFilter | null,
): ReadonlyArray<FieldDiff> => {
  const a = toWire(actual);
  const e = toWire(expected);
  const fields = new Set([...Object.keys(a), ...Object.keys(e)]);
  const diffs: Array<FieldDiff> = [];
  for (const field of fields) {
    const av = a[field];
    const ev = e[field];
    if (JSON.stringify(av) === JSON.stringify(ev)) continue;
    let kind: DiffKind = av === undefined ? "missing" : ev === undefined ? "extra" : "mismatch";
    // The off-by-100 hazard: "$2,000" parsed as 2000 cents instead of 200000 (§11.2).
    if (
      FEE_FIELDS.has(field) && typeof av === "number" && typeof ev === "number"
      && (av === ev * 100 || av * 100 === ev)
    ) kind = "fee_x100";
    diffs.push({ field, actual: av, expected: ev, kind });
  }
  return diffs;
};
