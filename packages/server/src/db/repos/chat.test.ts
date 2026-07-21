import { Answer, type Card, CardRef } from "@catalog/domain/answer";
import { ListingFilter } from "@catalog/domain/filter";
import type { CourseId, ListingId } from "@catalog/domain/ids";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgMigrator from "@effect/sql-pg/PgMigrator";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Migrator from "effect/unstable/sql/Migrator";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { PgTest, withTransactionRollback } from "../pg-test.js";
import {
  acquireRun,
  ensureSession,
  insertAssistantMessage,
  insertFeedback,
  insertUserMessage,
  promoteFeedbackToEval,
  releaseRun,
} from "./chat.js";

// The chat transcript + single-active-run guard (§5.5, §10) against a real testcontainer.
// The load-bearing behavior is the DB-enforced lock: two concurrent acquires for one
// session must yield exactly one holder (plan §10), and the transcript stores card_ids +
// echoed filter, never card contents (§5.5).

const TestLive = PgMigrator.layer({
  loader: Migrator.fromGlob(import.meta.glob("../migrations/*.ts")),
}).pipe(Layer.provide(NodeServices.layer), Layer.orDie, Layer.provideMerge(PgTest));

const SESSION = "11111111-1111-1111-1111-111111111111";

const card = (id: string): Card => ({
  listingId: id as ListingId,
  courseId: "1" as CourseId,
  courseTitle: "X",
  externalCourseId: null,
  track: null,
  contactHours: null,
  deliveryMode: "online_sync",
  campus: "Newark",
  term: null,
  startsOn: null,
  endsOn: null,
  isEvening: null,
  scheduleText: null,
  status: "open",
  totalFeeCents: null,
  fees: [],
  registrationDeadline: null,
  registrationDeadlineRule: null,
  registrationUrl: null,
  registrationKeyword: null,
  detailUrl: "https://x",
  checkedAt: "2026-07-21T00:00:00Z",
  why: "w",
});

