import * as NodeServices from "@effect/platform-node/NodeServices";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgMigrator from "@effect/sql-pg/PgMigrator";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Migrator from "effect/unstable/sql/Migrator";

// Boots one real Postgres for the server test suite and exports its URL. Requires
// a running Docker daemon. (effect-ai-chat harness idiom, plan §12)
//
// The image is `pgvector/pgvector:pg16`, not stock `postgres`, because migration
// set 1 runs `CREATE EXTENSION vector` (plan §5.4/§7 — extensions in the first
// migration). Stock Postgres lacks the extension files and the migration fails.
//
// Migrations are applied ONCE here, up front. The pg migrator creates
// `effect_sql_migrations` with a check-then-`CREATE TABLE` (no `IF NOT EXISTS`), so
// several suites first-running it concurrently against this shared container would
// race on the create. Applying them here makes every per-suite `PgMigrator.layer` a
// locked no-op (the table already exists, nothing pending) — no race.
let container: StartedPostgreSqlContainer;

export async function setup() {
  container = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
  const url = container.getConnectionUri();
  process.env.TEST_DB_URL = url;

  const loader = Migrator.fromGlob(import.meta.glob("../src/db/migrations/*.ts"));
  await Effect.runPromise(
    PgMigrator.run({ loader }).pipe(
      Effect.provide(
        Layer.mergeAll(PgClient.layer({ url: Redacted.make(url) }), NodeServices.layer),
      ),
    ),
  );
}

export async function teardown() {
  await container?.stop();
}
