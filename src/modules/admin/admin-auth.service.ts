import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';

import type { AdminPrincipal, RequestMeta } from '../../common/auth/auth.decorators';
import { JwtService } from '../../common/auth/jwt.service';
import { audit } from '../../common/audit';
import { newTotpSecret, otpauthUrl, randomToken, sha256, verifyTotp } from '../../common/crypto';
import { AppError } from '../../common/errors/app-error';
import { enqueue } from '../../common/outbox';
import { ENV, Env, isLocal } from '../../config/env';
import { DbService, Tx } from '../../infra/db/db.service';
import { PasswordsService } from '../auth/passwords.service';
import { TokensService } from '../auth/tokens.service';

const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;
const SETUP_HOURS = 24;

const badLogin = () => new AppError('LOGIN_FAILED', 'Email, password or code is not right.', HttpStatus.UNAUTHORIZED);

/**
 * Admin sign-in: email + password, then the 6-digit authenticator code. No sign-up: admins are created by
 * the `admin:create` command (OPflow has exactly one admin), who gets a one-time setup link.
 */
@Injectable()
export class AdminAuthService {
  private readonly log = new Logger(AdminAuthService.name);
  private readonly key: string;

  constructor(
    private readonly dbs: DbService,
    private readonly passwords: PasswordsService,
    private readonly tokens: TokensService,
    private readonly jwt: JwtService,
    @Inject(ENV) private readonly env: Env,
  ) {
    if (env.DATA_ENCRYPTION_KEY) this.key = env.DATA_ENCRYPTION_KEY;
    else if (isLocal(env)) this.key = 'opflow-local-only-data-key-not-for-servers';
    else throw new Error('DATA_ENCRYPTION_KEY is required');
  }

  private async fn(name: 'pgp_sym_encrypt' | 'pgp_sym_decrypt') {
    return sql.raw(`${await this.dbs.cryptoSchema()}.${name}`);
  }

  private async encrypt(tx: Tx, secret: string) {
    const r = await sql<{ v: Buffer }>`select ${await this.fn('pgp_sym_encrypt')}(${secret}, ${this.key}) as v`.execute(tx);
    return r.rows[0]!.v;
  }

  private async decrypt(tx: Tx, data: Buffer): Promise<string> {
    const r = await sql<{ s: string }>`select ${await this.fn('pgp_sym_decrypt')}(${data}, ${this.key}) as s`.execute(tx);
    return r.rows[0]!.s;
  }

  private async secretOf(tx: Tx, adminId: string): Promise<string | null> {
    const row = await tx.selectFrom('adminUsers').select('totpSecretEnc').where('id', '=', adminId).executeTakeFirst();
    return row?.totpSecretEnc ? this.decrypt(tx, row.totpSecretEnc) : null;
  }

  /** Step 1: email + password → a 5-minute challenge for the authenticator code. */
  async login(email: string, password: string, meta: RequestMeta) {
    const admin = await this.dbs.db
      .selectFrom('adminUsers')
      .select(['id', 'passwordHash', 'status', 'failedAttempts', 'lockedUntil', 'allowedIps', 'totpSecretEnc'])
      .where('email', '=', email.trim().toLowerCase())
      .executeTakeFirst();
    await this.checkLock(admin);
    const ok = await this.passwords.verify(admin?.passwordHash, password);
    if (!admin || !ok || admin.status !== 'active') {
      if (admin) await this.failed(admin.id, admin.failedAttempts, 'password', meta);
      throw badLogin();
    }
    if (admin.allowedIps.length > 0 && (!meta.ip || !admin.allowedIps.includes(meta.ip))) {
      throw new AppError('ADMIN_IP_BLOCKED', 'The admin site cannot be opened from this network.', HttpStatus.FORBIDDEN);
    }
    if (!admin.totpSecretEnc) {
      throw new AppError('SETUP_NEEDED', 'Please finish setting up your account from the setup link first.', HttpStatus.FORBIDDEN);
    }
    const challengeToken = this.jwt.sign({ aud: 'admin-mfa', sub: admin.id, role: 'support', sid: 'mfa' }, 300);
    return { totpRequired: true as const, challengeToken };
  }

