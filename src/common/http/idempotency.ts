import { CallHandler, ExecutionContext, HttpStatus, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { sql } from 'kysely';
import { catchError, from, Observable, of, switchMap, throwError } from 'rxjs';

import { DbService } from '../../infra/db/db.service';
import { AuthedRequest } from '../auth/auth.decorators';
import { sha256 } from '../crypto';
import { AppError } from '../errors/app-error';

export const IDEMPOTENT = 'idempotent';

/**
 * Changing requests that must never happen twice (hold a place, reschedule, cancel, refunds, console commands)
 * take an `Idempotency-Key` header. The first answer is stored for 24 hours; a retry with the same key gets
 * the same answer without doing the work again. The same key with a different body is refused.
 */
export const Idempotent = (opts: { required?: boolean } = {}) => SetMetadata(IDEMPOTENT, { required: opts.required ?? true });

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly dbs: DbService,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const opts = this.reflector.get<{ required: boolean } | undefined>(IDEMPOTENT, ctx.getHandler());
    if (!opts || ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[\w-]{8,64}$/.test(key)) {
      if (!opts.required) return next.handle();
      throw new AppError('IDEMPOTENCY_KEY_MISSING', 'Something in the request is not right. Please update the app and try again.', HttpStatus.BAD_REQUEST);
    }
    const p = req.principal;
    const owner = p ? (p.kind === 'admin' ? p.adminId : p.userId) : undefined;
    if (!owner) return next.handle();
    const route = `${req.method} ${req.route?.path ?? req.path}`.slice(0, 120);
    const hash = sha256(JSON.stringify({ route, params: req.params, body: req.body ?? null }));

    let claimed = false;
    return from(this.claim(owner, key, route, hash)).pipe(
      switchMap((stored) => {
        claimed = !stored;
        if (stored) {
          res.status(stored.statusCode);
          res.setHeader('Idempotent-Replayed', 'true');
          return of(stored.response);
        }
        return next.handle().pipe(
          switchMap((body) =>
            from(this.save(owner, key, this.reflector.get<number | undefined>('__httpCode__', ctx.getHandler()) ?? (req.method === 'POST' ? 201 : 200), body).then(() => body)),
          ),
        );
      }),
      // A failed attempt may be retried with the same key: forget it (only if this request claimed the key).
      catchError((err: unknown) =>
        claimed ? from(this.forget(owner, key)).pipe(switchMap(() => throwError(() => err))) : throwError(() => err),
      ),
    );
  }

  /** Returns the stored answer, or undefined when this request should go ahead (and is now marked as started). */
  private async claim(owner: string, key: string, route: string, hash: Buffer): Promise<{ statusCode: number; response: unknown } | undefined> {
    const inserted = await sql<{ key: string }>`
      insert into idempotency_keys (user_id, key, route, request_hash) values (${owner}, ${key}, ${route}, ${hash})
      on conflict (user_id, key) do nothing returning key`.execute(this.dbs.db);
    if (inserted.rows.length > 0) return undefined;
    const row = await this.dbs.db
      .selectFrom('idempotencyKeys')
      .select(['requestHash', 'statusCode', 'response', 'createdAt'])
      .where('userId', '=', owner)
      .where('key', '=', key)
      .executeTakeFirst();
    if (!row) return this.claim(owner, key, route, hash);
    if (!Buffer.from(row.requestHash).equals(hash)) {
      throw new AppError('IDEMPOTENCY_MISMATCH', 'This request was already sent with different details. Please start again.', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    if (row.statusCode === null) {
      throw new AppError('IN_PROGRESS', 'We are still working on this. Please wait a moment.', HttpStatus.CONFLICT, true);
    }
    return { statusCode: row.statusCode, response: row.response };
  }

  private async save(owner: string, key: string, statusCode: number, body: unknown): Promise<void> {
    await this.dbs.db
      .updateTable('idempotencyKeys')
      .set({ statusCode, response: JSON.stringify(body ?? null) })
      .where('userId', '=', owner)
      .where('key', '=', key)
      .execute();
  }

  private async forget(owner: string, key: string): Promise<void> {
    await this.dbs.db.deleteFrom('idempotencyKeys').where('userId', '=', owner).where('key', '=', key).where('statusCode', 'is', null).execute().catch(() => undefined);
  }
}
