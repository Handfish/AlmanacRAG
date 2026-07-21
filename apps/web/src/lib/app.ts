import * as api from "./api";
import { withoutKey } from "./format";
import {
  renderCards,
  renderChips,
  renderFeedback,
  renderFollowups,
  renderProse,
  renderRelax,
  renderWindow,
} from "./render";
import type { Card, FilterWire, ObservationWindow, Relaxation } from "./types";

// The client controller (§10). Three flows share one <section id="answer">:
//   • ask       — the full LLM path (POST /chat): prose + chips + live cards + window.
//   • chip drop — re-run a filter with NO model call (POST /search → /hydrate, §10.2).
//   • relax     — a zero-result drop-one option (§10.3), same no-LLM re-run.
// A grounded refusal (§10.6) is just a chat answer with no cards. State is minimal:
// the session id (single-active-run), the current filter (for chip edits), and the last
// observation window (reused on no-LLM re-runs, which don't re-query it).

interface View {
  readonly mode: "chat" | "filter";
  readonly heading: string;
  readonly filter: FilterWire | null;
  readonly cards: ReadonlyArray<Card>;
  readonly relaxations: ReadonlyArray<Relaxation>;
  readonly window: ObservationWindow | null;
  readonly followups: ReadonlyArray<string>;
  readonly messageId: string | null;
}

let sessionId: string | undefined;
let currentFilter: FilterWire | null = null;
let lastWindow: ObservationWindow | null = null;

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing #${id}`);
  return node as T;
};

const answerEl = (): HTMLElement => el("answer");

const paint = (view: View): void => {
  const heading = view.mode === "chat"
    ? renderProse(view.heading)
    : `<p class="prose note">${view.heading}</p>`;
  answerEl().innerHTML = `
    ${heading}
    ${renderChips(view.filter)}
    ${renderRelax(view.relaxations)}
    ${
    view.cards.length === 0 && view.relaxations.length === 0 && view.mode === "filter"
      ? `<p class="empty">No matching sections.</p>`
      : renderCards(view.cards)
  }
    ${view.followups.length > 0 ? renderFollowups(view.followups) : ""}
    ${view.messageId !== null ? renderFeedback(view.messageId) : ""}
    ${view.window !== null ? renderWindow(view.window) : ""}
  `;
};

const setBusy = (busy: boolean): void => {
  el<HTMLButtonElement>("ask-btn").disabled = busy;
  el<HTMLInputElement>("q").disabled = busy;
  el("status-line").textContent = busy ? "thinking…" : "";
};

/** Whether a filter carries any user predicate (so a 0-result state is worth relaxing). */
const hasPredicate = (filter: FilterWire | null): boolean =>
  filter !== null && Object.keys(filter).some((k) => k !== "includeGone");

const askChat = async (question: string): Promise<void> => {
  setBusy(true);
  try {
    const res = await api.chat(question, sessionId);
    sessionId = res.sessionId;
    currentFilter = res.filter;
    lastWindow = res.window;

    // A filtered answer that came back empty is the §10.3 zero-result case — offer drops.
    let relaxations: ReadonlyArray<Relaxation> = [];
    if (res.cards.length === 0 && hasPredicate(res.filter)) {
      relaxations = (await api.relax(res.filter as FilterWire)).relaxations;
    }

    paint({
      mode: "chat",
      heading: res.prose,
      filter: res.filter,
      cards: res.cards,
      relaxations,
      window: res.window,
      followups: res.followups,
      messageId: res.messageId,
    });
  } catch (err) {
    answerEl().innerHTML = `<p class="error">Something went wrong: ${
      String(err instanceof Error ? err.message : err)
    }. Is the API server running on :3000?</p>`;
  } finally {
    setBusy(false);
  }
};

/** Re-run the current filter minus one predicate — the §10.2 chip edit / §10.3 relax
 * option. No LLM call: /search compiles the filter to SQL, /hydrate returns live cards. */
const rerunFilter = async (filter: FilterWire): Promise<void> => {
  setBusy(true);
  try {
    currentFilter = filter;
    const { listings } = await api.search(filter);
    const ids = listings.map((l) => l.listingId).slice(0, 12);
    const cards = ids.length > 0 ? (await api.hydrate(ids)).cards : [];

    let relaxations: ReadonlyArray<Relaxation> = [];
    if (cards.length === 0 && hasPredicate(filter)) {
      relaxations = (await api.relax(filter)).relaxations;
    }

    paint({
      mode: "filter",
      heading: "Filtered results — re-run without the model (§10.2).",
      filter,
      cards,
      relaxations,
      window: lastWindow,
      followups: [],
      messageId: null,
    });
  } catch (err) {
    el("status-line").textContent = `re-run failed: ${
      String(err instanceof Error ? err.message : err)
    }`;
  } finally {
    setBusy(false);
  }
};

const onFeedback = async (
  messageId: string,
  rating: 1 | -1,
  noteEl: HTMLElement,
): Promise<void> => {
  try {
    const res = await api.feedback(messageId, rating);
    noteEl.textContent = rating === 1
      ? "thanks!"
      : res.promotedEvalItemId !== null
      ? "logged — added to the eval review queue"
      : "logged";
  } catch {
    noteEl.textContent = "couldn't record that";
  }
};

// ── delegated events on the answer section ────────────────────────────────────────
const onAnswerClick = (event: MouseEvent): void => {
  const target = (event.target as HTMLElement).closest("button");
  if (target === null) return;

  // Chip × (§10.2) and relax option (§10.3) both drop one predicate and re-run.
  const drop = target.getAttribute("data-drop");
  if (drop !== null && currentFilter !== null) {
    void rerunFilter(withoutKey(currentFilter, drop));
    return;
  }

  // Followup chip → ask it as a new question.
  const ask = target.getAttribute("data-ask");
  if (ask !== null) {
    el<HTMLInputElement>("q").value = ask;
    void askChat(ask);
    return;
  }

  // Feedback thumbs.
  const rating = target.getAttribute("data-rating");
  if (rating !== null) {
    const row = target.closest(".feedback") as HTMLElement | null;
    const messageId = row?.getAttribute("data-message");
    const noteEl = row?.querySelector(".fb-note") as HTMLElement | null;
    if (messageId != null && noteEl !== null) {
      void onFeedback(messageId, rating === "1" ? 1 : -1, noteEl);
    }
  }
};

/** Fill the input and run the ask flow — shared by the form, the example prompts, and
 * the answer's followup chips. No synthetic form-submit dispatch (that was fragile and
 * could navigate); everything calls one path. */
const ask = (question: string): void => {
  const q = question.trim();
  if (q.length === 0) return;
  el<HTMLInputElement>("q").value = q;
  void askChat(q);
};

export const boot = (): void => {
  el<HTMLFormElement>("ask").addEventListener("submit", (event) => {
    event.preventDefault(); // never let the form do a native GET navigation (page refresh)
    ask(el<HTMLInputElement>("q").value);
  });
  // Example prompts run the same flow directly (they are type="button", never submit).
  document.querySelectorAll<HTMLButtonElement>(".example").forEach((btn) => {
    btn.addEventListener("click", () => ask(btn.dataset.ask ?? ""));
  });
  answerEl().addEventListener("click", onAnswerClick);
};
