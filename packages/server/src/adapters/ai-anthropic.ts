import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient";
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

// The Anthropic provider (plan §5.2 / ADR-I1) — the single adapter that carries a
// vendor dependency behind the first-party `effect/unstable/ai` LanguageModel
// port. The Extractor (Phase 2) is its first consumer; the Answerer (Phase 5)
// reuses the same client. Contained to one file so a provider swap stays a
// one-file blast radius (§4).
//
// The API key is read directly via `Config` (like the SQL URLs — ADR-I5), stays
// wrapped in `Redacted`, and is unwrapped only inside the vendor client. It is
// optional: a missing key builds an unauthenticated client that fails at call
// time, so `main.ts` and the test suite stay bootable without a secret — the
// mock LanguageModel drives the Phase-2 tests, with zero provider spend.
const AnthropicClientLive = AnthropicClient.layerConfig({
  apiKey: Config.redacted("ANTHROPIC_API_KEY").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
}).pipe(Layer.provide(FetchHttpClient.layer));

// The extraction model — a config knob and the §11.5 ablation seam. Default
// Haiku 4.5: cheapest tier and what the architecture budgeted ("~$4/pass,
// Haiku-class"), and lower-risk than it looks because the deterministic
// `page_fields` capture already carries the structured fields — the model's
// residual job is the hidden/semantic minority (title parsing, footnote
// deadlines, prose-derived relations, sync-vs-async delivery), and even those
// lean on deterministic cross-checks. Validate per-field P/R on a stratified
// sample (§9.3) before the full pass; escalate to `claude-sonnet-4-6` or
// `claude-opus-4-8` via EXTRACTION_MODEL if the hard fields underperform.
export const ExtractionModel = Config.string("EXTRACTION_MODEL").pipe(
  Config.withDefault("claude-haiku-4-5"),
);

// `AnthropicLanguageModel.model(name)` *is* a Layer providing `LanguageModel`
// (+ ProviderName/ModelName) and requiring `AnthropicClient`. We read the model
// name from config at build time and satisfy the client requirement here,
// yielding a ready-to-provide `Layer<LanguageModel>` for the Extractor adapter.
export const LanguageModelLive = Layer.unwrap(
  Effect.gen(function*() {
    const model = yield* ExtractionModel;
    return AnthropicLanguageModel.model(model);
  }),
).pipe(
  Layer.provide(AnthropicClientLive),
  Layer.orDie,
);
