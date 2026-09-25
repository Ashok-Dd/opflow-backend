import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AdminRoleName, AppRole, JwtService } from '../../common/auth/jwt.service';
import { randomToken, sha256 } from '../../common/crypto';
import { AppError } from '../../common/errors/app-error';
import { notify, uuidv7 } from '../../common/outbox';
import { ENV, Env } from '../../config/env';
import { DbService, Tx } from '../../infra/db/db.service';
import { RulesService } from '../../infra/rules/rules.service';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

interface IssueContext {
  ip?: string | null;
  userAgent?: string | null;
  deviceId?: string | null;
}

const relogin = () => new AppError('UNAUTHENTICATED', 'Please log in again.', HttpStatus.UNAUTHORIZED);

/**
 * Sessions: a short access token (15 min) + an opaque refresh token stored only as a hash. Each refresh
 * replaces the refresh token; presenting an already-replaced one means it was copied, so the whole session
 * (family) is ended at once.
 */
@Injectable()
export class TokensService {
  constructor(
    private readonly dbs: DbService,
    private readonly jwt: JwtService,
    private readonly rules: RulesService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async issueApp(tx: Tx, who: { userId: string; role: AppRole; doctorId?: string }, ctx: IssueContext = {}, existingFamily?: string): Promise<TokenPair> {
    const familyId = existingFamily ?? uuidv7();
    // A new sign-in (not a refresh) on a doctor account: at most N devices at a time.
    if (!existingFamily && who.role === 'doctor') await this.makeRoomForDoctorDevice(tx, who.userId);
    const refreshToken = randomToken();
    await tx
      .insertInto('refreshTokens')
      .values({
        userId: who.userId,
        role: who.role,
        familyId,
        tokenHash: sha256(refreshToken),
        deviceId: ctx.deviceId ?? null,
        expiresAt: new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      })
      .execute();
    const accessToken = this.jwt.sign({ aud: 'app', sub: who.userId, role: who.role, did: who.doctorId, sid: familyId });
    return { accessToken, refreshToken, expiresIn: this.jwt.accessTtlSeconds };
  }

  async issueAdmin(
    tx: Tx,
    who: { adminId: string; role: AdminRoleName; stepUpAt: number },
    ctx: IssueContext = {},
    family?: { id: string; startedAt: Date },
  ): Promise<TokenPair> {
    const refreshToken = randomToken();
    const familyId = family?.id ?? uuidv7();
    const started = family?.startedAt ?? new Date();
    const hardEnd = started.getTime() + this.env.ADMIN_SESSION_TTL_HOURS * 3_600_000;
    const idleEnd = Date.now() + this.env.ADMIN_IDLE_MINUTES * 60_000;
    await tx
      .insertInto('refreshTokens')
      .values({
        adminId: who.adminId,
        familyId,
        tokenHash: sha256(refreshToken),
        expiresAt: new Date(Math.min(hardEnd, idleEnd)),
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
      })
      .execute();
    const accessToken = this.jwt.sign(
      { aud: 'admin', sub: who.adminId, role: who.role, sid: familyId, su: who.stepUpAt },
      Math.min(this.env.JWT_ACCESS_TTL_SECONDS, Math.max(60, Math.floor((hardEnd - Date.now()) / 1000))),
    );
    return { accessToken, refreshToken, expiresIn: this.jwt.accessTtlSeconds };
  }

  /** Swaps a refresh token for a new pair. Reuse of an old token ends the whole session. */
  async rotate(refreshToken: string, audience: 'app' | 'admin', ctx: IssueContext = {}): Promise<TokenPair> {
    if (!refreshToken || refreshToken.length > 200) throw relogin();
    const outcome = await this.dbs.system(async (tx) => {
      const row = await tx
        .selectFrom('refreshTokens')
        .selectAll()
        .where('tokenHash', '=', sha256(refreshToken))
        .forUpdate()
        .executeTakeFirst();
      if (!row) return { error: relogin() };
      if ((audience === 'admin') !== (row.adminId !== null)) return { error: relogin() };
      if (row.replacedBy && row.revokedAt && Date.now() - new Date(row.revokedAt).getTime() < 30_000) {
        // Two requests refreshed at the same moment (e.g. the admin site prefetching two pages). The other one
        // already got the new pair: refuse this one, but don't end the session.
        return { error: relogin() };
      }
      if (row.revokedAt || row.replacedBy) {
        // Already used: someone else has a copy. End every token of this session.
        await tx.updateTable('refreshTokens').set({ revokedAt: new Date() }).where('familyId', '=', row.familyId).where('revokedAt', 'is', null).execute();
        return { error: relogin() };
      }
      if (new Date(row.expiresAt).getTime() <= Date.now()) return { error: relogin() };

      let pair: TokenPair;
      if (row.adminId) {
        const admin = await tx.selectFrom('adminUsers').select(['id', 'role', 'status', 'totpLastStep']).where('id', '=', row.adminId).executeTakeFirst();
        if (!admin || admin.status !== 'active') return { error: relogin() };
        const started = await tx
          .selectFrom('refreshTokens')
          .select((eb) => eb.fn.min('createdAt').as('first'))
          .where('familyId', '=', row.familyId)
          .executeTakeFirstOrThrow();
        pair = await this.issueAdmin(
          tx,
          { adminId: admin.id, role: admin.role, stepUpAt: admin.totpLastStep ? Number(admin.totpLastStep) * 30 : 0 },
          { ...ctx },
          { id: row.familyId, startedAt: new Date(started.first as unknown as string | Date) },
        );
      } else {
        const user = await tx.selectFrom('users').select(['id', 'status']).where('id', '=', row.userId!).executeTakeFirst();
        if (!user || user.status !== 'active') return { error: relogin() };
        let doctorId: string | undefined;
        if (row.role === 'doctor') {
          const d = await tx.selectFrom('doctors').select(['id', 'status']).where('userId', '=', user.id).executeTakeFirst();
          if (!d || d.status !== 'active') return { error: relogin() };
          doctorId = d.id;
        }
        pair = await this.issueApp(tx, { userId: user.id, role: row.role as AppRole, doctorId }, { ...ctx, deviceId: row.deviceId }, row.familyId);
      }
      const next = await tx.selectFrom('refreshTokens').select('id').where('tokenHash', '=', sha256(pair.refreshToken)).executeTakeFirstOrThrow();
      await tx.updateTable('refreshTokens').set({ revokedAt: new Date(), replacedBy: next.id }).where('id', '=', row.id).execute();
      return { pair };
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.pair;
  }

  async revokeByToken(refreshToken: string): Promise<void> {
    await this.dbs.system(async (tx) => {
      const row = await tx.selectFrom('refreshTokens').select('familyId').where('tokenHash', '=', sha256(refreshToken)).executeTakeFirst();
      if (row) await this.revokeFamily(tx, row.familyId);
    });
  }

  /** Ends a session. Its phone stops getting pushes too (the token comes back at the next login). */
  async revokeFamily(tx: Tx, familyId: string): Promise<void> {
    const rows = await tx
      .updateTable('refreshTokens')
      .set({ revokedAt: new Date() })
      .where('familyId', '=', familyId)
      .where('revokedAt', 'is', null)
      .returning('deviceId')
      .execute();
    const deviceIds = [...new Set(rows.map((r) => r.deviceId).filter((id): id is string => !!id))];
    if (deviceIds.length) await tx.updateTable('devices').set({ fcmToken: null }).where('id', 'in', deviceIds).execute();
  }

  /**
   * A doctor account may be signed in on at most `doctor.max_devices` devices (2). Signing in on one more signs
   * out the device used least recently, so a doctor who lost a phone is never locked out; they are told.
   */
  private async makeRoomForDoctorDevice(tx: Tx, userId: string): Promise<void> {
    // Two sign-ins at the same moment must not both see "one place free".
    await sql`select pg_advisory_xact_lock(hashtext(${`devices:${userId}`}))`.execute(tx);
    const max = Math.max(1, await this.rules.doctorMaxDevices());
    const live = await this.liveSessions(tx, userId, 'doctor');
    const extra = live.length - (max - 1);
    for (const old of live.slice(0, Math.max(0, extra))) {
      await this.revokeFamily(tx, old.familyId);
      await notify(tx, {
        userId,
        kind: 'system',
        title: 'Signed out on another device',
        body: `Your OPflow account can be used on ${max} devices at a time. You signed in on a new device, so ${old.deviceLabel} was signed out.`,
        dedupeKey: `device-out:${old.familyId}`,
      });
    }
  }

  /** Live sessions of one person, least recently used first. */
  async liveSessions(tx: Tx, userId: string, role: AppRole) {
    const r = await sql<{ familyId: string; startedAt: Date; lastUsedAt: Date; platform: string | null; appVersion: string | null; ip: string | null; userAgent: string | null }>`
      select rt.family_id,
             min(rt.created_at) as started_at,
             max(rt.created_at) as last_used_at,
             (array_agg(d.platform::text order by rt.created_at desc))[1] as platform,
             (array_agg(d.app_version order by rt.created_at desc))[1] as app_version,
             (array_agg(host(rt.ip) order by rt.created_at desc))[1] as ip,
             (array_agg(rt.user_agent order by rt.created_at desc))[1] as user_agent
        from refresh_tokens rt left join devices d on d.id = rt.device_id
       where rt.user_id = ${userId} and rt.role = ${role}
         and rt.family_id in (select family_id from refresh_tokens
                               where user_id = ${userId} and role = ${role} and revoked_at is null and expires_at > now())
       group by rt.family_id
       order by last_used_at asc`.execute(tx);
    return r.rows.map((x) => ({
      ...x,
      deviceLabel: x.platform === 'ios' ? 'an iPhone' : x.platform === 'android' ? 'an Android phone' : x.platform === 'web' ? 'a web browser' : 'another device',
    }));
  }

  /** Sign out everywhere (password change, suspension, account deletion). */
  revokeAllForUser(tx: Tx, userId: string, role?: AppRole) {
    let q = tx.updateTable('refreshTokens').set({ revokedAt: new Date() }).where('userId', '=', userId).where('revokedAt', 'is', null);
    if (role) q = q.where('role', '=', role);
    return q.execute();
  }

  revokeAllForAdmin(tx: Tx, adminId: string) {
    return tx.updateTable('refreshTokens').set({ revokedAt: new Date() }).where('adminId', '=', adminId).where('revokedAt', 'is', null).execute();
  }

  /** Housekeeping: expired and long-revoked tokens (hourly job). */
  async purge(): Promise<number> {
    const r = await sql`delete from refresh_tokens where expires_at < now() - interval '7 days'`.execute(this.dbs.db);
    return Number(r.numAffectedRows ?? 0);
  }
}
