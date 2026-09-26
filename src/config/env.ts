import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { z } from 'zod';

/**
 * Environment variables, checked once at startup. A missing or malformed value stops the process with a
 * clear message instead of failing later in the middle of a request.
 *
 * Locally, every outside service (Firebase, Razorpay, R2, Resend, MSG91, Redis) is optional and replaced by a
 * safe stand-in, so the whole backend runs with only DATABASE_URL. On staging/production the real ones are
 * required. Full documentation: backend/.env.example.
 */
const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const postgresUrl = z
  .string()
  .min(1)
  .refine((v) => /^postgres(ql)?:\/\//.test(v), 'must be a postgresql:// connection string');

export const envSchema = z
  .object({
    // Runtime
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    APP_ENV: z.enum(['local', 'staging', 'production']).default('local'),
    PROCESS_TYPE: z.enum(['api', 'worker']).default('api'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    TRUST_PROXY: bool.default(false),
    // Render sets RENDER_EXTERNAL_URL (https://<service>.onrender.com) for every web service.
    API_PUBLIC_URL: z.string().default(() => process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:3000'),
    CORS_ORIGINS: z
      .string()
      .default('')
      .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

    // Database (Supabase Postgres, transaction pooler, as opflow_api)
    DATABASE_URL: postgresUrl,
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).max(60000).default(5000),
    // Supabase's CA certificate (Dashboard → Database → SSL configuration → Download certificate), base64.
    // Required outside local development, so the connection can't be intercepted.
    DB_SSL_CA_B64: z.string().optional(),

    // Redis (Upstash). Optional: without it, rate limits and live updates work inside one process
    // (fine for one API machine). Set it before running two or more API machines.
    REDIS_URL: z
      .string()
      .regex(/^rediss?:\/\/[^<>\s]+$/, 'must be a redis:// or rediss:// URL (or leave it empty)')
      .optional(),
    REDIS_KEY_PREFIX: z.string().default('opflow:'),

    // Background jobs. Locally they run inside the API process too, so one `npm run start:dev` does everything.
    JOBS_IN_API: bool.optional(),
    OUTBOX_POLL_MS: z.coerce.number().int().min(100).max(60000).default(1000),
    HOLD_SWEEP_SECONDS: z.coerce.number().int().min(5).max(600).default(30),

    // Our own tokens (Ed25519). Locally a throwaway key pair is made at startup if these are empty.
    JWT_ACCESS_PRIVATE_KEY_B64: z.string().optional(),
    JWT_ACCESS_PUBLIC_KEY_B64: z.string().optional(),
    JWT_KEY_ID: z.string().default('local'),
    JWT_PREVIOUS_PUBLIC_KEY_B64: z.string().optional(),
    JWT_PREVIOUS_KEY_ID: z.string().optional(),
    JWT_ISSUER: z.string().default('https://api.opflow.in'),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    ADMIN_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24).default(8),
    ADMIN_IDLE_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
    PASSWORD_PEPPER: z.string().optional(),
    DATA_ENCRYPTION_KEY: z.string().optional(),

    // Firebase (patient OTP login + push). Without it, locally only: the phone number itself is the "token"
    // (`dev:+919876543210`), and pushes are written to the log.
    FIREBASE_PROJECT_ID: z.string().optional(),
    FIREBASE_CLIENT_EMAIL: z.string().optional(),
    FIREBASE_PRIVATE_KEY_B64: z.string().optional(),
    // Patient login (see phoneLogin below): "sms" = our own code sent by MSG91, "firebase" = Firebase phone login,
    // "demo" = the dev/demo code. "demo" is refused where stand-ins are not allowed.
    PHONE_LOGIN: z.enum(['sms', 'firebase', 'demo']).optional(),

    // SMS (doctor one-time passwords). Without it, messages are written to the log (local only).
    MSG91_AUTH_KEY: z.string().optional(),
    MSG91_SMS_TEMPLATE_ID: z.string().optional(),
    // The DLT-approved OTP template (its text uses ##OTP##), for patient login codes.
    MSG91_OTP_TEMPLATE_ID: z.string().optional(),
    MSG91_SENDER_ID: z.string().default('OPFLOW'),

    // Razorpay. Without keys, locally only: a built-in fake that behaves like Razorpay test mode.
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
    RAZORPAY_ROUTE_ENABLED: bool.default(true),
    RAZORPAY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(5000),

    // File storage (S3-compatible: Cloudflare R2 or Supabase Storage). Without it, locally only: files are
    // kept in backend/.uploads and served by the API.
    STORAGE_PROVIDER: z.enum(['r2', 'supabase', 'local']).optional(),
    R2_ACCOUNT_ID: z.string().optional(),
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().default('auto'),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET_PUBLIC: z.string().default('opflow-photos'),
    R2_BUCKET_PRIVATE: z.string().default('opflow-documents'),
    CDN_PUBLIC_BASE_URL: z.string().optional(),
    UPLOAD_MAX_BYTES: z.coerce.number().int().min(100_000).max(20_000_000).default(5_242_880),

    // Email (Resend). Without it, emails are written to the log (local only).
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().default('OPflow <no-reply@opflow.in>'),
    EMAIL_REPLY_TO: z.string().optional(),
    ADMIN_ALERT_EMAIL: z.string().optional(),

    // Admin site
    ADMIN_PUBLIC_URL: z.string().default('http://localhost:3002'),
    ADMIN_ALLOWED_IPS: z
      .string()
      .default('')
      .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),
    ADMIN_TOTP_ISSUER: z.string().default('OPflow Admin'),
    GOOGLE_MAPS_API_KEY: z.string().optional(),

    // Error reports (Sentry). Empty = off. Read at start-up by common/sentry.ts.
    SENTRY_DSN: z.string().optional(),

    // A test server before the real accounts exist (APP_ENV=staging only; refused in production):
    // payments, messages and file storage use the stand-ins, and patient login uses DEMO_OTP_CODE instead of
    // Firebase. Token keys, pepper, data key and the database certificate are still required.
    DEMO_MODE: bool.default(false),
    DEMO_OTP_CODE: z.string().regex(/^\d{6}$/, 'must be 6 digits').optional(),
  })
  .superRefine((env, ctx) => {
    // On Render, APP_ENV must be set: a server silently running in laptop mode would use test stand-ins.
    if (env.APP_ENV === 'local' && process.env.RENDER === 'true') {
      ctx.addIssue({
        code: 'custom',
        path: ['APP_ENV'],
        message: 'is not set on this Render server. Paste every setting from backend/.env.render.full (Environment → Add from .env)',
      });
    }
    if (env.APP_ENV !== 'local' && !env.DB_SSL_CA_B64) {
      ctx.addIssue({
        code: 'custom',
        path: ['DB_SSL_CA_B64'],
        message: 'is required on staging/production so the database certificate is verified',
      });
    }
    // Secrets and real providers are required outside local development. Locally, safe stand-ins are used.
    if (env.DEMO_MODE && env.APP_ENV === 'production') {
      ctx.addIssue({ code: 'custom', path: ['DEMO_MODE'], message: 'is not allowed in production' });
    }
    if (env.DEMO_MODE && env.APP_ENV === 'staging' && !env.DEMO_OTP_CODE) {
      ctx.addIssue({ code: 'custom', path: ['DEMO_OTP_CODE'], message: 'is required in demo mode (the 6-digit code testers type)' });
    }
    if (env.PHONE_LOGIN === 'demo' && !allowsStandIns(env)) {
      ctx.addIssue({ code: 'custom', path: ['PHONE_LOGIN'], message: '"demo" is only for local development or a staging demo' });
    }
    if (!allowsStandIns(env)) {
      const mode = phoneLogin(env);
      if (mode === 'sms') {
        for (const key of ['MSG91_AUTH_KEY', 'MSG91_OTP_TEMPLATE_ID'] as const) {
          if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'is required for SMS login codes' });
        }
      }
    }
    if (env.APP_ENV !== 'local') {
      const required: (keyof typeof env)[] = ['JWT_ACCESS_PRIVATE_KEY_B64', 'JWT_ACCESS_PUBLIC_KEY_B64', 'PASSWORD_PEPPER', 'DATA_ENCRYPTION_KEY'];
      if (!env.DEMO_MODE) {
        required.push(
          'FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY_B64', // push (and Firebase login)
          'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET',
          'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'CDN_PUBLIC_BASE_URL', 'RESEND_API_KEY',
        );
      }
      for (const key of required) {
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'is required on staging/production' });
      }
      if (env.STORAGE_PROVIDER === 'local' && !env.DEMO_MODE) {
        ctx.addIssue({ code: 'custom', path: ['STORAGE_PROVIDER'], message: '"local" is for development only' });
      }
    }
    if (env.PASSWORD_PEPPER && Buffer.from(env.PASSWORD_PEPPER, 'base64').length < 32) {
      ctx.addIssue({ code: 'custom', path: ['PASSWORD_PEPPER'], message: 'must be at least 32 random bytes, base64' });
    }
    if (env.DATA_ENCRYPTION_KEY && Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64').length < 32) {
      ctx.addIssue({ code: 'custom', path: ['DATA_ENCRYPTION_KEY'], message: 'must be at least 32 random bytes, base64' });
    }
    // The running API must log in as opflow_api (bound by row-level security), never as postgres,
    // which can bypass it. Checked in every environment.
    let user = '';
    try {
      user = decodeURIComponent(new URL(env.DATABASE_URL).username);
    } catch {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'is not a valid URL' });
    }
    if (user === 'postgres' || user.startsWith('postgres.')) {
      ctx.addIssue({ code: 'custom', path: ['DATABASE_URL'], message: 'must log in as opflow_api, not postgres' });
    }
  });

