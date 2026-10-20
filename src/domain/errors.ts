/**
 * Domain errors carry a stable machine-readable `code` and an HTTP status. The error
 * handler renders them as RFC 7807 problem+json. Messages must never contain PHI.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  badRequest: (code: string, message: string, details?: unknown) => new AppError(400, code, message, details),
  unauthorized: (message = 'Authentication required', code = 'UNAUTHENTICATED') =>
    new AppError(401, code, message),
  forbidden: (message = 'You do not have permission to perform this action', code = 'FORBIDDEN') =>
    new AppError(403, code, message),
  notFound: (resource: string) => new AppError(404, 'NOT_FOUND', `${resource} not found`),
  conflict: (code: string, message: string, details?: unknown) => new AppError(409, code, message, details),
  unprocessable: (code: string, message: string, details?: unknown) =>
    new AppError(422, code, message, details),
  locked: (message: string, retryAfterSec: number) =>
    new AppError(423, 'ACCOUNT_LOCKED', message, undefined, { 'retry-after': String(retryAfterSec) }),
  unavailable: (code: string, message: string, retryAfterSec = 5) =>
    new AppError(503, code, message, undefined, { 'retry-after': String(retryAfterSec) }),
};
