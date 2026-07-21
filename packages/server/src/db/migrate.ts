import "../env.js";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgMigrator from "@effect/sql-pg/PgMigrator";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";
import { SqlAdmin } from "../adapters/sql-admin.js";

// The migration runner (plan §6.4). Runs forward-only migrations from
// `db/migrations` against SqlAdmin (:5432, session mode — ADR-I5). Invoke with
// `pnpm --filter @catalog/server migrate`.
const migrationsDirectory = NodePath.join(
  NodePath.dirname(fileURLToPath(import.meta.url)),
  "migrations",
);

const program = PgMigrator.run({
  loader: PgMigrator.fromFileSystem(migrationsDirectory),
}).pipe(
  Effect.tap((migrations) =>
    Console.log(
      migrations.length === 0
        ? "No pending migrations"
        : `Applied ${migrations.length} migration${migrations.length === 1 ? "" : "s"}: ${
          migrations.map(([id, name]) => `${id}_${name}`).join(", ")
        }`,
    )
  ),
  Effect.provide(Layer.mergeAll(SqlAdmin, NodeServices.layer)),
);

NodeRuntime.runMain(program);
