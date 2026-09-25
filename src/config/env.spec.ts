import { loadEnv, phoneLogin } from './env';

const ok = {
  DATABASE_URL: 'postgresql://opflow_api.abc:secret@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true',
};

describe('loadEnv', () => {
  it('accepts a minimal local environment and fills defaults', () => {
    const env = loadEnv(ok);
    expect(env.APP_ENV).toBe('local');
    expect(env.PORT).toBe(3000);
    expect(env.DB_POOL_MAX).toBe(10);
    expect(env.CORS_ORIGINS).toEqual([]);
  });

  it('treats blank lines as not set', () => {
    const env = loadEnv({ ...ok, DB_SSL_CA_B64: '   ', REDIS_URL: '' });
    expect(env.DB_SSL_CA_B64).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
  });

  it('refuses the postgres login (it can bypass row-level security)', () => {
    expect(() =>
      loadEnv({ DATABASE_URL: 'postgresql://postgres.abc:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres' }),
    ).toThrow(/must log in as opflow_api/);
  });

  const secret = Buffer.alloc(32, 7).toString('base64');
  const production = {
    ...ok,
    APP_ENV: 'production',
    DB_SSL_CA_B64: 'Y2VydA==',
    JWT_ACCESS_PRIVATE_KEY_B64: 'x',
    JWT_ACCESS_PUBLIC_KEY_B64: 'x',
    PASSWORD_PEPPER: secret,
    DATA_ENCRYPTION_KEY: secret,
    FIREBASE_PROJECT_ID: 'opflow-prod',
    FIREBASE_CLIENT_EMAIL: 'a@b.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY_B64: 'x',
    RAZORPAY_KEY_ID: 'rzp_live_x',
    RAZORPAY_KEY_SECRET: 'x',
    RAZORPAY_WEBHOOK_SECRET: 'x',
    R2_ACCESS_KEY_ID: 'x',
    R2_SECRET_ACCESS_KEY: 'x',
    CDN_PUBLIC_BASE_URL: 'https://photos.opflow.in',
    RESEND_API_KEY: 're_x',
    MSG91_AUTH_KEY: 'x',
    MSG91_OTP_TEMPLATE_ID: 't',
  };

  it('requires the database certificate outside local development', () => {
    const { DB_SSL_CA_B64: _ca, ...noCa } = production;
    expect(() => loadEnv(noCa)).toThrow(/DB_SSL_CA_B64/);
    expect(() => loadEnv(production)).not.toThrow();
  });

  it('refuses local stand-ins (fake payments, dev login) outside local development', () => {
    const { RAZORPAY_KEY_SECRET: _k, FIREBASE_PROJECT_ID: _f, ...missing } = production;
    expect(() => loadEnv(missing)).toThrow(/RAZORPAY_KEY_SECRET[\s\S]*FIREBASE_PROJECT_ID|FIREBASE_PROJECT_ID[\s\S]*RAZORPAY_KEY_SECRET/);
    expect(() => loadEnv({ ...production, STORAGE_PROVIDER: 'local' })).toThrow(/development only/);
    expect(() => loadEnv({ ...production, PASSWORD_PEPPER: 'c2hvcnQ=' })).toThrow(/32 random bytes/);
  });

  it('demo mode: a staging test server without the real accounts, never production', () => {
    const demo = { ...ok, APP_ENV: 'staging', DB_SSL_CA_B64: 'Y2VydA==', DEMO_MODE: 'true', DEMO_OTP_CODE: '482913', JWT_ACCESS_PRIVATE_KEY_B64: 'x', JWT_ACCESS_PUBLIC_KEY_B64: 'x', PASSWORD_PEPPER: secret, DATA_ENCRYPTION_KEY: secret };
    expect(() => loadEnv(demo)).not.toThrow();
    const { DEMO_OTP_CODE: _c, ...noCode } = demo;
    expect(() => loadEnv(noCode)).toThrow(/DEMO_OTP_CODE/);
    const { PASSWORD_PEPPER: _p, ...noPepper } = demo;
    expect(() => loadEnv(noPepper)).toThrow(/PASSWORD_PEPPER/); // secrets are still required
    expect(() => loadEnv({ ...production, DEMO_MODE: 'true', DEMO_OTP_CODE: '482913' })).toThrow(/not allowed in production/);
  });

  it('patient login: SMS codes on servers, the demo code on a laptop until the MSG91 OTP template is set', () => {
    expect(phoneLogin(loadEnv(ok))).toBe('demo');
    expect(phoneLogin(loadEnv({ ...ok, FIREBASE_PROJECT_ID: 'p' }))).toBe('demo'); // Firebase alone = push only
    expect(phoneLogin(loadEnv({ ...ok, MSG91_AUTH_KEY: 'k', MSG91_OTP_TEMPLATE_ID: 't' }))).toBe('sms');
    expect(phoneLogin(loadEnv({ ...ok, PHONE_LOGIN: 'sms' }))).toBe('sms'); // codes appear in the server log
    expect(phoneLogin(loadEnv(production))).toBe('sms');
    const { MSG91_OTP_TEMPLATE_ID: _t, ...noTemplate } = production;
    expect(() => loadEnv(noTemplate)).toThrow(/MSG91_OTP_TEMPLATE_ID/);
    expect(() => loadEnv({ ...production, PHONE_LOGIN: 'demo' })).toThrow(/PHONE_LOGIN/);
  });

  it('lists every problem at once', () => {
    expect(() => loadEnv({ PORT: 'abc' })).toThrow(/DATABASE_URL[\s\S]*PORT|PORT[\s\S]*DATABASE_URL/);
  });

  it('parses CORS origins', () => {
    expect(loadEnv({ ...ok, CORS_ORIGINS: 'https://admin.opflow.in, http://localhost:3002' }).CORS_ORIGINS).toEqual([
      'https://admin.opflow.in',
      'http://localhost:3002',
    ]);
  });
});
