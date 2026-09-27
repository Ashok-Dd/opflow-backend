import { randomInt } from 'node:crypto';

import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';

import type { RequestMeta } from '../../common/auth/auth.decorators';
import { JwtService } from '../../common/auth/jwt.service';
import { hmacHex, safeEqual } from '../../common/crypto';
import { AppError } from '../../common/errors/app-error';
import { allowsStandIns, ENV, Env, phoneLogin } from '../../config/env';
import { isUniqueViolation } from '../../common/errors/pg-errors';
import { DbService, Tx } from '../../infra/db/db.service';
import { PHONE_VERIFIER, PhoneVerifier } from '../../infra/firebase/phone-verifier';
import { LogOtp, OTP_SENDER, OtpSender } from '../../infra/messaging/messaging';
import { RateLimiter } from '../../infra/redis/rate-limit';
import { PasswordsService } from './passwords.service';
import { TokenPair, TokensService } from './tokens.service';

export interface DeviceInput {
  platform: 'android' | 'ios' | 'web';
  fcmToken?: string;
  installId?: string;
  appVersion?: string;
  locale?: string;
}

const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;

const OTP_MINUTES = 5;
const OTP_TRIES = 5;
const OTP_RESEND_SECONDS = 30;
const OTP_PER_HOUR = 5;

const wrongLogin = () =>
  new AppError('LOGIN_FAILED', 'The login ID or password is not right. Please check and try again.', HttpStatus.UNAUTHORIZED);

