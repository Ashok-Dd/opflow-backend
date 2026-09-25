import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { HttpStatus } from '@nestjs/common';

import { hmacHex, safeEqual } from '../../common/crypto';
import { AppError } from '../../common/errors/app-error';
import type { Env } from '../../config/env';

export type Bucket = 'public' | 'private';

/**
 * Files: doctor photos (public bucket, served by the CDN) and verification documents (private bucket,
 * 5-minute signed links only). Phones and the admin site upload straight to storage with a short-lived
 * signed URL, so file bytes never pass through the API.
 */
export interface Storage {
  readonly kind: 's3' | 'local';
  presignPut(bucket: Bucket, key: string, contentType: string, expiresSeconds?: number): Promise<{ url: string; headers: Record<string, string> }>;
  presignGet(bucket: Bucket, key: string, expiresSeconds?: number): Promise<string>;
  get(bucket: Bucket, key: string): Promise<Buffer>;
  put(bucket: Bucket, key: string, body: Buffer, contentType: string): Promise<void>;
  publicUrl(key: string): string;
}

export const STORAGE = Symbol('STORAGE');

const storageError = (msg: string) => {
  const e = new AppError('STORAGE_UNAVAILABLE', 'Files cannot be saved right now. Please try again.', HttpStatus.SERVICE_UNAVAILABLE, true);
  e.stack = `${msg}\n${e.stack ?? ''}`;
  return e;
};

// ── S3-compatible (Cloudflare R2 / Supabase Storage), AWS Signature V4 query signing ──────────────────

const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const hmac = (key: Buffer | string, v: string) => createHmac('sha256', key).update(v).digest();
const hash = (v: string) => createHash('sha256').update(v).digest('hex');

export class S3Storage implements Storage {
  readonly kind = 's3' as const;
  private readonly endpoint: URL;

  constructor(private readonly env: Env) {
    const endpoint = env.S3_ENDPOINT ?? (env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);
    if (!endpoint) throw new Error('Set R2_ACCOUNT_ID (Cloudflare R2) or S3_ENDPOINT (Supabase Storage)');
    this.endpoint = new URL(endpoint);
  }

  private bucketName(b: Bucket): string {
    return b === 'public' ? this.env.R2_BUCKET_PUBLIC : this.env.R2_BUCKET_PRIVATE;
  }

