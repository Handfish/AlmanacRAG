import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";

// OpenTelemetry skeleton (§12). One tracer, OTLP → collector. Phase 5 attaches
// one span per request with `cost_micros` as a span attribute. Offline, the batch
// processor simply retries in the background — it does not block boot.
export const TelemetryLive = NodeSdk.layer(() => ({
  resource: { serviceName: "catalog" },
  spanProcessor: [
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318"}/v1/traces`,
      }),
    ),
  ],
}));
