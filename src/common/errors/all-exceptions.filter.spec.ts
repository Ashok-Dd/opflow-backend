import { HttpStatus, NotFoundException } from '@nestjs/common';

import { AppError } from './app-error';
import { toErrorBody } from './all-exceptions.filter';

describe('toErrorBody', () => {
  it('passes our own errors through with their simple-English message', () => {
    const { status, body } = toErrorBody(
      new AppError('WINDOW_FULL', 'This time just got full. Please pick another.', HttpStatus.CONFLICT),
      'req_1',
    );
    expect(status).toBe(409);
    expect(body.error).toEqual({
      code: 'WINDOW_FULL',
      message: 'This time just got full. Please pick another.',
      retryable: false,
      requestId: 'req_1',
    });
  });

  it('gives framework errors a friendly message', () => {
    const { status, body } = toErrorBody(new NotFoundException('Cannot GET /x'), 'req_2');
    expect(status).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).not.toContain('Cannot GET');
  });

  it('never leaks internal details of unknown errors', () => {
    const { status, body } = toErrorBody(new Error('connect ECONNREFUSED 10.0.0.1:5432 password=hunter2'), 'req_3');
    expect(status).toBe(500);
    expect(body.error).toEqual({ code: 'INTERNAL', message: 'Something went wrong. Please try again.', retryable: true, requestId: 'req_3' });
  });
});
