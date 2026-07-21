import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";

// App-level configuration (plan §6.3). The two Postgres URLs are read directly by
// the SQL layers via `Config.redacted` (ADR-I5); this service holds everything
// else. Secrets stay wrapped in `Redacted` — unwrap only at the vendor boundary.
export type AppConfigShape = {
  readonly port: number;
  readonly otlpEndpoint: string;
  readonly anthropicApiKey: Redacted.Redacted<string> | undefined;
  readonly ceccIndexUrl: string;
};

const make = Effect.gen(function*() {
  const raw = yield* Config.all({
    port: Config.withDefault(Config.port("PORT"), 3000),
    otlpEndpoint: Config.withDefault(
      Config.string("OTEL_EXPORTER_OTLP_ENDPOINT"),
      "http://localhost:4318",
    ),
    anthropicApiKey: Config.option(Config.redacted("ANTHROPIC_API_KEY")),
    // The catalog index the Phase-1 re-crawl discovers detail links from
    // (`a.chart` → courseDisplay.cfm?schID=…). Confirmed by the catalog owner.
    ceccIndexUrl: Config.withDefault(
      Config.string("CECC_INDEX_URL"),
      "https://ce-catalog.rutgers.edu/searchResults.cfm?searchId=1",
    ),
  });

  return {
    port: raw.port,
    otlpEndpoint: raw.otlpEndpoint,
    anthropicApiKey: Option.getOrUndefined(raw.anthropicApiKey),
    ceccIndexUrl: raw.ceccIndexUrl,
  } satisfies AppConfigShape;
});

export class AppConfig extends Context.Service<AppConfig, AppConfigShape>()("catalog/AppConfig") {
  static Default = Layer.effect(AppConfig, make);
}