@Injectable()
export class AuthService {
  constructor(
    private readonly dbs: DbService,
    private readonly tokens: TokensService,
    private readonly passwords: PasswordsService,
    private readonly jwt: JwtService,
    private readonly limiter: RateLimiter,
    @Inject(PHONE_VERIFIER) private readonly phones: PhoneVerifier,
    @Inject(OTP_SENDER) private readonly otp: OtpSender,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private readonly log = new Logger('Auth');

  private otpHash(phone: string, code: string): string {
    return hmacHex(this.env.PASSWORD_PEPPER ?? 'opflow-local-only-otp-key', `otp|${phone}|${code}`);
  }

  /**
   * Patient login, step 1: send a 6-digit code by SMS. When this server logs in another way (demo code on a
   * test server, Firebase), nothing is sent and the app is told which way to use.
   */
  async sendPatientOtp(phone: string, meta: RequestMeta): Promise<{ mode: 'sms' | 'firebase' | 'demo'; resendAfterSeconds?: number; expiresInSeconds?: number; testCode?: string }> {
    const mode = phoneLogin(this.env);
    if (mode !== 'sms') return { mode };
    await this.limiter.check(`otp-send:${phone}`, OTP_PER_HOUR, 3600);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const id = await this.dbs.system(async (tx) => {
      const last = await tx.selectFrom('phoneOtps').select('createdAt').where('phone', '=', phone).orderBy('createdAt', 'desc').executeTakeFirst();
      const waited = last ? (Date.now() - new Date(last.createdAt).getTime()) / 1000 : Infinity;
      if (waited < OTP_RESEND_SECONDS) {
        const wait = Math.ceil(OTP_RESEND_SECONDS - waited);
        throw new AppError('OTP_WAIT', `Please wait ${wait} seconds before asking for a new code.`, HttpStatus.TOO_MANY_REQUESTS, true);
      }
      const hour = await tx
        .selectFrom('phoneOtps')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('phone', '=', phone)
        .where('createdAt', '>', new Date(Date.now() - 3_600_000))
        .executeTakeFirstOrThrow();
      if (Number(hour.n) >= OTP_PER_HOUR) {
        throw new AppError('OTP_LIMIT', 'Too many codes asked for this number. Please try again after an hour.', HttpStatus.TOO_MANY_REQUESTS);
      }
      await tx.deleteFrom('phoneOtps').where('phone', '=', phone).where('createdAt', '<', new Date(Date.now() - 86_400_000)).execute();
      const row = await tx
        .insertInto('phoneOtps')
        .values({ phone, codeHash: this.otpHash(phone, code), expiresAt: new Date(Date.now() + OTP_MINUTES * 60_000), ip: meta.ip })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });
    try {
      await this.otp.send(phone, code);
    } catch (err) {
      this.log.error(`Login code SMS failed: ${(err as Error).message}`);
      await this.dbs.system((tx) => tx.deleteFrom('phoneOtps').where('id', '=', id).execute());
      throw new AppError('OTP_UNAVAILABLE', 'We could not send the code right now. Please try again in a minute.', HttpStatus.SERVICE_UNAVAILABLE, true);
    }
    // No SMS provider yet (a laptop or test server only): the app shows the code on screen instead. Never on
    // production, where a real SMS is required (see env.ts), and never once MSG91 sends real messages.
    const testCode = this.otp instanceof LogOtp && allowsStandIns(this.env) ? code : undefined;
    return { mode, resendAfterSeconds: OTP_RESEND_SECONDS, expiresInSeconds: OTP_MINUTES * 60, ...(testCode ? { testCode } : {}) };
  }

  /** Patient login, step 2: the code from the SMS. Only the newest code counts; 5 tries; it works once. */
  async verifyPatientOtp(phone: string, code: string, device: DeviceInput | undefined, meta: RequestMeta) {
    if (phoneLogin(this.env) !== 'sms') throw new AppError('OTP_INVALID', 'The code did not work. Please ask for a new code.', HttpStatus.UNAUTHORIZED);
    const ok = await this.dbs.system(async (tx) => {
      const row = await tx.selectFrom('phoneOtps').selectAll().where('phone', '=', phone).orderBy('createdAt', 'desc').forUpdate().executeTakeFirst();
      if (!row || row.usedAt || new Date(row.expiresAt).getTime() <= Date.now()) {
        throw new AppError('OTP_EXPIRED', 'This code has expired. Please ask for a new code.', HttpStatus.UNAUTHORIZED);
      }
      if (row.attempts >= OTP_TRIES) {
        throw new AppError('OTP_TOO_MANY', 'Too many wrong tries. Please ask for a new code.', HttpStatus.TOO_MANY_REQUESTS);
      }
      if (!safeEqual(row.codeHash, this.otpHash(phone, code))) {
        await tx.updateTable('phoneOtps').set({ attempts: row.attempts + 1 }).where('id', '=', row.id).execute();
        return false;
      }
      await tx.updateTable('phoneOtps').set({ usedAt: new Date() }).where('id', '=', row.id).execute();
      return true;
    });
    if (!ok) throw new AppError('OTP_INVALID', 'The code is not right. Please check the SMS and try again.', HttpStatus.UNAUTHORIZED);
    return this.loginPatient(phone, device, meta);
  }

  /**
   * Patient login: the app proves the phone number with Firebase (OTP on the phone), and we swap that proof
   * for our own session. First login creates the account; the profile (name, age) comes next in the app.
   */
  async patientExchange(idToken: string, device: DeviceInput | undefined, meta: RequestMeta) {
    // Closed while SMS codes are on: a login must come through /auth/patient/otp/verify.
    if (phoneLogin(this.env) === 'sms') throw new AppError('OTP_INVALID', 'The code did not work. Please ask for a new code.', HttpStatus.UNAUTHORIZED);
    const phone = await this.phones.verify(idToken);
    await this.limiter.check(`otp:${phone}`, 5, 60);
    return this.loginPatient(phone, device, meta);
  }

  /** The phone is proven: sign in, creating the account on the first login. */
  private loginPatient(phone: string, device: DeviceInput | undefined, meta: RequestMeta) {
    return this.dbs.system(async (tx) => {
      let user = await tx.selectFrom('users').select(['id', 'status']).where('phone', '=', phone).executeTakeFirst();
      if (!user) {
        user = await tx.insertInto('users').values({ phone }).returning(['id', 'status']).executeTakeFirstOrThrow();
      }
      if (user.status !== 'active') {
        throw new AppError('ACCOUNT_BLOCKED', 'This account is blocked. Please contact OPflow support.', HttpStatus.FORBIDDEN);
      }
      await tx.insertInto('userRoles').values({ userId: user.id, role: 'patient' }).onConflict((oc) => oc.doNothing()).execute();
      await tx.insertInto('notificationPrefs').values({ userId: user.id }).onConflict((oc) => oc.doNothing()).execute();
      await tx.updateTable('users').set({ lastLoginAt: new Date() }).where('id', '=', user.id).execute();
      const deviceId = device ? await this.saveDevice(tx, user.id, device) : null;
      const pair = await this.tokens.issueApp(tx, { userId: user.id, role: 'patient' }, { ...meta, deviceId });
      const profile = await tx.selectFrom('patientProfiles').select(['name', 'birthYear', 'gender', 'place', 'placeLat', 'placeLng']).where('userId', '=', user.id).executeTakeFirst();
      return {
        ...pair,
        user: { id: user.id, phone, role: 'patient' as const, needsProfile: !profile, profile: profile ?? null },
      };
    });
  }

  /** Doctor login with the ID and password the OPflow team gave them. Five wrong tries lock it for 15 minutes. */
  async doctorLogin(loginId: string, password: string, device: DeviceInput | undefined, meta: RequestMeta) {
    const id = loginId.trim().toUpperCase();
    const cred = await this.dbs.db
      .selectFrom('doctorCredentials as c')
      .innerJoin('users as u', 'u.id', 'c.userId')
      .innerJoin('doctors as d', 'd.userId', 'c.userId')
      .select(['c.userId', 'c.passwordHash', 'c.mustChange', 'c.failedAttempts', 'c.lockedUntil', 'u.status as userStatus', 'd.id as doctorId', 'd.status as doctorStatus', 'd.name'])
      .where('c.loginId', '=', id)
      .executeTakeFirst();

    if (cred?.lockedUntil && new Date(cred.lockedUntil).getTime() > Date.now()) {
      const mins = Math.ceil((new Date(cred.lockedUntil).getTime() - Date.now()) / 60_000);
      throw new AppError('LOGIN_LOCKED', `Too many wrong tries. Please wait ${mins} minute${mins === 1 ? '' : 's'} and try again.`, HttpStatus.TOO_MANY_REQUESTS);
    }
    const ok = await this.passwords.verify(cred?.passwordHash, password);
    if (!cred || !ok) {
      if (cred) {
        const failed = cred.failedAttempts + 1;
        await this.dbs.system((tx) =>
          tx
            .updateTable('doctorCredentials')
            .set({ failedAttempts: failed >= LOCK_AFTER ? 0 : failed, lockedUntil: failed >= LOCK_AFTER ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null })
            .where('userId', '=', cred.userId)
            .execute(),
        );
      }
      throw wrongLogin();
    }
    if (cred.userStatus !== 'active' || cred.doctorStatus !== 'active') {
      throw new AppError('ACCOUNT_BLOCKED', 'This login is stopped. Please contact the OPflow team.', HttpStatus.FORBIDDEN);
    }
    await this.dbs.system((tx) =>
      tx.updateTable('doctorCredentials').set({ failedAttempts: 0, lockedUntil: null }).where('userId', '=', cred.userId).execute(),
    );
    if (cred.mustChange) {
      // First login: the password the team gave must be changed before anything else.
      const changeToken = this.jwt.sign({ aud: 'pwchange', sub: cred.userId, role: 'doctor', did: cred.doctorId, sid: 'pwchange' }, 600);
      return { mustChange: true as const, changeToken, doctor: { id: cred.doctorId, name: cred.name, loginId: id } };
    }
    return this.dbs.system(async (tx) => {
      await tx.updateTable('users').set({ lastLoginAt: new Date() }).where('id', '=', cred.userId).execute();
      const deviceId = device ? await this.saveDevice(tx, cred.userId, device) : null;
      const pair = await this.tokens.issueApp(tx, { userId: cred.userId, role: 'doctor', doctorId: cred.doctorId }, { ...meta, deviceId });
      return { mustChange: false as const, ...pair, doctor: { id: cred.doctorId, name: cred.name, loginId: id } };
    });
  }

  /** First-login password change (with the short-lived change token), then logs the doctor in. */
  async doctorSetPassword(changeToken: string, newPassword: string, device: DeviceInput | undefined, meta: RequestMeta) {
    let claims;
    try {
      claims = this.jwt.verify(changeToken, 'pwchange');
    } catch {
      throw new AppError('CHANGE_EXPIRED', 'This took too long. Please log in again with the password you were given.', HttpStatus.UNAUTHORIZED);
    }
    const cred = await this.dbs.db
      .selectFrom('doctorCredentials')
      .select(['userId', 'loginId', 'passwordHash', 'mustChange'])
      .where('userId', '=', claims.sub)
      .executeTakeFirst();
    if (!cred || !cred.mustChange) throw new AppError('CHANGE_EXPIRED', 'Please log in again.', HttpStatus.UNAUTHORIZED);
    this.passwords.checkStrength(newPassword, { notSameAs: [cred.loginId] });
    if (await this.passwords.verify(cred.passwordHash, newPassword)) {
      throw new AppError('SAME_PASSWORD', 'Please choose a new password, not the one you were given.', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const hash = await this.passwords.hash(newPassword);
    return this.dbs.system(async (tx) => {
      const updated = await tx
        .updateTable('doctorCredentials')
        .set({ passwordHash: hash, mustChange: false, passwordChangedAt: new Date(), failedAttempts: 0, lockedUntil: null })
        .where('userId', '=', cred.userId)
        .where('mustChange', '=', true)
        .executeTakeFirst();
      if (Number(updated.numUpdatedRows) !== 1) throw new AppError('CHANGE_EXPIRED', 'Please log in again.', HttpStatus.UNAUTHORIZED);
      await tx.updateTable('users').set({ lastLoginAt: new Date() }).where('id', '=', cred.userId).execute();
      const deviceId = device ? await this.saveDevice(tx, cred.userId, device) : null;
      const pair: TokenPair = await this.tokens.issueApp(tx, { userId: cred.userId, role: 'doctor', doctorId: claims.did }, { ...meta, deviceId });
      return { ...pair, doctor: { id: claims.did, loginId: cred.loginId } };
    });
  }

  /** Remembers the phone for pushes. One FCM token belongs to one account at a time. */
  async saveDevice(tx: Tx, userId: string, d: DeviceInput): Promise<string> {
    // The same install (app or browser) is the same device, even when its push token changed or is missing.
    if (d.installId) {
      const same = await tx.selectFrom('devices').select('id').where('installId', '=', d.installId).orderBy('lastSeenAt', 'desc').executeTakeFirst();
      if (same) {
        if (d.fcmToken) await tx.updateTable('devices').set({ fcmToken: null }).where('fcmToken', '=', d.fcmToken).where('id', '<>', same.id).execute();
        await tx
          .updateTable('devices')
          .set({ userId, platform: d.platform, fcmToken: d.fcmToken ?? undefined, appVersion: d.appVersion ?? null, locale: d.locale ?? null, lastSeenAt: new Date() })
          .where('id', '=', same.id)
          .execute();
        return same.id;
      }
    }
    if (d.fcmToken) {
      const existing = await tx.selectFrom('devices').select(['id', 'userId']).where('fcmToken', '=', d.fcmToken).executeTakeFirst();
      if (existing) {
        await tx
          .updateTable('devices')
          .set({ userId, platform: d.platform, appVersion: d.appVersion ?? null, locale: d.locale ?? null, lastSeenAt: new Date(), ...(d.installId ? { installId: d.installId } : {}) })
          .where('id', '=', existing.id)
          .execute();
        return existing.id;
      }
    }
    try {
      const row = await tx
        .insertInto('devices')
        .values({ userId, platform: d.platform, fcmToken: d.fcmToken ?? null, installId: d.installId ?? null, appVersion: d.appVersion ?? null, locale: d.locale ?? null })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    } catch (err) {
      if (isUniqueViolation(err)) throw new AppError('CONFLICT', 'Please try again.', HttpStatus.CONFLICT, true);
      throw err;
    }
  }
}
