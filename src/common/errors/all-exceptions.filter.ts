import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';

import { captureError } from '../sentry';
import { AppError, genericMessages } from './app-error';
import { pgError } from './pg-errors';

export interface ErrorBody {
  error: { code: string; message: string; retryable: boolean; requestId?: string; details?: Record<string, unknown> };
}

/**
 * Turns every error into the one shape the app understands. Stack traces and internal messages go to the
 * logs (and Sentry at B11), never to the client.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly log = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request & { id?: string }>();
    const res = http.getResponse<Response>();
    const { status, body } = toErrorBody(exception, req.id);

    if (status >= 500) {
      this.log.error(`${req.method} ${req.url} → ${status} [${req.id ?? '-'}]`, exception instanceof Error ? exception.stack : String(exception));
      captureError(exception, { requestId: req.id, route: `${req.method} ${req.route?.path ?? req.url?.split('?')[0]}`, status });
    }
    if (!res.headersSent) res.status(status).json(body);
  }
}

export function toErrorBody(exception: unknown, requestId?: string): { status: number; body: ErrorBody } {
  if (exception instanceof AppError) {
    return {
      status: exception.status,
      body: {
        error: {
          code: exception.code,
          message: exception.message,
          retryable: exception.retryable,
          requestId,
          ...(exception.details ? { details: exception.details } : {}),
        },
      },
    };
  }
  const known = fromDatabaseOrNetwork(exception);
  if (known) return { status: known.status, body: { error: { ...known.error, requestId } } };
  const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
  const generic = genericMessages[status] ?? (status >= 500 ? genericMessages[500]! : genericMessages[400]!);
  return { status, body: { error: { ...generic, requestId } } };
}

/**
 * Database and network failures get an honest, simple message. The app retries the retryable ones.
 * Internal details (constraint names, SQL) are never sent.
 */
function fromDatabaseOrNetwork(
  exception: unknown,
): { status: number; error: { code: string; message: string; retryable: boolean } } | undefined {
  const pg = pgError(exception);
  if (pg) {
    switch (pg.code) {
      case '23505':
        return { status: 409, error: genericMessages[409]! };
      case '40001':
      case '40P01':
      case '55P03':
        return { status: 503, error: { code: 'BUSY', message: 'Many people are doing this right now. Please try again.', retryable: true } };
      case '57014':
        return { status: 503, error: { code: 'SLOW', message: 'This is taking too long right now. Please try again.', retryable: true } };
      case '42501':
        return { status: 403, error: genericMessages[403]! };
      case '23514':
      case '23P01':
        return { status: 422, error: genericMessages[422]! };
      case '53300':
      case '08006':
      case '08001':
      case '57P01':
        return { status: 503, error: genericMessages[503]! };
      default:
        return undefined;
    }
  }
  const code = typeof exception === 'object' && exception !== null && 'code' in exception ? String((exception as { code: unknown }).code) : '';
  if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE'].includes(code)) {
    return { status: 503, error: genericMessages[503]! };
  }
  if (exception instanceof Error && /Connection terminated|timeout exceeded when trying to connect|Query read timeout/i.test(exception.message)) {
    return { status: 503, error: genericMessages[503]! };
  }
  return undefined;
}
