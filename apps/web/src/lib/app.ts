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

// ── cold-start awareness (§10.5) ──────────────────────────────────────────────────
// Cloud Run scales the API to zero, so the first request after idle pays a cold-start
// penalty (container boot + Postgres wake). We surface that *accurately* instead of
// guessing from latency: `/health` does no DB/LLM work, so a slow health response — or
// one whose reported `uptime` is near zero — means the container is booting. A genuinely
// slow *warm* request (a chat call fanning out to several model requests) is therefore
// never mislabelled as a cold start.
const WARM_TTL_MS = 10 * 60_000; // trust a confirmed 200 this long (Cloud Run keeps ~15m warm)
const HEALTH_SLOW_MS = 700; // a warm, DB-free /health answers well under this
const COLD_UPTIME_S = 20; // a health hit reporting less uptime is a freshly-booted container

const COLD_TEXT =
  "❄ COLD STARTING — the server was asleep and is waking up. This first request can take up to a minute…";

let lastWarmAt = 0; // ms timestamp of the last confirmed-up response (0 = never)
let runSeq = 0; // bumped on every busy transition; guards async probes against a stale run

/** True while a recent 200 still vouches for a warm container. */
const knownWarm = (): boolean => lastWarmAt !== 0 && Date.now() - lastWarmAt < WARM_TTL_MS;
/** Record that the container just answered — any 200 proves it is up. */
const markWarm = (): void => {
  lastWarmAt = Date.now();
};

const setStatus = (text: string, cold: boolean): void => {
  const status = el("status-line");
  status.textContent = text;
  status.classList.toggle("cold", cold);
};

/** Show/hide the prominent page-load wake banner (#wake-banner). Distinct from the tiny
 * status line: a cold container boots for several seconds, so on page load we surface that
 * as a banner the user can't miss rather than a sub-second flip by the Ask button. Optional
 * markup — a missing banner just no-ops so the island never hard-fails. */
const showWake = (show: boolean): void => {
  const banner = document.getElementById("wake-banner");
  if (banner === null) return;
  banner.classList.toggle("show", show);
  banner.setAttribute("aria-hidden", show ? "false" : "true");
};

/** Probe `/health` concurrently with an in-flight run (`seq`) to decide, accurately,
 * whether the wait is a cold start. Only touches the status line while `seq` is still the
 * active run, so a probe that resolves after its run finished never clobbers a later view.
 * `warmText` is what to show if the container turns out to be warm after all. */
const probeCold = async (seq: number, warmText: string): Promise<void> => {
  const slow = setTimeout(() => {
    if (seq === runSeq) setStatus(COLD_TEXT, true); // health itself is slow ⇒ booting
  }, HEALTH_SLOW_MS);
  try {
    const { uptime } = await api.health();
    markWarm();
    if (seq !== runSeq) return; // the run already finished — leave the DOM alone
    if (uptime < COLD_UPTIME_S) setStatus(COLD_TEXT, true); // confirmed fresh container
    else setStatus(warmText, false); // warm after all — retract any premature banner
  } catch {
    // Ignore: the real request will surface any error; leave the banner as-is.
  } finally {
    clearTimeout(slow);
  }
};

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

  runSeq += 1; // invalidate any probe (or prewarm) from the previous run
  showWake(false); // a user run takes over — the status line owns cold state from here
  if (!busy) {
    setStatus("", false);
    return;
  }
  const warmText = "thinking…";
  setStatus(warmText, false);
  // Unless a recent 200 already vouches for the container, find out for sure — concurrently,
  // so the banner reflects the *server's* state, not how long the LLM happens to take.
  if (!knownWarm()) void probeCold(runSeq, warmText);
};

/** Whether a filter carries any user predicate (so a 0-result state is worth relaxing). */
const hasPredicate = (filter: FilterWire | null): boolean =>
  filter !== null && Object.keys(filter).some((k) => k !== "includeGone");

const askChat = async (question: string): Promise<void> => {
  setBusy(true);
  try {
    const res = await api.chat(question, sessionId);
    markWarm(); // a 200 proves the container is up — no cold banner on the next ask
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
    markWarm(); // container answered — keep the cold banner off subsequent runs
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

/** Proactively wake the API on page load. On a cold container this surfaces the prominent
 * wake banner before the user even asks, and the wake finishes while they read the page —
 * so their first question lands on a warm server. Because prewarm absorbs the cold start,
 * the banner shown *here* (not on the eventual ask, which is warm by then) is the only place
 * the user reliably sees a cold start — hence the loud banner rather than the status line.
 * `seq` claims the current run so a submitted question (which bumps `runSeq`) cleanly takes
 * over and dismisses the banner. */
const prewarm = async (): Promise<void> => {
  const seq = (runSeq += 1);
  const slow = setTimeout(() => {
    if (seq === runSeq) showWake(true); // /health slow ⇒ container booting — say so, loudly
  }, HEALTH_SLOW_MS);
  try {
    const { uptime } = await api.health();
    markWarm();
    // Final banner state = is this container still cold? A freshly-booted one (uptime < 20s,
    // §10.5) may answer /health fast yet still be warming Postgres, so keep warning; a long-up
    // one retracts any banner the slow timer raised. It clears for good on the user's ask
    // (setBusy → showWake(false)), which lands warm.
    if (seq === runSeq) showWake(uptime < COLD_UPTIME_S);
  } catch {
    if (seq === runSeq) showWake(false); // no health → the real request will surface any error
  } finally {
    clearTimeout(slow);
  }
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
  void prewarm();
};
