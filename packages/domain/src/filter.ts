import * as Schema from "effect/Schema";
import { Campus, DeliveryMode, Status } from "./course.js";

// The §8 contract (architecture.md §4.2) — what the router is allowed to ask the
// catalog for. `filter_listings` (Phase 3) compiles this to ONE parameterized SQL
// statement (retrieval/filter-listings.ts): no injection surface, no hallucinated
// columns, no unbounded scan. It round-trips to the UI as editable chips (§10.2), so
// the model's interpretation of "under $2,000" / "evenings" / "in Newark" is visible
// and correctable rather than silently applied.
//
// Every field is `optional`: an absent key means "don't constrain on this", never a
// NULL match. `includeGone` defaults to false — a listing whose page has disappeared
// (§5.3) is hidden from live results unless the caller explicitly asks for history.
export class ListingFilter extends Schema.Class<ListingFilter>("ListingFilter")({
  campus: Schema.optional(Campus),
  program: Schema.optional(Schema.String),
  ceccUnit: Schema.optional(Schema.String),
  term: Schema.optional(Schema.String),
  startsBefore: Schema.optional(Schema.DateFromString),
  startsAfter: Schema.optional(Schema.DateFromString),
  maxFeeCents: Schema.optional(Schema.Int),
  minFeeCents: Schema.optional(Schema.Int),
  deliveryMode: Schema.optional(DeliveryMode),
  isEvening: Schema.optional(Schema.Boolean),
  status: Schema.optional(Status),
  openForReg: Schema.optional(Schema.Boolean), // registration_deadline is null or >= today
  minHours: Schema.optional(Schema.Number),
  maxHours: Schema.optional(Schema.Number),
  includeGone: Schema.optional(Schema.Boolean), // default false — see §5.3
}) {}