  /** Step 2: the authenticator code → session tokens. */
  async totp(challengeToken: string, code: string, meta: RequestMeta) {
    let adminId: string;
    try {
      adminId = this.jwt.verify(challengeToken, 'admin-mfa').sub;
    } catch {
      throw new AppError('CHALLENGE_EXPIRED', 'This took too long. Please sign in again.', HttpStatus.UNAUTHORIZED);
    }
    const result = await this.dbs.system(async (tx) => {
      const admin = await tx
        .selectFrom('adminUsers')
        .select(['id', 'role', 'status', 'failedAttempts', 'lockedUntil', 'totpLastStep', 'name', 'email'])
        .where('id', '=', adminId)
        .forUpdate()
        .executeTakeFirst();
      await this.checkLock(admin);
      if (!admin || admin.status !== 'active') throw badLogin();
      const step = await this.checkCode(tx, admin.id, code, admin.totpLastStep);
      if (step === null) return { failedAttempts: admin.failedAttempts };
      await tx.updateTable('adminUsers').set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date(), totpLastStep: String(step) }).where('id', '=', admin.id).execute();
      await audit(tx, { actorType: 'admin', actorId: admin.id, action: 'admin.login', entity: 'admin_user', entityId: admin.id, meta });
      const pair = await this.tokens.issueAdmin(tx, { adminId: admin.id, role: admin.role, stepUpAt: step * 30 }, meta);
      return { ...pair, admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role } };
    });
    if ('failedAttempts' in result) {
      // Recorded after the transaction above has released the admin row.
      await this.failed(adminId, result.failedAttempts ?? 0, 'totp', meta);
      throw badLogin();
    }
    return result;
  }

  /** Re-enter the code for risky actions (valid 5 minutes). Returns a fresh access token carrying the new time. */
  async stepUp(who: AdminPrincipal, code: string, meta: RequestMeta) {
    const result = await this.dbs.system(async (tx) => {
      const admin = await tx.selectFrom('adminUsers').select(['id', 'role', 'totpLastStep', 'failedAttempts']).where('id', '=', who.adminId).forUpdate().executeTakeFirstOrThrow();
      const step = await this.checkCode(tx, admin.id, code, admin.totpLastStep);
      if (step === null) return { failedAttempts: admin.failedAttempts };
      await tx.updateTable('adminUsers').set({ totpLastStep: String(step), failedAttempts: 0 }).where('id', '=', admin.id).execute();
      const accessToken = this.jwt.sign({ aud: 'admin', sub: admin.id, role: admin.role, sid: who.sid, su: step * 30 });
      return { accessToken, expiresIn: this.jwt.accessTtlSeconds, stepUpValidSeconds: 300 };
    });
    if ('failedAttempts' in result) {
      await this.failed(who.adminId, result.failedAttempts ?? 0, 'step_up', meta);
      throw new AppError('CODE_WRONG', 'The code is not right. Please try the new code.', HttpStatus.UNAUTHORIZED);
    }
    return result;
  }

  private async checkCode(tx: Tx, adminId: string, code: string, lastStep: string | null): Promise<number | null> {
    const secret = await this.secretOf(tx, adminId);
    if (!secret) return null;
    const step = verifyTotp(secret, code);
    // The same code is never accepted twice (someone watching the screen can't reuse it).
    if (step === null || (lastStep !== null && step <= Number(lastStep))) return null;
    return step;
  }

  private async checkLock(admin?: { lockedUntil: Date | null } | undefined) {
    if (admin?.lockedUntil && new Date(admin.lockedUntil).getTime() > Date.now()) {
      throw new AppError('LOGIN_LOCKED', 'Too many wrong tries. Please wait 15 minutes.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private async failed(adminId: string, prior: number, what: string, meta: RequestMeta) {
    const n = prior + 1;
    await this.dbs.system(async (tx) => {
      await tx
        .updateTable('adminUsers')
        .set({ failedAttempts: n >= LOCK_AFTER ? 0 : n, lockedUntil: n >= LOCK_AFTER ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null })
        .where('id', '=', adminId)
        .execute();
      await audit(tx, { actorType: 'admin', actorId: adminId, action: `admin.login_failed.${what}`, entity: 'admin_user', entityId: adminId, meta });
      if (n >= LOCK_AFTER && this.env.ADMIN_ALERT_EMAIL) {
        await enqueue(tx, { topic: 'email', payload: { to: this.env.ADMIN_ALERT_EMAIL, subject: 'OPflow admin login locked', text: `An admin login was locked after ${LOCK_AFTER} wrong tries (admin ${adminId}, IP ${meta.ip ?? 'unknown'}).` } });
      }
    });
  }

  /** The signed-in admin, for the admin site's header and menu. */
  async me(who: AdminPrincipal) {
    const a = await this.dbs.db.selectFrom('adminUsers').select(['id', 'name', 'email', 'role', 'lastLoginAt']).where('id', '=', who.adminId).executeTakeFirstOrThrow();
    const counts = await sql<{ tickets: number }>`
      select (select count(*)::int from support_tickets where status = 'open') as tickets`.execute(this.dbs.db);
    return { ...a, stepUpAt: who.stepUpAt, badges: counts.rows[0] };
  }

  refresh(refreshToken: string, meta: RequestMeta) {
    return this.tokens.rotate(refreshToken, 'admin', meta);
  }

  async logout(who: AdminPrincipal) {
    await this.dbs.system((tx) => this.tokens.revokeFamily(tx, who.sid));
    return { ok: true };
  }

  // ── Setup links ──────────────────────────────────────────────────────────────────────────────────

  /** Creates a one-time setup link (24 h) with a new authenticator secret. Returns the link token once. */
  async createSetupLink(tx: Tx, adminId: string): Promise<string> {
    const token = randomToken();
    await tx.deleteFrom('adminSetupTokens').where('adminId', '=', adminId).execute();
    await tx
      .insertInto('adminSetupTokens')
      .values({ tokenHash: sha256(token), adminId, totpSecretEnc: await this.encrypt(tx, newTotpSecret()), expiresAt: new Date(Date.now() + SETUP_HOURS * 3_600_000) })
      .execute();
    return token;
  }

  setupUrl(token: string): string {
    return `${this.env.ADMIN_PUBLIC_URL.replace(/\/$/, '')}/setup/${token}`;
  }

  /** The setup page: who it's for and the QR code content. */
  async setupInfo(token: string) {
    return this.dbs.system(async (tx) => {
      const row = await this.setupRow(tx, token);
      const s = await this.decrypt(tx, row.totpSecretEnc);
      return { email: row.email, name: row.name, totpSecret: s, otpauthUrl: otpauthUrl(this.env.ADMIN_TOTP_ISSUER, row.email, s) };
    });
  }

  /** Finish setup: choose a password and prove the authenticator works. */
  async completeSetup(token: string, password: string, code: string, meta: RequestMeta) {
    this.passwords.checkStrength(password, { min: 12 });
    const hash = await this.passwords.hash(password);
    return this.dbs.system(async (tx) => {
      const row = await this.setupRow(tx, token);
      const secret = await this.decrypt(tx, row.totpSecretEnc);
      const step = verifyTotp(secret, code);
      if (step === null) throw new AppError('CODE_WRONG', 'The code is not right. Please check the time on your phone and try the new code.', HttpStatus.UNPROCESSABLE_ENTITY);
      await tx
        .updateTable('adminUsers')
        .set({ passwordHash: hash, totpSecretEnc: row.totpSecretEnc, totpLastStep: String(step), failedAttempts: 0, lockedUntil: null })
        .where('id', '=', row.adminId)
        .execute();
      await tx.updateTable('adminSetupTokens').set({ usedAt: new Date() }).where('tokenHash', '=', sha256(token)).execute();
      await this.tokens.revokeAllForAdmin(tx, row.adminId);
      await audit(tx, { actorType: 'admin', actorId: row.adminId, action: 'admin.setup_complete', entity: 'admin_user', entityId: row.adminId, meta });
      return { ok: true, message: 'Your account is ready. Please sign in.' };
    });
  }

  private async setupRow(tx: Tx, token: string) {
    const row = await tx
      .selectFrom('adminSetupTokens as t')
      .innerJoin('adminUsers as a', 'a.id', 't.adminId')
      .select(['t.adminId', 't.totpSecretEnc', 't.expiresAt', 't.usedAt', 'a.email', 'a.name', 'a.status'])
      .where('t.tokenHash', '=', sha256(token))
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.usedAt || new Date(row.expiresAt).getTime() < Date.now() || row.status !== 'active') {
      throw new AppError('SETUP_LINK_EXPIRED', 'This setup link has expired or was already used. Please ask a super admin for a new one.', HttpStatus.GONE);
    }
    return row;
  }

  /**
   * OPflow has exactly ONE admin (also enforced by the database). Used only by the admin:create command.
   * `replace: true` switches off the current admin first (e.g. a different person takes over).
   */
  async createAdmin(tx: Tx, input: { email: string; name: string; replace?: boolean }) {
    const current = await tx.selectFrom('adminUsers').select(['id', 'email']).where('status', '=', 'active').execute();
    const others = current.filter((a) => a.email.toLowerCase() !== input.email.trim().toLowerCase());
    if (others.length > 0) {
      if (!input.replace) {
        throw new AppError('ONE_ADMIN_ONLY', `OPflow has one admin (${others.map((a) => a.email).join(', ')}). Use --replace to hand over to a new person.`, HttpStatus.CONFLICT);
      }
      for (const a of others) {
        await tx.updateTable('adminUsers').set({ status: 'suspended' }).where('id', '=', a.id).execute();
        await this.tokens.revokeAllForAdmin(tx, a.id);
      }
    }
    // A random password nobody knows; the real one is set through the setup link.
    const placeholder = await this.passwords.hash(randomToken(24));
    const admin = await tx
      .insertInto('adminUsers')
      .values({ email: input.email.trim().toLowerCase(), name: input.name.trim(), role: 'super', passwordHash: placeholder })
      .returning(['id', 'email', 'name', 'role'])
      .executeTakeFirstOrThrow();
    const token = await this.createSetupLink(tx, admin.id);
    return { admin, setupUrl: this.setupUrl(token) };
  }
}
