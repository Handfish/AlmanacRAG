import * as Schema from "effect/Schema";
import type { Campus, DeliveryMode, Status } from "./course.js";
import { ListingFilter } from "./filter.js";
import { ListingId } from "./ids.js";
import type { CourseId } from "./ids.js";

// The two §1/§4.2 contracts, plus the hydrated card the server renders. This is
// "the most load-bearing code in the project" (§4.2): what the model is allowed to
// EMIT (`CardRef`/`Answer`, Schema.Class — decoded from model output) vs. what the
// server READS from Postgres (`Card`, a plain hydrated row like `FilteredListing`).
//
// ADR-008 is enforced structurally here: `Answer` carries no price, date, or status
// field, so the model *cannot* return a fact. It returns `listingId`s and one line of
// prose per card; the KnowledgeBase `hydrate` step turns each `listingId` into a full
// `Card` by reading the live `listing` + `listing_fee` + `course` rows (§10.4). That
// is the whole mechanism. The §11.2 test asserts no factual literal ever appears in a
// `CardRef` (asserted, not scored).

/** What the model may emit per result: a pointer plus one measured line (§4.2). */
export class CardRef extends Schema.Class<CardRef>("CardRef")({
  listingId: ListingId,
  why: Schema.String, // one line. Prose — may drift, is measured (§11.2), never trusted for facts
}) {}

/** The model's whole answer (§4.2). `prose` is connective tissue; `cards` point at
 * listings; `filter` echoes the router's reading as editable chips (§10.2);
 * `followups` are suggested next questions. No factual field — by construction. */
export class Answer extends Schema.Class<Answer>("Answer")({
  prose: Schema.String,
  cards: Schema.Array(CardRef),
  filter: Schema.NullOr(ListingFilter),
  followups: Schema.Array(Schema.String),
}) {}

/** One fee line, mirrored from `listing_fee` (§5.2.4) — every line, `isTotal` on the
 * "Total Fees" row. Never "the first dollar figure" (§9.2). */
export type CardFee = {
  readonly label: string;
  readonly amountCents: number;
  readonly isTotal: boolean;
};

/** A fully hydrated result card (§10.1). Everything except `why` is read from
 * Postgres at RENDER time (§10.4) — `status` and fees are never frozen into a message
 * row. `checkedAt` is when the fact was last verified against the source, surfaced as
 * "checked 3h ago". `why` is the ONLY model-authored text on the card, carried over
 * from the matching `CardRef` and measured (§11.2), not trusted. A plain row (like
 * `FilteredListing`), not a Schema.Class — it is built by the server, never decoded. */
export type Card = {
  readonly listingId: ListingId;
  readonly courseId: CourseId;
  readonly courseTitle: string;
  readonly externalCourseId: string | null;
  readonly track: string | null;
  readonly contactHours: number | null;
  readonly deliveryMode: DeliveryMode;
  readonly campus: Campus;
  readonly term: string | null;
  readonly startsOn: string | null; // ISO YYYY-MM-DD
  readonly endsOn: string | null;
  readonly isEvening: boolean | null;
  readonly scheduleText: string | null;
  readonly status: Status;
  readonly totalFeeCents: number | null;
  readonly fees: ReadonlyArray<CardFee>;
  readonly registrationDeadline: string | null; // ISO YYYY-MM-DD
  readonly registrationDeadlineRule: string | null;
  readonly registrationUrl: string | null;
  readonly registrationKeyword: string | null;
  readonly detailUrl: string;
  readonly checkedAt: string; // ISO timestamp of the last hash comparison / re-observation
  readonly why: string; // the CardRef's line, hydrated onto the card
};

/** The observation window (§5.3.4/§10.6) — how long this catalog has been watched.
 * Attached to every answer so §10.6 can refuse a recurrence claim the window can't
 * support ("I've only been watching since July 2026 — I've seen one term"). */
export type ObservationWindow = {
  readonly observingSince: string; // ISO date the clock started (system_epoch)
  readonly termsObserved: number;
};
