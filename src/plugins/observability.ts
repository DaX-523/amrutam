import { trace } from '@opentelemetry/api';
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import type { Metrics } from '../infra/metrics.js';

/** RED metrics per route template (bounded cardinality) + request id echo + /metrics. */
const observabilityPlugin: FastifyPluginAsync<{ metrics: Metrics }> = async (app, { metrics }) => {
  app.addHook('onRequest', async (request, reply) => {
    void reply.header('x-request-id', request.id);
    // Name the HTTP server span by route template ("POST /v1/bookings"), not raw URL.
    const span = trace.getActiveSpan();
    const route = request.routeOptions.url;
    if (span && route) {
      span.updateName(`${request.method} ${route}`);
      span.setAttributes({ 'http.route': route, 'app.request_id': request.id });
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    const route = request.routeOptions.url ?? 'unmatched';
    if (route === '/metrics') return;
    metrics.httpDuration.observe(
      { method: request.method, route, status_code: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });

  // In K8s this path is not routed by the Ingress; Prometheus scrapes the pod directly.
  app.get('/metrics', { schema: { hide: true } }, async (_request, reply) => {
    void reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });
};

export default fp(observabilityPlugin, { name: 'observability' });
