import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgMigrator from "@effect/sql-pg/PgMigrator";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";
import { SqlClient } from "effect/unstable/sql/SqlClient";
import { PgTest, withTransactionRollback } from "./pg-test.js";

// The Phase-0 exit criterion, as a test: run the migrations against a real
// Postgres testcontainer, then prove a pooled SqlClient (same layer shape as
// SqlLive) can query. Requires Docker.

const TestMigrationLayer = PgMigrator.layer({
  loader: Migrator.fromGlob(import.meta.glob("./migrations/*.ts")),
}).pipe(
  Layer.provide(NodeServices.layer),
  Layer.orDie,
);

const TestLive = TestMigrationLayer.pipe(Layer.provideMerge(PgTest));

describe("spine", () => {
  it.layer(TestLive, { timeout: "60 seconds" })("migration + SqlClient", (it) => {
    it.effect("latest migration applied: app_meta advanced to schema_phase=4", () =>
      withTransactionRollback(
        Effect.gen(function*() {
          const sql = yield* SqlClient;
          const rows = yield* sql<{ value: string; }>`
            SELECT value FROM app_meta WHERE key = 'schema_phase'
          `;
          expect(rows.length).toBe(1);
          // Bumped by each migration set: '1' (0002) → '2' (0003 typed layer) →
          // '3' (0004 semantic layer) → '4' (0005 eval harness) →
          // '5' (0006 chat — chat_session/chat_message/feedback).
          expect(rows[0]?.value).toBe("5");
        }),
      ));

    it.effect("pooled SqlClient round-trips a trivial query", () =>
      Effect.gen(function*() {
        const sql = yield* SqlClient;
        const rows = yield* sql<{ n: number; }>`SELECT 1 AS n`;
        expect(rows[0]?.n).toBe(1);
      }));
  });
});
