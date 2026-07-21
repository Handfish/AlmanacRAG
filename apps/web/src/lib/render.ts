import { chips, delivery, esc, fee, freshness } from "./format";
import type { Card, FilterWire, Relaxation } from "./types";

// The §10 render layer — pure HTML builders. Nothing here invents a fact: it lays out
// `Card`s the server hydrated (§10.1), the filter as editable chips (§10.2), and the
// zero-result relaxation menu (§10.3). Interactivity is delegated in app.ts via the
// `data-*` hooks these strings emit (chip drop, relax drop, feedback).

const statusClass = (status: string): string => {
  const s = status.toLowerCase();
  if (s.includes("open") || s.includes("available")) return "ok";
  if (s.includes("full") || s.includes("closed") || s.includes("cancel")) return "warn";
  return "muted";
};

const line = (parts: ReadonlyArray<string | null>): string =>
  parts.filter((p): p is string => p !== null && p !== "").map(esc).join(" · ");

/** One result card (§10.1). Every value except `why` is server-hydrated; the button is
 * the REAL registration path (a keyword to search, or "view details"), never an invented
 * "Register" affordance (§10.1/ADR-008). Freshness is stamped from `checkedAt` (§10.4). */
export const renderCard = (card: Card): string => {
  const fresh = freshness(card.checkedAt);
  const dates = card.startsOn === null
    ? null
    : card.endsOn === null
    ? card.startsOn
    : `${card.startsOn} – ${card.endsOn}`;
  const meta = line([
    card.track,
    card.contactHours !== null ? `${card.contactHours} hours` : null,
    delivery(card.deliveryMode),
    card.campus,
    card.isEvening === true ? "evenings" : null,
  ]);
  const when = line([card.term, dates]);
  const feeStr = fee(card.totalFeeCents);

  const cta = card.registrationKeyword !== null
    ? `<span class="cta">Register: search keyword <strong>“${
      esc(card.registrationKeyword)
    }”</strong></span>`
    : "";
  const deadline = card.registrationDeadline !== null
    ? `<div class="deadline">Deadline: ${esc(card.registrationDeadline)}${
      card.registrationDeadlineRule !== null ? ` (${esc(card.registrationDeadlineRule)})` : ""
    }</div>`
    : "";
  const why = card.why.trim().length > 0
    ? `<blockquote class="why">${esc(card.why)}</blockquote>`
    : "";

  return `
    <article class="card">
      <header>
        <h3>${esc(card.courseTitle)}</h3>
        ${
    card.externalCourseId !== null ? `<span class="code">${esc(card.externalCourseId)}</span>` : ""
  }
      </header>
      ${meta ? `<div class="meta">${meta}</div>` : ""}
      <div class="when">${when ? `${when} · ` : ""}<strong class="fee">${esc(feeStr)}</strong></div>
      <div class="status">
        <span class="dot ${statusClass(card.status)}"></span>${esc(card.status)}
        ${fresh !== null ? `<span class="fresh">${esc(fresh)}</span>` : ""}
      </div>
      ${why}
      ${cta}
      ${deadline}
      <a class="details" href="${
    esc(card.detailUrl)
  }" target="_blank" rel="noopener">View details →</a>
    </article>`;
};

export const renderCards = (cards: ReadonlyArray<Card>): string =>
  cards.length === 0 ? "" : `<div class="cards">${cards.map(renderCard).join("")}</div>`;

/** The editable filter chips (§10.2) — the model's reading, made correctable. Each chip
 * carries `data-key` so a click on × drops that predicate and re-runs with NO LLM call. */
export const renderChips = (filter: FilterWire | null): string => {
  const cs = chips(filter);
  if (cs.length === 0) return "";
  const items = cs
    .map((c) =>
      `<button type="button" class="chip" data-drop="${esc(c.key)}" title="remove this filter">${
        esc(c.label)
      }<span class="x">×</span></button>`
    )
    .join("");
  return `<div class="chips"><span class="chips-label">Filters:</span>${items}
    <span class="chips-hint">click × to drop one — re-runs without the model</span></div>`;
};

/** The zero-result relaxation menu (§10.3): "closest matches — drop one?". Each option
 * re-runs the filter with that single predicate removed. Only shown when the current
 * filter matched nothing but a single drop would surface results. */
export const renderRelax = (relaxations: ReadonlyArray<Relaxation>): string => {
  if (relaxations.length === 0) return "";
  const rows = relaxations
    .map((r) =>
      `<button type="button" class="relax-opt" data-drop="${esc(r.key)}">
        <span class="relax-label">drop <strong>${esc(r.label)}</strong></span>
        <span class="relax-count">${r.count} result${r.count === 1 ? "" : "s"}</span>
      </button>`
    )
    .join("");
  return `<div class="relax">
    <p class="relax-head">No courses match all your filters. Closest matches — drop one?</p>
    ${rows}
  </div>`;
};

export const renderProse = (prose: string): string =>
  prose.trim().length === 0 ? "" : `<p class="prose">${esc(prose)}</p>`;

export const renderWindow = (
  window: { observingSince: string; termsObserved: number; },
): string =>
  `<p class="window">Observing this catalog since <strong>${
    esc(window.observingSince)
  }</strong> — ${window.termsObserved} term${
    window.termsObserved === 1 ? "" : "s"
  } seen. Facts read live from the database; the assistant never retypes a number.</p>`;

export const renderFollowups = (followups: ReadonlyArray<string>): string => {
  if (followups.length === 0) return "";
  const items = followups
    .map((f) => `<button type="button" class="followup" data-ask="${esc(f)}">${esc(f)}</button>`)
    .join("");
  return `<div class="followups"><span class="followups-label">Try:</span>${items}</div>`;
};

/** The feedback row (§5.5). A thumbs-down promotes the question to the review queue; the
 * `data-message` id ties the vote to the persisted turn. */
export const renderFeedback = (messageId: string): string =>
  `<div class="feedback" data-message="${esc(messageId)}">
    <span>Was this helpful?</span>
    <button type="button" class="fb" data-rating="1" aria-label="thumbs up">👍</button>
    <button type="button" class="fb" data-rating="-1" aria-label="thumbs down">👎</button>
    <span class="fb-note" role="status"></span>
  </div>`;
