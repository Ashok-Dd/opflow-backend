import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'kysely';
import request from 'supertest';

import { AppModule } from './app.module';
import { loadDotEnvForLocal } from './config/env';
import { DbService } from './infra/db/db.service';

/**
 * Runs against the real database in backend/.env (Supabase). Read-only, except one insert that must be
 * REFUSED and is rolled back. Run with: npm run test:db
 */
const run = process.env.RUN_DB_TESTS === '1' || process.env.npm_lifecycle_event === 'test:db' ? describe : describe.skip;

run('API against the real database', () => {
  let app: INestApplication;
  let dbs: DbService;

  beforeAll(async () => {
    loadDotEnvForLocal();
    process.env.LOG_LEVEL = 'error';
    process.env.JOBS_IN_API = 'false'; // never run background jobs against the shared database from a test
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true, logger: ['error'] });
    await app.init();
    dbs = app.get(DbService);
  }, 30_000);

  afterAll(async () => app?.close());

  it('/ready reaches the database', async () => {
    const res = await request(app.getHttpServer()).get('/ready').expect(200);
    expect(res.body.checks.database.ok).toBe(true);
  });

  it('/v1/catalog returns the app catalog, and a repeat with its ETag costs a 304', async () => {
    const res = await request(app.getHttpServer()).get('/v1/catalog').expect(200);
    expect(res.body.doctorTypes).toHaveLength(15);
    expect(res.body.emergencyKinds).toHaveLength(14);
    expect(res.body.rules.platformFeePercent).toBe(10);
    expect(res.body.rules.emergencyChargePercent).toBe(20);
    expect(res.headers['x-request-id']).toMatch(/^req_/);
    await request(app.getHttpServer()).get('/v1/catalog').set('If-None-Match', res.headers.etag!).expect(304);
  });

  it('runs as the app login (opflow_api), never as postgres', async () => {
    const { rows } = await sql<{ u: string; bypass: boolean }>`
      select current_user as u, (select rolbypassrls from pg_roles where rolname = current_user) as bypass`.execute(dbs.db);
    expect(rows[0]).toEqual({ u: 'opflow_api', bypass: false });
  });

  it('row-level security applies through DbService.as(): a patient sees only their own bookings', async () => {
    const someoneElse = '00000000-0000-7000-8000-00000000dead';
    const n = await dbs.as({ role: 'patient', userId: someoneElse }, (tx) =>
      tx.selectFrom('bookings').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirstOrThrow(),
    );
    expect(Number(n.n)).toBe(0);
  });

  it('the app login can use pgcrypto (admin authenticator secrets) and earthdistance (near me)', async () => {
    const schema = sql.raw(await dbs.cryptoSchema());
    const r = await dbs.sys(sql<{ ok: string; km: number }>`
      select ${schema}.pgp_sym_decrypt(${schema}.pgp_sym_encrypt('secret', 'k'), 'k') as ok,
             round(earth_distance(ll_to_earth(16.30, 80.44), ll_to_earth(16.31, 80.45)) / 1000) as km`);
    expect(r.rows[0]!.ok).toBe('secret');
  });

  it('new API: public doctor search, private routes need a login, admin routes need an admin', async () => {
    await request(app.getHttpServer()).get('/v1/doctors').expect(200);
    const hosp = await request(app.getHttpServer()).get('/v1/hospitals').expect(200);
    expect(Array.isArray(hosp.body.items)).toBe(true);
    await request(app.getHttpServer()).get('/v1/bookings').expect(401);
    await request(app.getHttpServer()).get('/v1/admin/dashboard/today').expect(401);
    const bad = await request(app.getHttpServer()).post('/v1/auth/doctor/login').send({ loginId: 'OPD-99999', password: 'x' });
    expect(bad.body.error.code).toBe('LOGIN_FAILED');
  });

  it('only admins can add a doctor, even through the app login', async () => {
    const attempt = dbs.as({ role: 'doctor', userId: '00000000-0000-7000-8000-000000000001', doctorId: '00000000-0000-7000-8000-000000000002' }, (tx) =>
      tx
        .insertInto('doctors')
        .values({
          userId: '00000000-0000-7000-8000-000000000001',
          name: 'Dr. Self Signup',
          typeId: 'general',
          degrees: 'MBBS',
          regCouncil: 'APMC',
          regNo: 'x',
          gender: 'male',
          feePaise: 30000,
        })
        .execute(),
    );
    await expect(attempt).rejects.toThrow(/Only OPflow admins can add doctors/);
  });
});
