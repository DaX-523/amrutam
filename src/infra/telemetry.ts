/**
 * OpenTelemetry bootstrap. Loaded with `node --import ./dist/infra/telemetry.js` so the
 * instrumentation hooks are installed before http/pg/ioredis are imported.
 * Exports OTLP/HTTP to the collector (Jaeger locally; any OTLP backend in prod).
 * Sampling is configured with the standard env vars, e.g.
 *   OTEL_TRACES_SAMPLER=parentbased_traceidratio OTEL_TRACES_SAMPLER_ARG=0.1
 */
import { register } from 'node:module';

if (process.env.OTEL_ENABLED === 'true' || process.env.OTEL_ENABLED === '1') {
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);

  const [
    { NodeSDK },
    { getNodeAutoInstrumentations },
    { OTLPTraceExporter },
    { resourceFromAttributes },
    semconv,
  ] = await Promise.all([
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/auto-instrumentations-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/semantic-conventions'),
  ]);

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318';
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [semconv.ATTR_SERVICE_NAME]: process.env.SERVICE_NAME ?? 'amrutam-api',
      [semconv.ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '1.0.0',
      'deployment.environment.name': process.env.NODE_ENV ?? 'development',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
        '@opentelemetry/instrumentation-dns': { enabled: false },
        '@opentelemetry/instrumentation-net': { enabled: false },
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (req) =>
            ['/metrics', '/health/live', '/health/ready'].includes(req.url ?? ''),
        },
      }),
    ],
  });
  sdk.start();
  const shutdown = () => void sdk.shutdown().catch(() => undefined);
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

export {};
