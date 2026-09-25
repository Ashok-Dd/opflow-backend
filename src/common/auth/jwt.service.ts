import { createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject, sign, verify } from 'node:crypto';

import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';

import { ENV, Env, isLocal } from '../../config/env';
import { AppError } from '../errors/app-error';

export type AppRole = 'patient' | 'doctor';
export type AdminRoleName = 'super' | 'ops' | 'finance' | 'support' | 'content';

/** What an access token says. Short-lived (15 min); the refresh token (in the database) is the real session. */
export interface AccessClaims {
  iss: string;
  aud: 'app' | 'admin' | 'pwchange' | 'admin-mfa';
  sub: string; // user id (app) or admin id
  role: AppRole | AdminRoleName;
  did?: string; // doctor id, for doctor logins
  sid: string; // session (refresh-token family) id
  su?: number; // admin: last authenticator check (unix seconds), for step-up
  iat: number;
  exp: number;
}

const b64url = (v: Buffer | string) => Buffer.from(v).toString('base64url');

/**
 * EdDSA (Ed25519) JWTs with Node's own crypto. Keys come from the environment (base64 PEM). Locally, when
 * they're empty, a throwaway pair is made at startup, so tokens simply stop working after a restart there.
 */
@Injectable()
export class JwtService {
  private readonly log = new Logger(JwtService.name);
  private readonly privateKey: KeyObject;
  private readonly kid: string;
  private readonly publicKeys = new Map<string, KeyObject>();

  constructor(@Inject(ENV) private readonly env: Env) {
    this.kid = env.JWT_KEY_ID;
    if (env.JWT_ACCESS_PRIVATE_KEY_B64 && env.JWT_ACCESS_PUBLIC_KEY_B64) {
      this.privateKey = createPrivateKey(Buffer.from(env.JWT_ACCESS_PRIVATE_KEY_B64, 'base64').toString('utf8'));
      this.publicKeys.set(this.kid, createPublicKey(Buffer.from(env.JWT_ACCESS_PUBLIC_KEY_B64, 'base64').toString('utf8')));
    } else if (isLocal(env)) {
      const pair = generateKeyPairSync('ed25519');
      this.privateKey = pair.privateKey;
      this.publicKeys.set(this.kid, pair.publicKey);
      this.log.warn('JWT keys not set: using a throwaway key pair (local only). Run `npm run keys:generate` to make real ones.');
    } else {
      throw new Error('JWT_ACCESS_PRIVATE_KEY_B64 / JWT_ACCESS_PUBLIC_KEY_B64 are required');
    }
    if (env.JWT_PREVIOUS_PUBLIC_KEY_B64 && env.JWT_PREVIOUS_KEY_ID) {
      this.publicKeys.set(env.JWT_PREVIOUS_KEY_ID, createPublicKey(Buffer.from(env.JWT_PREVIOUS_PUBLIC_KEY_B64, 'base64').toString('utf8')));
    }
  }

  get accessTtlSeconds(): number {
    return this.env.JWT_ACCESS_TTL_SECONDS;
  }

  sign(claims: Omit<AccessClaims, 'iss' | 'iat' | 'exp'>, ttlSeconds = this.env.JWT_ACCESS_TTL_SECONDS): string {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: this.kid }));
    const payload = b64url(JSON.stringify({ ...claims, iss: this.env.JWT_ISSUER, iat: now, exp: now + ttlSeconds }));
    const signature = sign(null, Buffer.from(`${header}.${payload}`), this.privateKey);
    return `${header}.${payload}.${b64url(signature)}`;
  }

  /** Checks signature, issuer, audience and expiry. Any problem → 401 (the app refreshes once, then logs out). */
  verify(token: string, audience: AccessClaims['aud']): AccessClaims {
    const unauthenticated = (code = 'UNAUTHENTICATED') => new AppError(code, 'Please log in again.', HttpStatus.UNAUTHORIZED);
    const parts = token.split('.');
    if (parts.length !== 3) throw unauthenticated();
    const [h, p, s] = parts as [string, string, string];
    let header: { alg?: string; kid?: string };
    let claims: AccessClaims;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    } catch {
      throw unauthenticated();
    }
    const key = header.alg === 'EdDSA' && header.kid ? this.publicKeys.get(header.kid) : undefined;
    if (!key || !verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) throw unauthenticated();
    if (claims.iss !== this.env.JWT_ISSUER || claims.aud !== audience) throw unauthenticated();
    if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) throw unauthenticated('TOKEN_EXPIRED');
    return claims;
  }
}
