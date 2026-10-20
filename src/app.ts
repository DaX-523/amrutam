import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import {
  jsonSchemaTransform,
  jsonSchemaTransformObject,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import type { Container } from './container.js';
import { adminRoutes } from './modules/admin/admin.routes.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { availabilityRoutes } from './modules/availability/availability.routes.js';
import { bookingsRoutes } from './modules/bookings/bookings.routes.js';
import { consultationsRoutes } from './modules/consultations/consultations.routes.js';
import { doctorsRoutes } from './modules/doctors/doctors.routes.js';
import { paymentsRoutes } from './modules/payments/payments.routes.js';
import { prescriptionsRoutes } from './modules/prescriptions/prescriptions.routes.js';
import { usersRoutes } from './modules/users/users.routes.js';
import authPlugin from './plugins/auth.js';
import errorHandler from './plugins/error-handler.js';
import idempotencyPlugin from './plugins/idempotency.js';
import observability from './plugins/observability.js';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const MUTATING = new Set(['post', 'put', 'patch', 'delete']);

export type App = Awaited<ReturnType<typeof buildApp>>;

export async function buildApp(c: Container) {
  const app = Fastify({
    loggerInstance: c.logger,
    trustProxy: c.config.TRUST_PROXY,
    bodyLimit: 256 * 1024,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
        ? incoming
        : crypto.randomUUID();
    },
    routerOptions: { maxParamLength: 200 },
    ajv: { customOptions: { removeAdditional: 'all' } },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(errorHandler);
  await app.register(observability, { metrics: c.metrics });
  await app.register(helmet, {
    // JSON API: lock everything down; Swagger UI gets its own CSP via staticCSP.
    contentSecurityPolicy: false,
    hsts: { maxAge: 63_072_000, includeSubDomains: true, preload: true },
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cors, {
    origin: c.config.CORS_ORIGINS,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-request-id'],
    exposedHeaders: [
      'x-request-id',
      'idempotent-replayed',
      'retry-after',
      'ratelimit-limit',
      'ratelimit-remaining',
    ],
    maxAge: 600,
  });

  // Order matters: authentication (global onRequest) runs before the per-route rate-limit
  // hooks, so authenticated clients are limited per user and anonymous ones per IP.
  await app.register(authPlugin, { tokens: c.tokens, revocations: c.revocations });
  await app.register(rateLimit, {
    global: true,
    max: c.config.RATE_LIMIT_MAX,
    timeWindow: c.config.RATE_LIMIT_WINDOW_MS,
    redis: c.redis,
    nameSpace: 'rl:',
    skipOnError: true, // fail open if Redis is down; availability > strictness here
    keyGenerator: (req) => (req.actor ? `u:${req.actor.id}` : `ip:${req.ip}`),
    allowList: (req) => !req.url.startsWith('/v1'),
    errorResponseBuilder: (req, ctx) => ({
      statusCode: 429,
      code: 'RATE_LIMITED',
      message: `Rate limit exceeded, retry in ${Math.ceil(ctx.ttl / 1000)}s`,
      requestId: req.id,
    }),
  });
  await app.register(idempotencyPlugin, {
    db: c.db.writer,
    cipher: c.cipher,
    metrics: c.metrics,
    logger: c.logger,
    ttlHours: c.config.IDEMPOTENCY_TTL_HOURS,
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Amrutam Telemedicine API',
        version: '1.0.0',
        description:
          'Auth (MFA/RBAC), doctor discovery & availability, booking saga, consultations, prescriptions, ' +
          'payments, audit and admin analytics. All mutating endpoints require an `Idempotency-Key` header ' +
          'unless stated otherwise. Errors use RFC 7807 problem+json.',
      },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      },
    },
    transform: (input) => {
      const out = jsonSchemaTransform(input);
      const optedOut = input.route.config?.idempotency === false;
      if (
        input.url.startsWith('/v1') &&
        MUTATING.has(String(input.route.method).toLowerCase()) &&
        !optedOut
      ) {
        const schema = out.schema as Record<string, unknown>;
        const headers = (schema.headers as {
          type: string;
          properties: Record<string, unknown>;
          required?: string[];
        }) ?? {
          type: 'object',
          properties: {},
        };
        headers.properties['idempotency-key'] = {
          type: 'string',
          minLength: 8,
          maxLength: 128,
          description: 'Client-generated unique key (UUID recommended). Retries with the same key are safe.',
        };
        headers.required = [...(headers.required ?? []), 'idempotency-key'];
        schema.headers = headers;
      }
      // Routes mounted at '/' under a prefix answer on both '/v1/x' and '/v1/x/'; document the canonical one.
      return { ...out, url: out.url.length > 1 ? out.url.replace(/\/$/, '') : out.url };
    },
    transformObject: jsonSchemaTransformObject,
  });
  await app.register(swaggerUi, { routePrefix: '/docs', staticCSP: true });

  app.get('/health/live', { schema: { hide: true } }, async () => ({ status: 'ok' }));
  app.get('/health/ready', { schema: { hide: true } }, async (_req, reply) => {
    const checks = await Promise.allSettled([sql`select 1`.execute(c.db.writer), c.redis.ping()]);
    const [dbCheck, redisCheck] = checks;
    const body = {
      status: checks.every((r) => r.status === 'fulfilled') ? 'ok' : 'degraded',
      checks: { postgres: dbCheck?.status === 'fulfilled', redis: redisCheck?.status === 'fulfilled' },
    };
    // Postgres is a hard dependency; Redis degradation is tolerated (cache/rate-limit fail open).
    return reply.code(body.checks.postgres ? 200 : 503).send(body);
  });

  await app.register(
    async (v1) => {
      await v1.register(authRoutes({ auth: c.auth, authRateLimitMax: c.config.AUTH_RATE_LIMIT_MAX }), {
        prefix: '/auth',
      });
      await v1.register(usersRoutes({ users: c.users }), { prefix: '/me' });
      await v1.register(doctorsRoutes({ doctors: c.doctors }), { prefix: '/doctors' });
      await v1.register(availabilityRoutes({ availability: c.availability }), { prefix: '/doctors' });
      await v1.register(
        bookingsRoutes({ bookings: c.bookings, rateLimitMax: c.config.BOOKING_RATE_LIMIT_MAX }),
        { prefix: '/bookings' },
      );
      await v1.register(consultationsRoutes({ consultations: c.consultations }), {
        prefix: '/consultations',
      });
      await v1.register(prescriptionsRoutes({ prescriptions: c.prescriptions }), {
        prefix: '/consultations',
      });
      await v1.register(
        paymentsRoutes({
          payments: c.payments,
          mockCheckoutEnabled: c.config.MOCK_CHECKOUT_ENABLED && c.config.PAYMENT_PROVIDER === 'mock',
        }),
        { prefix: '/payments' },
      );
      await v1.register(
        adminRoutes({ admin: c.admin, audit: c.audit, analytics: c.analytics, queues: c.queues }),
        { prefix: '/admin' },
      );
    },
    { prefix: '/v1' },
  );

  return app;
}
