import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const sha256 = (value: string | Buffer): Buffer => createHash('sha256').update(value).digest();

export const hmacHex = (secret: string, value: string | Buffer): string =>
  createHmac('sha256', secret).update(value).digest('hex');

/** Constant-time string comparison (signatures, codes). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Random URL-safe token (refresh tokens, setup links). 32 bytes = 256 bits. */
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

const CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O, 1/I: easy to read out on the phone

/** Booking code printed on tickets: OPF + 6 characters (matches the database check). */
export function bookingCode(): string {
  let s = 'OPF';
  for (let i = 0; i < 6; i++) s += CODE_CHARS[randomInt(CODE_CHARS.length)];
  return s;
}

/** One-time password for a new doctor login: 12 characters, easy to read out, always has letters and digits. */
export function oneTimePassword(length = 12): string {
  const letters = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const all = letters + digits;
  const chars = [letters[randomInt(letters.length)]!, digits[randomInt(digits.length)]!];
  while (chars.length < length) chars.push(all[randomInt(all.length)]!);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

// ── TOTP (RFC 6238): the admin authenticator code ────────────────────────────────────────────────────

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = (): string => base32Encode(randomBytes(20));

export function totpAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = h[h.length - 1]! & 0xf;
  const code = (h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

export const totpStep = (at = Date.now()): number => Math.floor(at / 30_000);

/**
 * Checks a 6-digit code against the current 30-second step and one step either side (clock drift).
 * Returns the matching step (store it: the same step must not be accepted twice), or null.
 */
export function verifyTotp(secret: string, code: string, at = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = totpStep(at);
  for (const step of [now, now - 1, now + 1]) {
    if (safeEqual(totpAt(secret, step), code)) return step;
  }
  return null;
}

export function otpauthUrl(issuer: string, account: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
