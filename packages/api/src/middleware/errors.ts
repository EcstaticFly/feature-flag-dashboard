import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

/** Every error response uses this envelope. */
export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** An error with an intended HTTP status. Anything else becomes a 500. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(code: string, message: string, details?: unknown): AppError {
    return new AppError(400, code, message, details);
  }
  static unauthorized(message = 'authentication required'): AppError {
    return new AppError(401, 'unauthorized', message);
  }
  static notFound(code: string, message: string): AppError {
    return new AppError(404, code, message);
  }
  static conflict(code: string, message: string): AppError {
    return new AppError(409, code, message);
  }
}

/** Postgres unique-violation SQLSTATE. */
export const PG_UNIQUE_VIOLATION = '23505';

/**
 * Drizzle wraps driver errors (a failing query inside a transaction surfaces as
 * a DrizzleQueryError with the pg error on `cause`), so the SQLSTATE has to be
 * looked for down the cause chain rather than only on the top-level error.
 */
export function isPgError(err: unknown, code: string): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    if ((current as { code?: string }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function isBodyParseError(err: unknown): boolean {
  return (
    err instanceof SyntaxError && (err as { type?: string }).type === 'entity.parse.failed'
  );
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'not_found', message: 'not found' } } satisfies ErrorBody);
}

/**
 * Terminal error handler. Express 5 forwards rejected promises here, so route
 * handlers can throw freely.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.status).json({
      error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
    } satisfies ErrorBody);
    return;
  }

  if (isBodyParseError(err)) {
    res.status(400).json({
      error: { code: 'invalid_json', message: 'request body is not valid JSON' },
    } satisfies ErrorBody);
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'request body failed validation',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    } satisfies ErrorBody);
    return;
  }

  if (isPgError(err, PG_UNIQUE_VIOLATION)) {
    res.status(409).json({
      error: { code: 'conflict', message: 'resource already exists' },
    } satisfies ErrorBody);
    return;
  }

  console.error('[http] unhandled error:', err);
  res.status(500).json({
    error: { code: 'internal_error', message: 'internal server error' },
  } satisfies ErrorBody);
}
