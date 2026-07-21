import * as PgClient from "@effect/sql-pg/PgClient";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { pgConfig } from "./pg-config.js";

// Pooled client — EVERY runtime query goes here (ADR-I5). In production this URL
// points at PgBouncer (:6432, transaction pooling).
//
// ADR-I5 originally called for `prepare:false / fetch_types:false`; those options
// belonged to the `postgres` driver. @effect/sql-pg beta.99 wraps node-`pg`,
// which does not keep a client-side prepared-statement cache to invalidate under
// transaction pooling — so the "stale prepared statement" failure (§14) is
// structurally absent here. The admin/runtime split is still enforced by URL.
export const SqlLive = Layer.unwrap(
  Effect.gen(function*() {
    const url = yield* Config.redacted("POSTGRES_URL");
    return PgClient.layer({
      url,
      maxConnections: 10,
      idleTimeout: "30 seconds",
      ...pgConfig,
    });
  }),
).pipe(Layer.orDie);
