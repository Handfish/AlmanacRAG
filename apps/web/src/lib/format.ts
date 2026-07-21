import type { FilterKey, FilterWire } from "./types";

// Pure presentation helpers. The load-bearing ones are `freshness` (§10.4 — "checked 3h
// ago", the thing the §1.1 baseline structurally cannot show) and `chipLabel` (§10.2 —
// the model's reading of "under $2,000" made visible and correctable).

/** HTML-escape untrusted text (course titles, model prose) before it touches innerHTML. */
export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
      ? "&lt;"
      : c === ">"
      ? "&gt;"
      : c === "\""
      ? "&quot;"
      : "&#39;");

/** "$415" / "$1,299.50" from cents; "—" for an unknown fee (never guessed). */
export const fee = (cents: number | null): string => {
  if (cents === null) return "—";
  const dollars = cents / 100;
  const s = dollars % 1 === 0 ? dollars.toLocaleString("en-US") : dollars.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `$${s}`;
};

/** Humanize a delivery-mode enum (`online_async` → "online, async"). */
export const delivery = (mode: string): string =>
  mode === "unknown" ? "delivery n/a" : mode.replace(/_/g, ", ");

/** Freshness (§10.4): `last_hash_comparison_at` → "checked 3h ago". A card older than a
 * threshold reads "checked N days ago" so a stale fact announces itself rather than
 * asserting. Returns `null` for an unparseable timestamp (render nothing over guessing). */
export const freshness = (checkedAtIso: string, now: number = Date.now()): string | null => {
  const then = Date.parse(checkedAtIso);
  if (Number.isNaN(then)) return null;
  const mins = Math.max(0, Math.round((now - then) / 60000));
  if (mins < 1) return "checked just now";
  if (mins < 60) return `checked ${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `checked ${hours}h ago`;
  const days = Math.round(hours / 24);
  return `checked ${days}d ago`;
};

const dollarsOf = (cents: number): string => `$${(cents / 100).toLocaleString("en-US")}`;

/** A short, human label for one filter predicate — what the editable chip says (§10.2).
 * Mirrors the server's relaxation labels so a dropped chip and its relax option read the
 * same. `value` is the wire value (dates already ISO strings). */
export const chipLabel = (key: FilterKey, value: unknown): string => {
  switch (key) {
    case "campus":
      return String(value);
    case "deliveryMode":
      return delivery(String(value));
    case "status":
      return String(value);
    case "isEvening":
      return value === true ? "evenings" : "not evenings";
    case "openForReg":
      return "open for registration";
    case "term":
    case "program":
    case "ceccUnit":
      return String(value);
    case "maxFeeCents":
      return typeof value === "number" ? `under ${dollarsOf(value)}` : "max fee";
    case "minFeeCents":
      return typeof value === "number" ? `over ${dollarsOf(value)}` : "min fee";
    case "minHours":
      return `${String(value)}+ hours`;
    case "maxHours":
      return `≤ ${String(value)} hours`;
    case "startsAfter":
      return `starts after ${String(value)}`;
    case "startsBefore":
      return `starts before ${String(value)}`;
    case "includeGone":
      return "including past sections";
    default:
      return `${String(key)}: ${String(value)}`;
  }
};

/** The filter's entries as (key, label) chips (§10.2), skipping the `includeGone` toggle
 * (a visibility flag, not a user constraint) — the visible, correctable reading. */
export const chips = (
  filter: FilterWire | null,
): ReadonlyArray<{ key: FilterKey; label: string; }> => {
  if (filter === null) return [];
  const out: Array<{ key: FilterKey; label: string; }> = [];
  for (const [k, v] of Object.entries(filter)) {
    if (v === undefined || k === "includeGone") continue;
    const key = k as FilterKey;
    out.push({ key, label: chipLabel(key, v) });
  }
  return out;
};

/** Drop one predicate from a wire filter (the chip × / relax action) — no LLM call. */
export const withoutKey = (filter: FilterWire, drop: string): FilterWire => {
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(filter)) {
    if (k === drop || v === undefined) continue;
    next[k] = v;
  }
  return next as FilterWire;
};
