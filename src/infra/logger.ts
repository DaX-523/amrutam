import { trace } from '@opentelemetry/api';
import { pino, type Logger } from 'pino';

/**
 * Structured JSON logs. Every line carries trace/span ids (when tracing is on) so logs
 * in Loki can be pivoted to traces in Jaeger. PHI, credentials and tokens are redacted
 * at the serializer level so they can never reach the log pipeline by accident.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-mockpay-signature"]',
  '*.password',
  '*.newPassword',
  '*.accessToken',
  '*.refreshToken',
  '*.mfaToken',
  '*.code',
  '*.secret',
  '*.otpauthUrl',
  '*.phone',
  '*.dob',
  '*.dateOfBirth',
  '*.reason',
  '*.notes',
  '*.items',
  '*.advice',
];

export function createLogger(opts: { level: string; service: string; pretty?: boolean }): Logger {
  return pino({
    level: opts.level,
    base: { service: opts.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: { level: (label) => ({ level: label }) },
    mixin() {
      const span = trace.getActiveSpan();
      if (!span) return {};
      const ctx = span.spanContext();
      return { trace_id: ctx.traceId, span_id: ctx.spanId };
    },
    ...(opts.pretty ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  });
}

export type { Logger };
