import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { sql } from 'kysely';

import { ENV, Env } from '../../config/env';
import { DbService } from '../../infra/db/db.service';
import { AppError } from '../errors/app-error';
import { ADMIN_ROLES, APP_ROLES, AuthedRequest, clientIp, PUBLIC, STEP_UP } from './auth.decorators';
import { AdminRoleName, AppRole, JwtService } from './jwt.service';

const STEP_UP_SECONDS = 5 * 60;

/**
 * Runs before every HTTP route. Routes are private unless marked @Public().
 * - App routes accept only app tokens (patient / doctor), admin routes only admin tokens: a stolen app
 *   token can never reach /v1/admin.
 * - Admin requests are re-checked against the database every time (admin still active, session not
 *   signed out), so removing an admin takes effect immediately, not after the token expires.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly dbs: DbService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const targets = [ctx.getHandler(), ctx.getClass()];
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const adminRoles = this.reflector.getAllAndOverride<AdminRoleName[] | undefined>(ADMIN_ROLES, targets);
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC, targets);

    if (adminRoles && this.env.ADMIN_ALLOWED_IPS.length > 0) {
      const ip = clientIp(req);
      if (!ip || !this.env.ADMIN_ALLOWED_IPS.includes(ip)) {
        throw new AppError('ADMIN_IP_BLOCKED', 'The admin site cannot be opened from this network.', HttpStatus.FORBIDDEN);
      }
    }
    if (isPublic) return true;

    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (!token) throw new AppError('UNAUTHENTICATED', 'Please log in again.', HttpStatus.UNAUTHORIZED);

    if (adminRoles) {
      const c = this.jwt.verify(token, 'admin');
      const live = await sql<{ role: AdminRoleName }>`
        select a.role from admin_users a
        where a.id = ${c.sub} and a.status = 'active'
          and exists (select 1 from refresh_tokens r
                      where r.family_id = ${c.sid} and r.admin_id = a.id and r.revoked_at is null and r.expires_at > now())`
        .execute(this.dbs.db);
      const row = live.rows[0];
      if (!row) throw new AppError('UNAUTHENTICATED', 'Please sign in again.', HttpStatus.UNAUTHORIZED);
      if (adminRoles.length > 0 && !adminRoles.includes(row.role)) {
        throw new AppError('FORBIDDEN', 'Your admin role cannot do this.', HttpStatus.FORBIDDEN);
      }
      const stepUpAt = c.su ?? 0;
      if (this.reflector.getAllAndOverride<boolean | undefined>(STEP_UP, targets) && Date.now() / 1000 - stepUpAt > STEP_UP_SECONDS) {
        throw new AppError('STEP_UP_REQUIRED', 'Please enter your authenticator code again.', HttpStatus.FORBIDDEN);
      }
      req.principal = { kind: 'admin', adminId: c.sub, role: row.role, sid: c.sid, stepUpAt };
      return true;
    }

    const c = this.jwt.verify(token, 'app');
    const role = c.role as AppRole;
    const allowed = this.reflector.getAllAndOverride<AppRole[] | undefined>(APP_ROLES, targets);
    if (allowed && !allowed.includes(role)) throw new AppError('FORBIDDEN', "You can't open this.", HttpStatus.FORBIDDEN);
    if (role === 'doctor') {
      // Doctors can be signed out remotely (the 2-device limit, "sign out that phone", suspension): check the
      // session is still live, so a signed-out phone stops at once instead of when its 15-minute token ends.
      const live = await sql<{ ok: number }>`
        select 1 as ok from refresh_tokens where family_id = ${c.sid} and user_id = ${c.sub} and revoked_at is null and expires_at > now() limit 1`
        .execute(this.dbs.db);
      if (live.rows.length === 0) throw new AppError('SIGNED_OUT', 'You were signed out on this phone. Please log in again.', HttpStatus.UNAUTHORIZED);
    }
    req.principal = { kind: 'app', role, userId: c.sub, doctorId: c.did, sid: c.sid };
    return true;
  }
}
