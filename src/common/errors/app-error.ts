import { HttpStatus } from '@nestjs/common';

/**
 * An error we expect and can explain. `message` is shown to people as-is, so it is written in the app's
 * simple English. The app decides what to do from `code` (see ARCHITECTURE.md §16.1).
 */
export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: HttpStatus = HttpStatus.BAD_REQUEST,
    readonly retryable = false,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Messages for errors that don't come from our own code (framework, database, unknown). */
export const genericMessages: Record<number, { code: string; message: string; retryable: boolean }> = {
  400: { code: 'BAD_REQUEST', message: 'Something in the request is not right. Please check and try again.', retryable: false },
  401: { code: 'UNAUTHENTICATED', message: 'Please log in again.', retryable: false },
  403: { code: 'FORBIDDEN', message: "You can't open this.", retryable: false },
  404: { code: 'NOT_FOUND', message: 'We could not find this. It may have been moved or removed.', retryable: false },
  409: { code: 'CONFLICT', message: 'This just changed. Please refresh and try again.', retryable: false },
  422: { code: 'NOT_ALLOWED', message: 'This is not allowed.', retryable: false },
  426: { code: 'UPGRADE_REQUIRED', message: 'Please update OPflow to continue.', retryable: false },
  429: { code: 'TOO_MANY_REQUESTS', message: 'Too many tries. Please wait a minute and try again.', retryable: true },
  500: { code: 'INTERNAL', message: 'Something went wrong. Please try again.', retryable: true },
  503: { code: 'UNAVAILABLE', message: 'This is not working right now. Please try again in a few minutes.', retryable: true },
};
