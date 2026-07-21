import * as Effect from "effect/Effect";
import { SqlClient } from "effect/unstable/sql/SqlClient";

// system_epoch (§5.3.4). Starting the clock — the irreversible M1 act. The single
// row records when observation began, so §10.6 can later refuse temporal claims
// the window can't support. Seeded once; every subsequent crawl is a no-op here.
// `terms_observed` stays 0 until Phase 7 counts distinct observed terms.

export const ensureEpoch = Effect.gen(function*() {
  const sql = yield* SqlClient;
  yield* sql`
    INSERT INTO system_epoch (id, observing_since)
    VALUES (1, now())
    ON CONFLICT (id) DO NOTHING
  `;
});

export interface Epoch {
  readonly observingSince: string;
  readonly termsObserved: number;
}

export const getEpoch = Effect.gen(function*() {
  const sql = yield* SqlClient;
  // Result keys are camelCase — pgConfig transformResultNames snake→camel.
  const rows = yield* sql<{ observingSince: string; termsObserved: number; }>`
    SELECT observing_since, terms_observed FROM system_epoch WHERE id = 1
  `;
  const row = rows[0];
  return row === undefined
    ? null
    : { observingSince: row.observingSince, termsObserved: row.termsObserved } satisfies Epoch;
});