describe("chat repo", () => {
  it.layer(TestLive, { timeout: "90 seconds" })("transcript + single-active-run", (it) => {
    it.effect("only one concurrent acquire wins; release lets the next in (plan §10)", () =>
      withTransactionRollback(Effect.gen(function*() {
        yield* ensureSession(SESSION);
        const a = yield* acquireRun(SESSION, "token-a");
        const b = yield* acquireRun(SESSION, "token-b");
        expect(Option.isSome(a)).toBe(true);
        expect(Option.isNone(b)).toBe(true); // a already holds it

        // wrong token cannot release someone else's lock
        yield* releaseRun(SESSION, "token-b");
        const cStill = yield* acquireRun(SESSION, "token-c");
        expect(Option.isNone(cStill)).toBe(true);

        // the holder releases → the lock frees
        yield* releaseRun(SESSION, "token-a");
        const d = yield* acquireRun(SESSION, "token-d");
        expect(Option.isSome(d)).toBe(true);
      })));

    it.effect("persists the transcript as card_ids + echoed filter, not card contents", () =>
      withTransactionRollback(Effect.gen(function*() {
        const sql = yield* SqlClient;
        yield* ensureSession(SESSION);
        yield* insertUserMessage(SESSION, "evening courses in Newark");

        const answer = new Answer({
          prose: "Two match.",
          cards: [
            new CardRef({ listingId: "10" as ListingId, why: "a" }),
            new CardRef({ listingId: "20" as ListingId, why: "b" }),
          ],
          filter: new ListingFilter({ campus: "Newark", isEvening: true }),
          followups: [],
        });
        const messageId = yield* insertAssistantMessage(
          SESSION,
          answer,
          [card("10"), card("20")],
          false,
          "trace-xyz",
        );

        const rows = yield* sql<{
          role: string;
          prose: string | null;
          cardIds: ReadonlyArray<string>;
          filter: unknown;
          refused: boolean;
        }>`
          SELECT role, prose, card_ids::text[] AS card_ids, filter, refused
          FROM chat_message WHERE id = ${messageId}`;
        const row = rows[0]!;
        expect(row.role).toBe("assistant");
        expect(row.prose).toBe("Two match.");
        expect(row.cardIds).toEqual(["10", "20"]); // ids, not contents (§5.5)
        expect(row.refused).toBe(false);
        expect(row.filter).toMatchObject({ campus: "Newark", isEvening: true });

        // feedback closes the loop (§5.5): a thumbs-down attaches to the message
        yield* insertFeedback(messageId, -1, "wrong campus");
        const fb = yield* sql<{ rating: number; note: string | null; }>`
          SELECT rating, note FROM feedback WHERE message_id = ${messageId}`;
        expect(fb[0]!.rating).toBe(-1);
        expect(fb[0]!.note).toBe("wrong campus");
      })));

    it.effect("thumbs-down promotes the question to a CANDIDATE eval_item (§5.5)", () =>
      withTransactionRollback(Effect.gen(function*() {
        const sql = yield* SqlClient;
        yield* ensureSession(SESSION);
        yield* insertUserMessage(SESSION, "evening courses in Newark under $2000");
        const answer = new Answer({
          prose: "Two match.",
          cards: [],
          filter: new ListingFilter({ campus: "Newark", isEvening: true }),
          followups: [],
        });
        const messageId = yield* insertAssistantMessage(SESSION, answer, [], false, null);
        yield* insertFeedback(messageId, -1, "missed the fee");

        const promoted = yield* promoteFeedbackToEval(messageId, "missed the fee");
        expect(Option.isSome(promoted)).toBe(true);
        const itemId = Option.getOrThrow(promoted);

        // The promoted item is a CANDIDATE: reviewed_* NULL keeps it out of the graded
        // golden set (the runner + seed both scope to reviewed_at IS NOT NULL).
        const item = yield* sql<{
          question: string;
          shape: string;
          rubric: string | null;
          reviewedAt: string | null;
          reviewedBy: string | null;
        }>`
          SELECT question, shape, rubric,
                 reviewed_at::text AS reviewed_at, reviewed_by
          FROM eval_item WHERE id = ${itemId}`;
        expect(item[0]!.question).toBe("evening courses in Newark under $2000");
        expect(item[0]!.shape).toBe("filtered"); // inferred from the stored filter
        expect(item[0]!.rubric).toBe("missed the fee");
        expect(item[0]!.reviewedAt).toBeNull();
        expect(item[0]!.reviewedBy).toBeNull();

        // The feedback row records the promotion (idempotent: a re-promote is a no-op).
        const fb = yield* sql<{ promotedToEvalItem: string | null; }>`
          SELECT promoted_to_eval_item::text AS promoted_to_eval_item
          FROM feedback WHERE message_id = ${messageId}`;
        expect(fb[0]!.promotedToEvalItem).toBe(itemId);

        const again = yield* promoteFeedbackToEval(messageId, "missed the fee");
        expect(Option.getOrNull(again)).toBe(itemId); // same item, no duplicate
        const count = yield* sql<{ n: number; }>`
          SELECT count(*)::int AS n FROM eval_item
          WHERE question = 'evening courses in Newark under $2000'`;
        expect(count[0]!.n).toBe(1);
      })));

    it.effect("a refused turn promotes as shape 'unanswerable' (§5.5/§10.6)", () =>
      withTransactionRollback(Effect.gen(function*() {
        const sql = yield* SqlClient;
        yield* ensureSession(SESSION);
        yield* insertUserMessage(SESSION, "does astrophysics run every year?");
        const answer = new Answer({
          prose: "I can't tell yet.",
          cards: [],
          filter: null,
          followups: [],
        });
        const messageId = yield* insertAssistantMessage(SESSION, answer, [], true, null);
        yield* insertFeedback(messageId, -1, null);
        const promoted = yield* promoteFeedbackToEval(messageId, null);
        const itemId = Option.getOrThrow(promoted);
        const item = yield* sql<{ shape: string; }>`
          SELECT shape FROM eval_item WHERE id = ${itemId}`;
        expect(item[0]!.shape).toBe("unanswerable");
      })));
  });
});
