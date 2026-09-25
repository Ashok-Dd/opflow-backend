import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { type Algorithm, hash, verify } from '@node-rs/argon2';

import { AppError } from '../../common/errors/app-error';
import { ENV, Env, isLocal } from '../../config/env';

const ARGON2ID = 2 as Algorithm;

/** A hash made once at startup, so an unknown login ID costs the same time as a wrong password. */
let dummyHash: Promise<string> | undefined;

/**
 * Doctor and admin passwords: argon2id (OWASP settings) with a server-side pepper. A database leak alone
 * is not enough to test guesses offline.
 */
@Injectable()
export class PasswordsService {
  private readonly log = new Logger(PasswordsService.name);
  private readonly secret: Buffer;

  constructor(@Inject(ENV) env: Env) {
    if (env.PASSWORD_PEPPER) this.secret = Buffer.from(env.PASSWORD_PEPPER, 'base64');
    else if (isLocal(env)) {
      this.secret = Buffer.from('opflow-local-only-pepper-not-for-servers!!');
      this.log.warn('PASSWORD_PEPPER not set: using the local-only pepper.');
    } else throw new Error('PASSWORD_PEPPER is required');
  }

  hash(password: string): Promise<string> {
    return hash(password, { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1, secret: this.secret });
  }

  async verify(stored: string | null | undefined, password: string): Promise<boolean> {
    if (!stored) {
      dummyHash ??= this.hash('opflow-timing-equaliser');
      await verify(await dummyHash, password, { secret: this.secret }).catch(() => false);
      return false;
    }
    return verify(stored, password, { secret: this.secret }).catch(() => false);
  }

  /** Simple rules the doctor can understand, checked before hashing. */
  checkStrength(password: string, opts: { min?: number; notSameAs?: string[] } = {}): void {
    const min = opts.min ?? 8;
    const bad = (m: string) => new AppError('WEAK_PASSWORD', m, HttpStatus.UNPROCESSABLE_ENTITY);
    if (password.length < min) throw bad(`Please use at least ${min} letters and numbers.`);
    if (password.length > 128) throw bad('This password is too long.');
    if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) throw bad('Please use both letters and numbers.');
    if (/^(.)\1+$/.test(password) || /^(12345678|password|opflow)/i.test(password)) throw bad('This password is too easy to guess.');
    for (const other of opts.notSameAs ?? []) {
      if (other && password.toLowerCase().includes(other.toLowerCase())) throw bad('Please do not use your login ID or name in the password.');
    }
  }
}
