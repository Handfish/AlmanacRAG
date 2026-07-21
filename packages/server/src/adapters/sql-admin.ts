import * as PgClient from "@effect/sql-pg/PgClient";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { pgConfig } from "./pg-config.js";

// Direct client — DDL / migrations ONLY (ADR-I5). In production this URL points
// at Postgres directly (:5432, session mode), NOT PgBouncer, because migrations
// need a stable session. Only `db/migrate.ts` provides this layer.
export const SqlAdmin = Layer.unwrap(
  Effect.gen(function*() {
    const url = yield* Config.redacted("POSTGRES_ADMIN_URL");
    return PgClient.layer({
      url,
      maxConnections: 2,
      ...pgConfig,
    });
  }),
).pipe(Layer.orDie);
