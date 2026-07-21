import "./env.js";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AnswererGeminiLive } from "./adapters/answerer-gemini.js";
import { EmbedderGeminiLive } from "./adapters/embedder-gemini.js";
import { PgKnowledgeBaseLive } from "./adapters/pg-knowledge-base.js";
import { RouterGeminiLive } from "./adapters/router-gemini.js";
import { SqlLive } from "./adapters/sql-live.js";
import * as Agent from "./agent/answer-agent.js";

// The Phase-5 exit criterion, made runnable (§16 M5): ask one question, watch the router
// → retrieval → answer → live-hydrate path produce a grounded answer with hydrated cards.
// Facts on the cards are read from Postgres AFTER generation (ADR-008); the model authored
// only prose + one `why` line per card.
//   GEMINI_API_KEY=… CHAT_Q="evening cybersecurity courses in Newark under $2000" \
//     pnpm --filter @catalog/server chat
const program = Effect.gen(function*() {
  const question = yield* Config.string("CHAT_Q").pipe(
    Config.withDefault("What grant writing courses are offered?"),
  );

  const result = yield* Agent.run(question, new Date());

  yield* Console.log(`Q: ${question}\n`);
  yield* Console.log(`refused: ${result.refused}`);
  yield* Console.log(
    `filter: ${result.answer.filter === null ? "(none)" : JSON.stringify(result.answer.filter)}`,
  );
  yield* Console.log(`\nprose: ${result.answer.prose}\n`);
  yield* Console.log(`cards (${result.cards.length}, live-hydrated):`);
  for (const [i, c] of result.cards.entries()) {
    const fee = c.totalFeeCents === null ? "n/a" : `$${(c.totalFeeCents / 100).toFixed(0)}`;
    const hrs = c.contactHours === null ? "" : ` · ${c.contactHours}h`;
    const dates = c.startsOn === null ? "" : ` · ${c.startsOn}${c.endsOn ? `–${c.endsOn}` : ""}`;
    yield* Console.log(
      `  ${
        i + 1
      }. ${c.courseTitle} [${c.status}]${hrs} · ${c.campus} · ${c.deliveryMode}${dates} · ${fee} · checked ${c.checkedAt}`,
    );
    yield* Console.log(`     why: ${c.why}`);
  }
  if (result.answer.followups.length > 0) {
    yield* Console.log(`\nfollow-ups: ${result.answer.followups.join(" · ")}`);
  }
  yield* Console.log(
    `\nobservation window: since ${result.window.observingSince}, ${result.window.termsObserved} term(s)`,
  );
});

const RetrievalLive = PgKnowledgeBaseLive.pipe(Layer.provide(EmbedderGeminiLive));
const AgentLive = Layer.mergeAll(RouterGeminiLive, RetrievalLive, AnswererGeminiLive);

NodeRuntime.runMain(program.pipe(Effect.provide(AgentLive), Effect.provide(SqlLive)));