  /** Presigned URL (path style): works for the phone's upload and for our own server-side reads/writes. */
  presign(method: 'GET' | 'PUT', bucket: Bucket, key: string, expiresSeconds: number, signedHeaders: Record<string, string> = {}): string {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const day = amzDate.slice(0, 8);
    const region = this.env.S3_REGION;
    const scope = `${day}/${region}/s3/aws4_request`;
    const basePath = this.endpoint.pathname.replace(/\/$/, '');
    const path = `${basePath}/${this.bucketName(bucket)}/${key.split('/').map(enc).join('/')}`;
    const headers: Record<string, string> = { host: this.endpoint.host, ...Object.fromEntries(Object.entries(signedHeaders).map(([k, v]) => [k.toLowerCase(), v])) };
    const headerNames = Object.keys(headers).sort();
    const query: Record<string, string> = {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.env.R2_ACCESS_KEY_ID}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiresSeconds),
      'X-Amz-SignedHeaders': headerNames.join(';'),
    };
    const canonicalQuery = Object.keys(query)
      .sort()
      .map((k) => `${enc(k)}=${enc(query[k]!)}`)
      .join('&');
    const canonical = [
      method,
      path,
      canonicalQuery,
      headerNames.map((h) => `${h}:${headers[h]!.trim()}\n`).join(''),
      headerNames.join(';'),
      'UNSIGNED-PAYLOAD',
    ].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hash(canonical)].join('\n');
    const kDate = hmac(`AWS4${this.env.R2_SECRET_ACCESS_KEY}`, day);
    const kSigning = hmac(hmac(hmac(kDate, region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', kSigning).update(toSign).digest('hex');
    return `${this.endpoint.protocol}//${this.endpoint.host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
  }

  async presignPut(bucket: Bucket, key: string, contentType: string, expiresSeconds = 300) {
    return { url: this.presign('PUT', bucket, key, expiresSeconds, { 'content-type': contentType }), headers: { 'content-type': contentType } };
  }

  async presignGet(bucket: Bucket, key: string, expiresSeconds = 300): Promise<string> {
    return this.presign('GET', bucket, key, expiresSeconds);
  }

  async get(bucket: Bucket, key: string): Promise<Buffer> {
    const res = await fetch(this.presign('GET', bucket, key, 60), { signal: AbortSignal.timeout(20_000) }).catch((e: Error) => {
      throw storageError(`S3 GET ${key}: ${e.message}`);
    });
    if (!res.ok) throw storageError(`S3 GET ${key} → ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async put(bucket: Bucket, key: string, body: Buffer, contentType: string): Promise<void> {
    const res = await fetch(this.presign('PUT', bucket, key, 60, { 'content-type': contentType }), {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(20_000),
    }).catch((e: Error) => {
      throw storageError(`S3 PUT ${key}: ${e.message}`);
    });
    if (!res.ok) throw storageError(`S3 PUT ${key} → ${res.status}`);
  }

  publicUrl(key: string): string {
    return `${(this.env.CDN_PUBLIC_BASE_URL ?? '').replace(/\/$/, '')}/${key}`;
  }
}

// ── Local disk (APP_ENV=local only) ───────────────────────────────────────────────────────────────────

/**
 * Files in backend/.uploads, uploaded and downloaded through /v1/dev/files/… with an HMAC-signed, expiring
 * link, the same flow as the real presigned URLs.
 */
export class LocalStorage implements Storage {
  readonly kind = 'local' as const;
  private readonly root = resolve('.uploads');
  private readonly secret: string;

  constructor(private readonly env: Env) {
    this.secret = env.DATA_ENCRYPTION_KEY ?? 'opflow-local-storage-secret'; // env.ts requires the key off local
  }

  private path(bucket: Bucket, key: string): string {
    const p = resolve(join(this.root, bucket, key));
    if (!p.startsWith(join(this.root, bucket))) throw new AppError('NOT_FOUND', 'Not found.', HttpStatus.NOT_FOUND);
    return p;
  }

  sign(method: string, bucket: Bucket, key: string, exp: number): string {
    return hmacHex(this.secret, `${method}|${bucket}|${key}|${exp}`);
  }

  verify(method: string, bucket: Bucket, key: string, exp: number, sig: string): boolean {
    return exp > Date.now() / 1000 && safeEqual(this.sign(method, bucket, key, exp), sig);
  }

  private link(method: string, bucket: Bucket, key: string, expiresSeconds: number): string {
    const exp = Math.floor(Date.now() / 1000) + expiresSeconds;
    return `${this.env.API_PUBLIC_URL}/v1/dev/files/${bucket}/${key}?exp=${exp}&sig=${this.sign(method, bucket, key, exp)}`;
  }

  async presignPut(bucket: Bucket, key: string, contentType: string, expiresSeconds = 300) {
    return { url: this.link('PUT', bucket, key, expiresSeconds), headers: { 'content-type': contentType } };
  }

  async presignGet(bucket: Bucket, key: string, expiresSeconds = 300): Promise<string> {
    return this.link('GET', bucket, key, expiresSeconds);
  }

  async get(bucket: Bucket, key: string): Promise<Buffer> {
    try {
      return await readFile(this.path(bucket, key));
    } catch {
      throw new AppError('FILE_NOT_FOUND', 'The file was not uploaded yet. Please try again.', HttpStatus.NOT_FOUND);
    }
  }

  async put(bucket: Bucket, key: string, body: Buffer): Promise<void> {
    const p = this.path(bucket, key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }

  publicUrl(key: string): string {
    return `${this.env.API_PUBLIC_URL}/v1/dev/files/public/${key}`;
  }
}
