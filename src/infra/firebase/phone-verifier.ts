import { createPublicKey, verify } from 'node:crypto';

import { HttpStatus } from '@nestjs/common';

import { safeEqual } from '../../common/crypto';
import { AppError } from '../../common/errors/app-error';
import type { Env } from '../../config/env';

/** Proves a patient owns a phone number. Returns the number in E.164 (+91…). */
export interface PhoneVerifier {
  verify(idToken: string): Promise<string>;
}
export const PHONE_VERIFIER = Symbol('PHONE_VERIFIER');

const invalid = () => new AppError('OTP_INVALID', 'The code did not work. Please ask for a new code.', HttpStatus.UNAUTHORIZED);

const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

/**
 * Checks a Firebase Phone Auth ID token the way the Firebase Admin SDK does: RS256 signature against
 * Google's published certificates (cached per their max-age), audience = our project, issuer, expiry,
 * and a phone number in the token.
 */
export class FirebasePhoneVerifier implements PhoneVerifier {
  private certs?: { at: number; maxAgeMs: number; keys: Record<string, string> };

  constructor(private readonly env: Env) {}

  private async keys(): Promise<Record<string, string>> {
    if (this.certs && Date.now() - this.certs.at < this.certs.maxAgeMs) return this.certs.keys;
    const res = await fetch(CERTS_URL, { signal: AbortSignal.timeout(5000) }).catch(() => undefined);
    if (!res?.ok) {
      if (this.certs) return this.certs.keys; // keep using the last good set
      throw new AppError('OTP_UNAVAILABLE', 'Login is not working right now. Please try again in a minute.', HttpStatus.SERVICE_UNAVAILABLE, true);
    }
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 3600);
    this.certs = { at: Date.now(), maxAgeMs: maxAge * 1000, keys: (await res.json()) as Record<string, string> };
    return this.certs.keys;
  }

  async verify(idToken: string): Promise<string> {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw invalid();
    const [h, p, s] = parts as [string, string, string];
    let header: { alg?: string; kid?: string };
    let claims: { aud?: string; iss?: string; exp?: number; iat?: number; auth_time?: number; sub?: string; phone_number?: string };
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString());
      claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    } catch {
      throw invalid();
    }
    if (header.alg !== 'RS256' || !header.kid) throw invalid();
    const cert = (await this.keys())[header.kid];
    if (!cert || !verify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey(cert), Buffer.from(s, 'base64url'))) throw invalid();
    const now = Math.floor(Date.now() / 1000);
    const project = this.env.FIREBASE_PROJECT_ID;
    if (claims.aud !== project || claims.iss !== `https://securetoken.google.com/${project}`) throw invalid();
    if (!claims.exp || claims.exp <= now || !claims.iat || claims.iat > now + 60 || !claims.sub) throw invalid();
    if (claims.auth_time && claims.auth_time > now + 60) throw invalid();
    if (!claims.phone_number || !/^\+[1-9]\d{7,14}$/.test(claims.phone_number)) throw invalid();
    return claims.phone_number;
  }
}

/**
 * Stand-in for Firebase, never used in production (see infra.module). The "token" is `dev:+919876543210:123456`.
 * Locally any code works. On a staging demo server the code must equal DEMO_OTP_CODE, so a public test server
 * can't be logged into as anyone by anyone.
 */
export class DevPhoneVerifier implements PhoneVerifier {
  constructor(private readonly requiredCode: string | null = null) {}

  async verify(idToken: string): Promise<string> {
    const m = /^dev:(\+91[6-9]\d{9})(?::(\d{6}))?$/.exec(idToken);
    if (!m) throw invalid();
    if (this.requiredCode !== null && (m[2] === undefined || !safeEqual(m[2], this.requiredCode))) throw invalid();
    return m[1]!;
  }
}

/** SMS-code login is on: the Firebase/dev token exchange is closed (the app uses /auth/patient/otp). */
export class ClosedPhoneVerifier implements PhoneVerifier {
  async verify(): Promise<string> {
    throw invalid();
  }
}