export type Env = z.infer<typeof envSchema>;

export type PhoneLogin = 'sms' | 'firebase' | 'demo';

/**
 * How patients prove their phone number. PHONE_LOGIN chooses; otherwise SMS codes (MSG91), except where stand-ins
 * are allowed: a demo server uses the demo code, and a laptop uses SMS only once the MSG91 OTP template is set.
 * Firebase phone login is used only when chosen explicitly (its keys are also used for push).
 */
export function phoneLogin(env: Pick<Env, 'APP_ENV' | 'DEMO_MODE' | 'PHONE_LOGIN' | 'MSG91_AUTH_KEY' | 'MSG91_OTP_TEMPLATE_ID'>): PhoneLogin {
  if (env.PHONE_LOGIN) return env.PHONE_LOGIN;
  if (!allowsStandIns(env)) return 'sms';
  if (env.DEMO_MODE) return 'demo';
  return env.MSG91_AUTH_KEY && env.MSG91_OTP_TEMPLATE_ID ? 'sms' : 'demo';
}

/** True when we may use development stand-ins (fake payments, log-only messages, dev login tokens). */
export const isLocal = (env: Pick<Env, 'APP_ENV'>): boolean => env.APP_ENV === 'local';

/** Stand-ins (fake payments, log-only messages, local files, demo login) are allowed: local, or a staging demo. */
export const allowsStandIns = (env: Pick<Env, 'APP_ENV' | 'DEMO_MODE'>): boolean =>
  env.APP_ENV === 'local' || (env.APP_ENV === 'staging' && env.DEMO_MODE);

/**
 * In local development, reads backend/.env (Node's built-in loader; real environment variables win).
 * On servers the host's secrets are the only source.
 */
export function loadDotEnvForLocal(path = '.env'): void {
  if (process.env.NODE_ENV === 'production' || !existsSync(path)) return;
  const values = parseEnv(readFileSync(path, 'utf8'));
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Parses process.env. Throws one readable error listing every problem. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Lines left blank for later milestones (e.g. `DB_SSL_CA_B64=`) count as "not set".
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const result = envSchema.safeParse(cleaned);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || 'env'}: ${i.message}`);
    throw new Error(`Environment is not valid:\n${lines.join('\n')}\nSee backend/.env.example.`);
  }
  return result.data;
}

export const ENV = Symbol('ENV');
