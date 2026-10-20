import fp from 'fastify-plugin';
import type { FastifyError, FastifyPluginAsync } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';
import { AppError } from '../domain/errors.js';
import { pgErrorCode, isRetryableDbError } from '../infra/db.js';

/**
 * Uniform RFC 7807 (application/problem+json) errors. Internal details (stack traces,
 * SQL, constraint names) are logged with the request id but never returned to clients.
 */
interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  requestId: string;
  errors?: unknown;
}

const PG_CONFLICTS: Record<string, { code: string; detail: string }> = {
  '23505': { code: 'CONFLICT', detail: 'Resource already exists or conflicts with existing data' },
  '23P01': { code: 'CONFLICT', detail: 'Resource overlaps with an existing one' },
};

const errorHandlerPlugin: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error: FastifyError | AppError | Error, request, reply) => {
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let detail = 'An unexpected error occurred';
    let errors: unknown;
    let headers: Record<string, string> | undefined;

    if (error instanceof AppError) {
      ({ statusCode: status, code, message: detail, headers } = error);
      errors = error.details;
    } else if (hasZodFastifySchemaValidationErrors(error)) {
      status = 400;
      code = 'VALIDATION_FAILED';
      detail = 'Request validation failed';
      errors = error.validation.map((v) => ({
        path: `${error.validationContext ?? 'body'}${v.instancePath.replaceAll('/', '.')}`,
        message: v.message,
      }));
    } else if (isResponseSerializationError(error)) {
      request.log.error({ err: error, issues: error.cause.issues }, 'response failed schema serialization');
    } else if (pgErrorCode(error) && PG_CONFLICTS[pgErrorCode(error)!]) {
      status = 409;
      ({ code, detail } = PG_CONFLICTS[pgErrorCode(error)!]!);
    } else if (isRetryableDbError(error)) {
      status = 503;
      code = 'TRANSIENT_CONFLICT';
      detail = 'The request conflicted with a concurrent update; please retry';
      headers = { 'retry-after': '1' };
    } else if ('statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500) {
      // Fastify-generated client errors (bad JSON, payload too large, rate limit...).
      status = error.statusCode;
      code = 'code' in error && typeof error.code === 'string' ? error.code : 'BAD_REQUEST';
      detail = error.message;
    }

    if (status >= 500) request.log.error({ err: error }, 'request failed');
    else request.log.info({ code, status }, 'request rejected');

    const problem: Problem = {
      type: `https://docs.amrutam.local/errors/${code.toLowerCase()}`,
      title: code,
      status,
      code,
      detail,
      requestId: request.id,
      ...(errors !== undefined ? { errors } : {}),
    };
    if (headers) void reply.headers(headers);
    return reply.code(status).type('application/problem+json').send(problem);
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).type('application/problem+json').send({
      type: 'https://docs.amrutam.local/errors/not_found',
      title: 'NOT_FOUND',
      status: 404,
      code: 'NOT_FOUND',
      detail: `Route ${request.method} ${request.url.split('?')[0]} not found`,
      requestId: request.id,
    }),
  );
};

export default fp(errorHandlerPlugin, { name: 'error-handler' });
