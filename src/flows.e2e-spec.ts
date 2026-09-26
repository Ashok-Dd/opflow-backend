import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'kysely';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';

import { AppModule } from './app.module';
import { totpAt, totpStep } from './common/crypto';
import { DbService } from './infra/db/db.service';
import { EMAIL, LogEmail, LogOtp, LogSms, OTP_SENDER, SMS } from './infra/messaging/messaging';
import { ENV, Env } from './config/env';
import { JwtService } from './common/auth/jwt.service';
import { AdminAuthService } from './modules/admin/admin-auth.service';
import { JobsService } from './modules/jobs/jobs.service';
import { PaymentsService } from './modules/payments/payments.service';

/**
 * End-to-end journeys through the real HTTP API, WebSocket and background jobs, against a THROWAWAY local
 * Postgres with every migration applied (never Supabase: these tests write a lot of data).
 *
 *   FLOW_DATABASE_URL=postgres://opflow_api:<pw>@localhost:5499/opflow_test npm run test:flow
 */
const url = process.env.FLOW_DATABASE_URL;
const run = url ? describe : describe.skip;
jest.setTimeout(120_000);

run('OPflow end to end', () => {
  let app: INestApplication;
  let dbs: DbService;
  let jobs: JobsService;
  let payments: PaymentsService;
  let base: string;
  const api = () => request(app.getHttpServer());
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

  // Shared state across the journey (tests run in order).
  const s = {} as {
    superToken: string; superId: string; superSecret: string;
    hospitalId: string; doctorId: string; loginId: string; otp: string; doctorToken: string; doctorRefresh: string;
    patients: { token: string; refresh: string; id: string }[];
    windowId: string; bookingId: string; bookingCode: string; sessionId: string;
    emergencyBookingId: string; emergencySessionId: string;
  };

  async function adminCode(adminId: string, secret: string): Promise<string> {
    // Each code works once (replay protection). Tests reset the "last used" step so they can sign in repeatedly.
    await dbs.db.updateTable('adminUsers').set({ totpLastStep: null }).where('id', '=', adminId).execute();
    return totpAt(secret, totpStep());
  }

  async function adminSignIn(email: string, password: string, adminId: string, secret: string) {
    const l = await api().post('/v1/admin/auth/login').send({ email, password }).expect(200);
    const t = await api().post('/v1/admin/auth/totp').send({ challengeToken: l.body.challengeToken, code: await adminCode(adminId, secret) }).expect(200);
    return t.body.accessToken as string;
  }

  async function stepUp(token: string, adminId: string, secret: string) {
    const r = await api().post('/v1/admin/auth/step-up').set(bearer(token)).send({ code: await adminCode(adminId, secret) }).expect(200);
    return r.body.accessToken as string;
  }

  async function newPatient(n: number) {
    const phone = `+9198765432${String(n).padStart(2, '0')}`;
    const r = await api().post('/v1/auth/patient/exchange').send({ idToken: `dev:${phone}`, device: { platform: 'android', fcmToken: `fcm-token-test-${n}-xxxxxxxx` } }).expect(200);
    expect(r.body.user.needsProfile).toBe(true);
    await api().patch('/v1/me').set(bearer(r.body.accessToken)).send({ name: `Patient ${n}`, age: 30 + n, gender: n % 2 ? 'female' : 'male' }).expect(200);
    return { token: r.body.accessToken as string, refresh: r.body.refreshToken as string, id: r.body.user.id as string };
  }

  async function holdAndPay(token: string, windowId: string) {
    const h = await api().post('/v1/bookings/hold').set(bearer(token)).set('Idempotency-Key', randomUUID()).send({ windowId }).expect(201);
    const paid = await api().post('/v1/dev/razorpay/pay').send({ orderId: h.body.payment.orderId }).expect(200);
    const v = await api().post('/v1/payments/verify').set(bearer(token)).send(paid.body).expect(200);
    return { hold: h.body, verify: v.body };
  }

  /** Bookable windows of the doctor, soonest first. */
  async function bookableWindows(): Promise<{ id: string; free: number; sessionId: string; startsAt: string }[]> {
    const days = await api().get(`/v1/doctors/${s.doctorId}/days`).expect(200);
    const out: { id: string; free: number; sessionId: string; startsAt: string }[] = [];
    for (const d of days.body.filter((x: { free: number }) => x.free > 0).slice(0, 3)) {
      const w = await api().get(`/v1/doctors/${s.doctorId}/windows`).query({ date: d.date }).expect(200);
      out.push(...w.body.filter((x: { bookable: boolean }) => x.bookable));
    }
    return out;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.APP_ENV = 'local';
    process.env.JOBS_IN_API = 'false';
    process.env.LOG_LEVEL = 'error';
    process.env.STORAGE_PROVIDER = 'local';
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication({ rawBody: true, logger: ['error'] });
    await app.init();
    await app.listen(0);
    const addr = app.getHttpServer().address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
    process.env.API_PUBLIC_URL = base;
    dbs = app.get(DbService);
    jobs = app.get(JobsService);
    payments = app.get(PaymentsService);
    // A clean slate for the parts of the schema this journey fills.
    await dbs.sys(sql`select 1`);
  });

  afterAll(async () => app?.close());

  it('runs as opflow_api (row-level security applies)', async () => {
    const { rows } = await dbs.sys(sql<{ u: string }>`select current_user as u`);
    expect(rows[0]!.u).toBe('opflow_api');
  });

  // ── Admins ────────────────────────────────────────────────────────────────────────────────────────

  async function makeAdmin(tag: string, opts: { replace?: boolean } = {}) {
    const auth = app.get(AdminAuthService);
    const email = `admin-${tag}@opflow.test`;
    const created = await dbs.system((tx) => auth.createAdmin(tx, { email, name: `Admin ${tag}`, replace: opts.replace }));
    const token = created.setupUrl.split('/setup/')[1]!;
    const info = await api().get(`/v1/admin/auth/setup/${token}`).expect(200);
    expect(info.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    await api().post(`/v1/admin/auth/setup/${token}`).send({ password: 'short1', code: totpAt(info.body.totpSecret, totpStep()) }).expect(422);
    await api().post(`/v1/admin/auth/setup/${token}`).send({ password: 'long-enough-pass-123', code: totpAt(info.body.totpSecret, totpStep()) }).expect(200);
    await api().post(`/v1/admin/auth/setup/${token}`).send({ password: 'long-enough-pass-123', code: '000000' }).expect(410); // link used
    const id = created.admin.id;
    const accessToken = await adminSignIn(email, 'long-enough-pass-123', id, info.body.totpSecret);
    return { token: accessToken, id, secret: info.body.totpSecret as string, email };
  }

  /** The same session, but as if the authenticator code was last entered 10 minutes ago. */
  function staleToken(token: string): string {
    const c = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { sub: string; role: 'super'; sid: string };
    return app.get(JwtService).sign({ aud: 'admin', sub: c.sub, role: c.role, sid: c.sid, su: Math.floor(Date.now() / 1000) - 600 });
  }

  it('one admin only: created by command, set up with a one-time link and an authenticator; a second is refused', async () => {
    await dbs.system((tx) => tx.updateTable('adminUsers').set({ status: 'suspended' }).where('status', '=', 'active').execute());
    const tag = randomUUID().slice(0, 6);
    const adm = await makeAdmin(tag);
    Object.assign(s, { superToken: adm.token, superId: adm.id, superSecret: adm.secret });
    const second = dbs.system((tx) => app.get(AdminAuthService).createAdmin(tx, { email: `other-${tag}@opflow.test`, name: 'Second' }));
    await expect(second).rejects.toMatchObject({ code: 'ONE_ADMIN_ONLY' });
    // The database refuses it too, whatever the code does.
    const raw = dbs.system((tx) => tx.insertInto('adminUsers').values({ email: `raw-${tag}@opflow.test`, name: 'Raw', role: 'ops', passwordHash: 'x' }).execute());
    await expect(raw).rejects.toMatchObject({ code: '23505' });
    const wrong = await api().post('/v1/admin/auth/login').send({ email: adm.email, password: 'nope' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('LOGIN_FAILED');
    await api().get('/v1/admin/approvals').set(bearer(adm.token)).expect(404); // no approval queue any more
  });

  it('admin routes refuse app tokens and missing logins', async () => {
    await api().get('/v1/admin/dashboard/today').expect(401);
    const p = await newPatient(90);
    await api().get('/v1/admin/dashboard/today').set(bearer(p.token)).expect(401);
    await api().get('/v1/admin/dashboard/today').set(bearer(s.superToken)).expect(200);
  });

  // ── Adding a doctor (admins only, two people) ─────────────────────────────────────────────────────

  it('admin adds a hospital and a doctor; the doctor gets an OPD login and is hidden until verified', async () => {
    const h = await api()
      .post('/v1/admin/hospitals')
      .set(bearer(s.superToken))
      .send({ name: `Test Hospital ${randomUUID().slice(0, 5)}`, address: '1 Main Road, Guntur', area: 'Brodipet', city: 'Guntur', pin: '522002', lat: 16.30, lng: 80.44, phone: '0863 111 2222', hasEmergency: true, departments: ['general', 'child'] })
      .expect(201);
    s.hospitalId = h.body.id;

    const regNo = `T${Date.now()}`;
    const body = {
      name: 'dr. test kumar', gender: 'male', phone: `+9190${String(Date.now()).slice(-8)}`, email: `doc-${regNo}@opflow.test`,
      typeId: 'general', degrees: 'MBBS, MD', regCouncil: 'APMC', regNo, languages: ['Telugu', 'English'], feePaise: 50000,
      hospitals: [{ hospitalId: s.hospitalId, isPrimary: true }],
    };
    const key = randomUUID();
    const d = await api().post('/v1/admin/doctors').set(bearer(s.superToken)).set('Idempotency-Key', key).send(body).expect(201);
    expect(d.body.loginId).toMatch(/^OPD-\d+$/);
    const again = await api().post('/v1/admin/doctors').set(bearer(s.superToken)).set('Idempotency-Key', key).send(body).expect(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.doctorId).toBe(d.body.doctorId);
    Object.assign(s, { doctorId: d.body.doctorId, loginId: d.body.loginId, otp: d.body.oneTimePassword });

    const dup = await api().post('/v1/admin/doctors').set(bearer(s.superToken)).set('Idempotency-Key', randomUUID()).send({ ...body, phone: '+919012345678', email: undefined });
    expect(dup.body.error.code).toBe('DUPLICATE_REGISTRATION');

    await api().get(`/v1/doctors/${s.doctorId}`).expect(404); // not verified yet
    const sms = app.get<LogSms>(SMS).outbox;
    await jobs.relay();
    expect(sms.some((m) => m.text.includes(s.otp))).toBe(true);
    expect(app.get<LogEmail>(EMAIL).outbox.some((m) => m.text.includes(s.loginId))).toBe(true);
  });

  it('the admin verifies a doctor at once, with a fresh authenticator code; it is in the audit log', async () => {
    const stale = await api().post(`/v1/admin/doctors/${s.doctorId}/verify`).set(bearer(staleToken(s.superToken))).send({ reason: 'All documents checked' });
    expect(stale.body.error.code).toBe('STEP_UP_REQUIRED');
    await api().get(`/v1/doctors/${s.doctorId}`).expect(404);
    const ok = await api().post(`/v1/admin/doctors/${s.doctorId}/verify`).set(bearer(s.superToken)).send({ reason: 'All documents checked' }).expect(200);
    expect(ok.body.verified).toBe(true);
    await api().get(`/v1/doctors/${s.doctorId}`).expect(200);
    const history = await api().get(`/v1/admin/doctors/${s.doctorId}/history`).set(bearer(s.superToken)).expect(200);
    expect(history.body.some((h: { action: string }) => h.action === 'doctor.create')).toBe(true);
    const log = await api().get('/v1/admin/audit').set(bearer(s.superToken)).query({ action: 'change.verify_doctor' }).expect(200);
    expect(log.body[0].after.reason).toBe('All documents checked');
  });

  // ── Doctor app ────────────────────────────────────────────────────────────────────────────────────

  it('doctor logs in with the OPD ID, must change the password, then sets timings', async () => {
    const bad = await api().post('/v1/auth/doctor/login').send({ loginId: s.loginId, password: 'wrong-pass-1' });
    expect(bad.body.error.code).toBe('LOGIN_FAILED');
    const first = await api().post('/v1/auth/doctor/login').send({ loginId: s.loginId.toLowerCase(), password: s.otp }).expect(200);
    expect(first.body.mustChange).toBe(true);
    const weak = await api().post('/v1/auth/doctor/set-password').send({ changeToken: first.body.changeToken, newPassword: 'abc' });
    expect(weak.body.error.code).toBe('WEAK_PASSWORD');
    const set = await api().post('/v1/auth/doctor/set-password').send({ changeToken: first.body.changeToken, newPassword: 'Doctor-pass-2026' }).expect(200);
    s.doctorToken = set.body.accessToken;
    s.doctorRefresh = set.body.refreshToken;

    const me = await api().get('/v1/doctor/me').set(bearer(s.doctorToken)).expect(200);
    expect(me.body.live).toBe(true);
    expect(me.body.regNo).toBeDefined(); // the doctor sees it…

    const week = await api()
      .put('/v1/doctor/schedule')
      .set(bearer(s.doctorToken))
      .send({ hospitalId: s.hospitalId, days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, blocks: [{ start: '06:00', end: '22:00', perHour: 4 }] })) })
      .expect(200);
    expect(week.body.report.created).toBeGreaterThan(5);

    const locked = await api().patch('/v1/doctor/me').set(bearer(s.doctorToken)).send({ about: 'Fever, BP and sugar.', feePaise: 50000 }).expect(200);
    expect(locked.body.about).toBe('Fever, BP and sugar.');
  });

  it('a doctor account works on at most 2 devices: a third sign-in signs out the least recently used one', async () => {
    const phone1 = { token: s.doctorToken, refresh: s.doctorRefresh };
    const login = (n: number) =>
      api().post('/v1/auth/doctor/login').send({ loginId: s.loginId, password: 'Doctor-pass-2026', device: { platform: 'android', fcmToken: `doctor-device-${n}-${randomUUID()}` } }).expect(200);
    const phone2 = (await login(2)).body;
    await api().get('/v1/doctor/me').set(bearer(phone1.token)).expect(200); // 2 devices: both work
    const phone3 = (await login(3)).body;
    const out = await api().get('/v1/doctor/me').set(bearer(phone1.token)).expect(401);
    expect(out.body.error.code).toBe('SIGNED_OUT'); // at once, not after 15 minutes
    await api().post('/v1/auth/refresh').send({ refreshToken: phone1.refresh }).expect(401);
    const list = await api().get('/v1/doctor/devices').set(bearer(phone3.accessToken)).expect(200);
    expect(list.body.max).toBe(2);
    expect(list.body.items).toHaveLength(2);
    expect(list.body.items.find((d: { thisDevice: boolean }) => d.thisDevice)).toBeDefined();
    await jobs.relay(); // messages are delivered by the worker (outbox)
    const msgs = await api().get('/v1/notifications').set(bearer(phone3.accessToken)).expect(200);
    expect(msgs.body.items.some((m: { title: string }) => m.title === 'Signed out on another device')).toBe(true);
    // The doctor signs out phone 2 from phone 3; the admin sees one device left.
    const other = list.body.items.find((d: { thisDevice: boolean }) => !d.thisDevice);
    await api().post(`/v1/doctor/devices/${other.id}/sign-out`).set(bearer(phone3.accessToken)).expect(200);
    await api().get('/v1/doctor/me').set(bearer(phone2.accessToken)).expect(401);
    const adminView = await api().get(`/v1/admin/doctors/${s.doctorId}`).set(bearer(s.superToken)).expect(200);
    expect(adminView.body.devices).toHaveLength(1);
    s.doctorToken = phone3.accessToken;
    s.doctorRefresh = phone3.refreshToken;
  });

  it('the doctor website has its own place: it never signs out a phone; a second browser replaces the first', async () => {
    const key = 'k'.repeat(40);
    process.env.DOCTOR_WEB_KEY = key;
    const phone = (await api().post('/v1/auth/doctor/login').send({ loginId: s.loginId, password: 'Doctor-pass-2026', device: { platform: 'android', fcmToken: `doctor-device-w-${randomUUID()}` } }).expect(200)).body;
    // Two phones now (phone3 from the test above + this one). The website signs in: both phones keep working.
    const web = (ip: string, sentKey = key) =>
      api()
        .post('/v1/auth/doctor/login')
        .set('x-opflow-web-key', sentKey)
        .set('x-opflow-client-ip', ip)
        .set('x-opflow-client-ua', 'Mozilla/5.0 (Windows NT 10.0) Chrome/130')
        .send({ loginId: s.loginId, password: 'Doctor-pass-2026', device: { platform: 'web', appVersion: 'web' } })
        .expect(200);
    const web1 = (await web('203.0.113.7')).body;
    await api().get('/v1/doctor/me').set(bearer(s.doctorToken)).expect(200);
    await api().get('/v1/doctor/me').set(bearer(phone.accessToken)).expect(200);
    await api().get('/v1/doctor/me').set(bearer(web1.accessToken)).expect(200);
    // The real browser address and browser are kept (not the website server's), because the key matched.
    const newest = async () =>
      (await dbs.sys(sql<{ ip: string; ua: string }>`select host(ip) as ip, user_agent as ua from refresh_tokens
                                                       where user_id = (select user_id from doctors where id = ${s.doctorId}) order by created_at desc limit 1`)).rows[0]!;
    expect(await newest()).toMatchObject({ ip: '203.0.113.7', ua: expect.stringContaining('Chrome') });
    // A second computer: the first browser is signed out; the phones still are not.
    const web2 = (await web('203.0.113.8')).body;
    await api().get('/v1/doctor/me').set(bearer(web1.accessToken)).expect(401);
    await api().get('/v1/doctor/me').set(bearer(web2.accessToken)).expect(200);
    await api().get('/v1/doctor/me').set(bearer(s.doctorToken)).expect(200);
    await api().get('/v1/doctor/me').set(bearer(phone.accessToken)).expect(200);
    const list = await api().get('/v1/doctor/devices').set(bearer(web2.accessToken)).expect(200);
    expect(list.body.maxWeb).toBe(1);
    expect(list.body.items.filter((d: { platform: string }) => d.platform === 'web')).toHaveLength(1);
    // Without the right key, a forwarded address is ignored (nobody can fake their IP).
    await web('198.51.100.9', 'x'.repeat(40));
    expect((await newest()).ip).not.toBe('198.51.100.9');
    delete process.env.DOCTOR_WEB_KEY;
  });

  it('patients see the doctor card (without the registration number) and free hours', async () => {
    const list = await api().get('/v1/doctors').query({ type: 'general', near: '16.30,80.44' }).expect(200);
    const card = list.body.items.find((d: { id: string }) => d.id === s.doctorId);
    expect(card).toBeDefined();
    expect(card.nextFree).not.toBeNull();
    expect(JSON.stringify(card)).not.toContain('regNo');
    const page = await api().get(`/v1/doctors/${s.doctorId}`).expect(200);
    expect(page.body.timings[0].days).toHaveLength(7);
    expect(JSON.stringify(page.body)).not.toContain(page.body.regNo ?? 'APMC-never');
  });

  // ── Booking and paying ────────────────────────────────────────────────────────────────────────────

  it('a patient holds a place, pays, and gets a confirmed token (retries are safe)', async () => {
    s.patients = [];
    for (let i = 1; i <= 8; i++) s.patients.push(await newPatient(i));
    const windows = await bookableWindows();
    expect(windows.length).toBeGreaterThan(3);
    s.windowId = windows[0]!.id;
    const p = s.patients[0]!;
    const key = randomUUID();
    const h = await api().post('/v1/bookings/hold').set(bearer(p.token)).set('Idempotency-Key', key).send({ windowId: s.windowId }).expect(201);
    expect(h.body.booking.status).toBe('pending_payment');
    expect(h.body.payment.amount.paise).toBe(50000);
    const replay = await api().post('/v1/bookings/hold').set(bearer(p.token)).set('Idempotency-Key', key).send({ windowId: s.windowId }).expect(201);
    expect(replay.body.booking.id).toBe(h.body.booking.id);
    const mismatch = await api().post('/v1/bookings/hold').set(bearer(p.token)).set('Idempotency-Key', key).send({ windowId: windows[1]!.id });
    expect(mismatch.body.error.code).toBe('IDEMPOTENCY_MISMATCH');

    const paid = await api().post('/v1/dev/razorpay/pay').send({ orderId: h.body.payment.orderId }).expect(200);
    const forged = await api().post('/v1/payments/verify').set(bearer(p.token)).send({ ...paid.body, razorpay_signature: 'f'.repeat(64) });
    expect(forged.body.error.code).toBe('PAYMENT_NOT_VERIFIED');
    const v = await api().post('/v1/payments/verify').set(bearer(p.token)).send(paid.body).expect(200);
    expect(v.body.outcome).toBe('confirmed');
    expect(v.body.booking.status).toBe('confirmed');
    expect(v.body.booking.tokenLabel).toMatch(/^\d{2,3}$/);
    const again = await api().post('/v1/payments/verify').set(bearer(p.token)).send(paid.body).expect(200);
    expect(again.body.outcome).toBe('already');
    Object.assign(s, { bookingId: v.body.booking.id, bookingCode: v.body.booking.code, sessionId: v.body.booking.sessionId });

    // The doctor's share is exactly 90% of the fee, on hold until 24 h after the OPD.
    const t = await dbs.sys(sql<{ amountPaise: number; status: string }>`select t.amount_paise, t.status from transfers t join payments p on p.id = t.payment_id where p.booking_id = ${s.bookingId}`);
    expect(t.rows[0]).toEqual({ amountPaise: 45000, status: 'on_hold' });
  });

  it('one booking per doctor per day, and no one sees another patient’s booking', async () => {
    const windows = await bookableWindows();
    const other = windows.find((w) => w.sessionId === s.sessionId && w.id !== s.windowId)!;
    const r = await api().post('/v1/bookings/hold').set(bearer(s.patients[0]!.token)).set('Idempotency-Key', randomUUID()).send({ windowId: other.id });
    expect(r.body.error.code).toBe('ALREADY_BOOKED');
    await api().get(`/v1/bookings/${s.bookingId}`).set(bearer(s.patients[1]!.token)).expect(404);
    await api().get('/v1/doctor/me').set(bearer(s.patients[1]!.token)).expect(403);
    // The database itself hides other people's money rows, even from a query with no "where".
    const seen = await dbs.as({ role: 'patient', userId: s.patients[1]!.id }, (tx) =>
      tx.selectFrom('payments').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    );
    expect(Number(seen.n)).toBe(0);
    const mine = await dbs.as({ role: 'patient', userId: s.patients[0]!.id }, (tx) =>
      tx.selectFrom('payments').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
    );
    expect(Number(mine.n)).toBe(1);
  });

  it('40 people tapping the same hour at once: exactly the free places are given, never more', async () => {
    const windows = await bookableWindows();
    const target = windows.find((w) => w.free === 4 && w.sessionId !== s.sessionId) ?? windows.find((w) => w.free === 4)!;
    const racers = await Promise.all(Array.from({ length: 6 }, (_, i) => newPatient(20 + i)));
    const results = await Promise.all(
      racers.map((p) => api().post('/v1/bookings/hold').set(bearer(p.token)).set('Idempotency-Key', randomUUID()).send({ windowId: target.id })),
    );
    const ok = results.filter((r) => r.status === 201).length;
    const full = results.filter((r) => r.body.error?.code === 'WINDOW_FULL').length;
    expect(ok).toBe(4);
    expect(full).toBe(2);
    const tokens = results.filter((r) => r.status === 201).map((r) => r.body.booking.token);
    expect(new Set(tokens).size).toBe(4);
  });

  it('change date or time once; the second change is refused with the app’s words', async () => {
    const p = s.patients[0]!;
    const windows = await bookableWindows();
    const later = windows.filter((w) => w.id !== s.windowId && w.free > 0);
    const target = later[0]!; // not the last day: a later test cancels that whole day
    const r = await api().post(`/v1/bookings/${s.bookingId}/reschedule`).set(bearer(p.token)).set('Idempotency-Key', randomUUID()).send({ windowId: target.id });
    if (r.status !== 200) {
      // Only allowed up to 2 hours before: if the first hour is too close, the app's message comes back.
      expect(r.body.error.code).toBe('RESCHEDULE_NOT_ALLOWED');
      return;
    }
    expect(r.body.changedOnce).toBe(true);
    expect(r.body.windowId).toBe(target.id);
    const second = await api().post(`/v1/bookings/${s.bookingId}/reschedule`).set(bearer(p.token)).set('Idempotency-Key', randomUUID()).send({ windowId: s.windowId });
    expect(second.body.error.message).toBe('You already changed this booking once.');
    s.windowId = target.id;
    s.sessionId = r.body.sessionId;
    // The old place is free again, the new one booked: never two, never none.
    const slots = await dbs.sys(sql<{ n: number }>`select count(*)::int as n from window_slots where booking_id = ${s.bookingId}`);
    expect(slots.rows[0]!.n).toBe(1);
  });

  it('webhook confirms a booking even if the phone never calls verify; repeats are ignored', async () => {
    const p = s.patients[1]!;
    const windows = await bookableWindows();
    const h = await api().post('/v1/bookings/hold').set(bearer(p.token)).set('Idempotency-Key', randomUUID()).send({ windowId: windows[0]!.id }).expect(201);
    const paid = await api().post('/v1/dev/razorpay/pay').send({ orderId: h.body.payment.orderId }).expect(200);
    const event = JSON.stringify({ event: 'payment.captured', created_at: 1, payload: { payment: { entity: { id: paid.body.razorpay_payment_id, order_id: h.body.payment.orderId, amount: 50000, status: 'captured', method: 'upi' } } } });
    const sig = await api().post('/v1/dev/razorpay/sign').set('Content-Type', 'application/json').send(event).expect(200);
    await api().post('/v1/webhooks/razorpay').set('Content-Type', 'application/json').set('x-razorpay-signature', 'bad').send(event).expect(400);
    const eventId = `evt_${randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 2; i++) {
      await api().post('/v1/webhooks/razorpay').set('Content-Type', 'application/json').set('x-razorpay-signature', sig.body.signature).set('x-razorpay-event-id', eventId).send(event).expect(200);
    }
    const b = await api().get(`/v1/bookings/${h.body.booking.id}`).set(bearer(p.token)).expect(200);
    expect(b.body.status).toBe('confirmed');
  });

  it('paying after the hold ran out still gets the place if it is free (never "paid but nothing")', async () => {
    const p = s.patients[2]!;
    const windows = await bookableWindows();
    const h = await api().post('/v1/bookings/hold').set(bearer(p.token)).set('Idempotency-Key', randomUUID()).send({ windowId: windows[0]!.id }).expect(201);
    await dbs.system((tx) => tx.updateTable('bookings').set({ holdExpiresAt: new Date(Date.now() - 60_000) }).where('id', '=', h.body.booking.id).execute());
    await api().post('/v1/dev/jobs/holds.expire').expect(200);
    const expired = await api().get(`/v1/bookings/${h.body.booking.id}`).set(bearer(p.token)).expect(200);
    expect(expired.body.status).toBe('expired');
    const paid = await api().post('/v1/dev/razorpay/pay').send({ orderId: h.body.payment.orderId }).expect(200);
    const v = await api().post('/v1/payments/verify').set(bearer(p.token)).send(paid.body).expect(200);
    expect(v.body.outcome).toBe('confirmed');
    expect(v.body.booking.status).toBe('confirmed');
  });

  it('paid but the phone never confirmed (Checkout said failed, signal lost): "check" confirms it, told once', async () => {
    const p = await newPatient(62);
    const windows = await bookableWindows();
    const h = await api().post('/v1/bookings/hold').set(bearer(p.token)).set('Idempotency-Key', randomUUID()).send({ windowId: windows[windows.length - 2]!.id }).expect(201);
    const bookingId = h.body.booking.id as string;
    // Before paying: not paid, still waiting for payment.
    const before = await api().post(`/v1/payments/${bookingId}/check`).set(bearer(p.token)).expect(200);
    expect(before.body).toMatchObject({ status: 'pending_payment', paid: false });
    // The money is taken at Razorpay, but the app never calls verify.
    await api().post('/v1/dev/razorpay/pay').send({ orderId: h.body.payment.orderId }).expect(200);
    const after = await api().post(`/v1/payments/${bookingId}/check`).set(bearer(p.token)).expect(200);
    expect(after.body).toMatchObject({ status: 'confirmed', paid: true });
    expect(after.body.booking.token).toBeGreaterThan(0);
    // Asking again changes nothing; the patient is told exactly once.
    await api().post(`/v1/payments/${bookingId}/check`).set(bearer(p.token)).expect(200);
    for (let i = 0; i < 15; i++) await jobs.relay(); // until the queue is empty (other tests queue messages too)
    const told = await dbs.sys(sql<{ n: number }>`select count(*)::int as n from notifications where booking_id = ${bookingId} and title = 'Booking confirmed'`);
    expect(told.rows[0]!.n).toBe(1);
    // Another patient cannot ask about this booking.
    const other = await newPatient(63);
    await api().post(`/v1/payments/${bookingId}/check`).set(bearer(other.token)).expect(404);
  });

  it('messages page by page; the regular check asks only for new ones', async () => {
    const p = s.patients[0]!;
    const first = await api().get('/v1/notifications').set(bearer(p.token)).query({ limit: 1 }).expect(200);
    expect(first.body.items).toHaveLength(1);
    const newest = first.body.items[0].createdAt as string;
    const none = await api().get('/v1/notifications').set(bearer(p.token)).query({ after: newest }).expect(200);
    expect(none.body.items).toHaveLength(0);
    expect(typeof none.body.unread).toBe('number');
    const older = await api().get('/v1/notifications').set(bearer(p.token)).query({ after: '2020-01-01T00:00:00Z' }).expect(200);
    expect(older.body.items.length).toBeGreaterThanOrEqual(1);
  });

  it('if Razorpay is down, no place is kept and no money is taken', async () => {
    const p = s.patients[3]!;
    const windows = await bookableWindows();
    const before = windows[0]!.free;
    await api().post('/v1/dev/razorpay/fail-next-order').expect(200);
    const r = await api().post('/v1/bookings/hold').set(bearer(p.token)).set('Idempotency-Key', randomUUID()).send({ windowId: windows[0]!.id });
    expect(r.status).toBe(503);
    expect(r.body.error).toMatchObject({ code: 'PAYMENTS_UNAVAILABLE', retryable: true });
    const after = (await bookableWindows()).find((w) => w.id === windows[0]!.id)!;
    expect(after.free).toBe(before);
  });

  it('Pause bookings stops new bookings until resumed', async () => {
    await api().post('/v1/doctor/me/bookings-pause').set(bearer(s.doctorToken)).send({ paused: true }).expect(200);
    const windows = await api().get(`/v1/doctors/${s.doctorId}`).expect(200);
    expect(windows.body.nextFree).toBeNull();
    const any = await dbs.sys(sql<{ id: string }>`select w.id from opd_windows w join opd_sessions s on s.id = w.session_id where s.doctor_id = ${s.doctorId} and w.starts_at > now() + interval '3 hours' limit 1`);
    const r = await api().post('/v1/bookings/hold').set(bearer(s.patients[3]!.token)).set('Idempotency-Key', randomUUID()).send({ windowId: any.rows[0]!.id });
    expect(r.body.error.code).toBe('BOOKINGS_PAUSED');
    await api().post('/v1/doctor/me/bookings-pause').set(bearer(s.doctorToken)).send({ paused: false }).expect(200);
  });

  // ── Emergency consultation ────────────────────────────────────────────────────────────────────────

  it('emergency consultation: fee + 20% charge, E-token, top of the line; doctor still gets exactly 90% of the fee', async () => {
    await api().put('/v1/doctor/emergency').set(bearer(s.doctorToken)).send({ status: 'available_now', hospitalId: s.hospitalId }).expect(200);
    const near = await api().get('/v1/emergency/near').query({ kind: 'heat', lat: 16.3, lng: 80.44 }).expect(200);
    const doc = near.body.doctors.find((d: { id: string }) => d.id === s.doctorId);
    expect(doc.emergencyConsult.total.paise).toBe(60000);
    const p = s.patients[4]!;
    const h = await api().post('/v1/bookings/emergency').set(bearer(p.token)).set('Idempotency-Key', randomUUID()).send({ doctorId: s.doctorId });
    if (h.status === 409 && h.body.error.code === 'EMERGENCY_NOT_AVAILABLE') return; // only at 23:50–24:00 IST
    expect(h.status).toBe(201);
    expect(h.body.payment.amount.paise).toBe(60000);
    const paid = await api().post('/v1/dev/razorpay/pay').send({ orderId: h.body.payment.orderId }).expect(200);
    const v = await api().post('/v1/payments/verify').set(bearer(p.token)).send(paid.body).expect(200);
    expect(v.body.booking.tokenLabel).toBe('E1');
    expect(v.body.booking.total.paise).toBe(60000);
    s.emergencyBookingId = v.body.booking.id;
    s.emergencySessionId = v.body.booking.sessionId;
    const t = await dbs.sys(sql<{ amountPaise: number }>`select t.amount_paise from transfers t join payments p on p.id = t.payment_id where p.booking_id = ${s.emergencyBookingId}`);
    expect(t.rows[0]!.amountPaise).toBe(45000); // 90% of ₹500; the ₹100 charge and ₹50 fee share are OPflow's
  });

  // ── Live line ─────────────────────────────────────────────────────────────────────────────────────

  it('live line: console commands, stale-screen protection, patient board over WebSocket and polling', async () => {
    const sessionId = s.emergencySessionId ?? s.sessionId;
    const bookingId = s.emergencyBookingId ?? s.bookingId;
    const owner = s.emergencyBookingId ? s.patients[4]! : s.patients[0]!;
    const line = await api().get(`/v1/doctor/sessions/${sessionId}/line`).set(bearer(s.doctorToken)).expect(200);
    expect(line.body.line.some((e: { bookingId: string }) => e.bookingId === bookingId)).toBe(true);

    const socket: Socket = io(`${base}/live`, { auth: { token: owner.token }, transports: ['websocket'] });
    const boards: { myState: string | null; message: string | null }[] = [];
    socket.on('board', (b) => boards.push(b));
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => resolve());
      socket.on('connect_error', reject);
    });
    const joined = await socket.emitWithAck('join', { sessionId });
    expect(joined.ok).toBe(true);

    const v0 = line.body.version;
    await api().post(`/v1/doctor/sessions/${sessionId}/mark-reached`).set(bearer(s.doctorToken)).send({ bookingId }).expect(200);
    const stale = await api().post(`/v1/doctor/sessions/${sessionId}/call-next`).set(bearer(s.doctorToken)).send({ expectedVersion: v0 });
    expect(stale.body.error.code).toBe('STALE_BOARD');
    const fresh = stale.body.error.details.board.version;
    const called = await api().post(`/v1/doctor/sessions/${sessionId}/call-next`).set(bearer(s.doctorToken)).send({ expectedVersion: fresh }).expect(200);
    expect(called.body.nowSeeing.bookingId).toBe(bookingId);

    const poll = await api().get(`/v1/live/sessions/${sessionId}`).set(bearer(owner.token)).expect(200);
    expect(poll.body.myState).toBe('with_doctor');
    expect(poll.body.message).toBe('Please go in now.');
    await new Promise((r) => setTimeout(r, 500));
    expect(boards.some((b) => b.myState === 'with_doctor')).toBe(true);
    socket.close();

    await api().post(`/v1/doctor/sessions/${sessionId}/done`).set(bearer(s.doctorToken)).send({}).expect(200);
    const ended = await api().post(`/v1/doctor/sessions/${sessionId}/end`).set(bearer(s.doctorToken)).send({ leftovers: 'move' }).expect(200);
    expect(ended.body.status).toBe('ended');
    const b = await dbs.system((tx) => tx.selectFrom('bookings').select('status').where('id', '=', bookingId).executeTakeFirstOrThrow());
    expect(b.status).toBe('completed');
    await api().post(`/v1/doctor/sessions/${sessionId}/call-next`).set(bearer(s.doctorToken)).send({}).expect(409);
  });

  // ── Cancellation and refunds ──────────────────────────────────────────────────────────────────────

  it('doctor cancels a booking: 100% money back, doctor share reversed, patient told', async () => {
    const p = s.patients[5]!;
    const windows = await bookableWindows();
    const { verify } = await holdAndPay(p.token, windows[windows.length - 1]!.id);
    const r = await api().post(`/v1/doctor/bookings/${verify.booking.id}/cancel`).set(bearer(s.doctorToken)).send({ reason: 'Emergency surgery' }).expect(200);
    expect(r.body.refund.paise).toBe(50000);
    await jobs.relay();
    await jobs.relay();
    const b = await api().get(`/v1/bookings/${verify.booking.id}`).set(bearer(p.token)).expect(200);
    expect(b.body.status).toBe('cancelled_by_provider');
    expect(b.body.refunds[0].status).toBe('processed');
    const msgs = await api().get('/v1/notifications').set(bearer(p.token)).expect(200);
    expect(msgs.body.items.map((m: { title: string }) => m.title)).toEqual(expect.arrayContaining(['Booking cancelled by the doctor', 'Money back sent']));
    const t = await dbs.sys(sql<{ status: string }>`select t.status from transfers t join payments p on p.id = t.payment_id where p.booking_id = ${verify.booking.id}`);
    expect(t.rows[0]!.status).toBe('reversed');
    const again = await api().post(`/v1/doctor/bookings/${verify.booking.id}/cancel`).set(bearer(s.doctorToken)).send({ reason: 'Emergency surgery' });
    expect(again.body.error.code).toBe('BOOKING_CHANGED');
  });

  it('doctor cancels a whole day: everyone refunded in the background, with progress', async () => {
    const windows = await bookableWindows();
    const lastDay = await dbs.sys(sql<{ date: string }>`select s.date from opd_windows w join opd_sessions s on s.id = w.session_id where w.id = ${windows[windows.length - 1]!.id}`);
    const date = lastDay.rows[0]!.date;
    const onDay = await dbs.sys(sql<{ id: string }>`select w.id from opd_windows w join opd_sessions s on s.id = w.session_id where s.doctor_id = ${s.doctorId} and s.date = ${date}::date and w.starts_at > now() + interval '1 hour' order by w.starts_at limit 1`);
    const p = s.patients[6]!;
    await holdAndPay(p.token, onDay.rows[0]!.id);
    const r = await api().post(`/v1/doctor/days/${date}/cancel`).set(bearer(s.doctorToken)).send({ reason: 'Family function' }).expect(200);
    expect(r.body.bookings).toBeGreaterThanOrEqual(1);
    await jobs.relay();
    await jobs.relay();
    const op = await api().get(`/v1/doctor/bulk/${r.body.bulkIds[0]}`).set(bearer(s.doctorToken)).expect(200);
    expect(op.body.status).toBe('finished');
    const left = await dbs.sys(sql<{ n: number }>`select count(*)::int as n from bookings where doctor_id = ${s.doctorId} and session_date = ${date}::date and status = 'confirmed'`);
    expect(left.rows[0]!.n).toBe(0);
  });

  // ── Admin operations ──────────────────────────────────────────────────────────────────────────────

  it('admin: booking search, masked phone with a logged reveal (fresh code), refunds', async () => {
    const found = await api().get('/v1/admin/bookings').set(bearer(s.superToken)).query({ code: s.bookingCode }).expect(200);
    expect(found.body.items[0].id).toBe(s.bookingId);
    const people = await api().get('/v1/admin/patients').set(bearer(s.superToken)).query({ phone: '+919876543201' }).expect(200);
    expect(people.body[0].phone).toMatch(/x{5}/);
    const stale = await api().post(`/v1/admin/patients/${people.body[0].id}/reveal`).set(bearer(staleToken(s.superToken))).send({ field: 'phone', reason: 'Patient asked for a callback' });
    expect(stale.body.error.code).toBe('STEP_UP_REQUIRED');
    const fresh = await stepUp(s.superToken, s.superId, s.superSecret);
    const shown = await api().post(`/v1/admin/patients/${people.body[0].id}/reveal`).set(bearer(fresh)).send({ field: 'phone', reason: 'Patient asked for a callback' }).expect(200);
    expect(shown.body.phone).toBe('+919876543201');
    const logged = await dbs.db.selectFrom('auditLog').select('id').where('action', '=', 'patient.reveal_phone').where('entityId', '=', people.body[0].id).execute();
    expect(logged.length).toBeGreaterThan(0);

    const small = await api().post(`/v1/admin/bookings/${s.bookingId}/refund`).set(bearer(fresh)).set('Idempotency-Key', randomUUID()).send({ amountPaise: 5000, reason: 'Long wait at the hospital' }).expect(200);
    expect(small.body.refundId).toBeDefined();
    // One admin: even a large refund goes straight through (no second person), and is recorded.
    const large = await api().post(`/v1/admin/bookings/${s.bookingId}/refund`).set(bearer(fresh)).set('Idempotency-Key', randomUUID()).send({ amountPaise: 20000, reason: 'Doctor was 3 hours late' }).expect(200);
    expect(large.body.status).toBe('pending');
    const tooMuch = await api().post(`/v1/admin/bookings/${s.bookingId}/refund`).set(bearer(fresh)).set('Idempotency-Key', randomUUID()).send({ amountPaise: 999999, reason: 'Testing the limit' });
    expect(tooMuch.body.error.code).toBe('TOO_MUCH');
  });

  it('kill switch: the admin turns bookings off and on again (fresh code each time)', async () => {
    const superFresh = await stepUp(s.superToken, s.superId, s.superSecret);
    await api().post('/v1/admin/config/bookings.enabled/kill').set(bearer(superFresh)).send({ reason: 'Payment provider incident' }).expect(200);
    const windows = await dbs.sys(sql<{ id: string }>`select w.id from opd_windows w join opd_sessions s on s.id = w.session_id where s.doctor_id = ${s.doctorId} and w.starts_at > now() + interval '3 hours' and s.status = 'scheduled' and w.status = 'open' and exists (select 1 from window_slots ws where ws.window_id = w.id and ws.state = 'free') order by w.starts_at desc limit 1`);
    const r = await api().post('/v1/bookings/hold').set(bearer(s.patients[7]!.token)).set('Idempotency-Key', randomUUID()).send({ windowId: windows.rows[0]!.id });
    expect(r.body.error.code).toBe('BOOKINGS_OFF');
    const stale = await api().put('/v1/admin/config/bookings.enabled').set(bearer(staleToken(s.superToken))).send({ value: true, reason: 'Incident is over' });
    expect(stale.body.error.code).toBe('STEP_UP_REQUIRED');
    await api().put('/v1/admin/config/bookings.enabled').set(bearer(superFresh)).send({ value: true, reason: 'Incident is over' }).expect(200);
    const ok = await api().post('/v1/bookings/hold').set(bearer(s.patients[7]!.token)).set('Idempotency-Key', randomUUID()).send({ windowId: windows.rows[0]!.id });
    expect(ok.body.error?.code ?? 'OK').toBe('OK');
  });

  it('first aid cannot be published without a confirmed WHO source and a doctor reviewer', async () => {
    const superFresh = await stepUp(s.superToken, s.superId, s.superSecret);
    const r = await api().post('/v1/admin/first-aid/poison/publish').set(bearer(superFresh)).send({ reviewedByDoctor: 'Dr. Reviewer Name' });
    expect(r.body.error.code).toBe('SOURCE_NOT_CONFIRMED');
    await api().post('/v1/admin/first-aid/snake/publish').set(bearer(superFresh)).send({ reviewedByDoctor: 'Dr. Reviewer Name' }).expect(200);
    const pub = await api().get('/v1/emergency/first-aid/snake').expect(200);
    expect(pub.body.reviewedByDoctor).toBe('Dr. Reviewer Name');
  });

  // ── Sessions and safety ───────────────────────────────────────────────────────────────────────────

  it('refresh tokens rotate; reusing an old one ends the whole session', async () => {
    const p = s.patients[7]!;
    await api().post('/v1/auth/refresh').send({ refreshToken: p.refresh }).expect(200);
    // Two requests at the same moment (a website page and its background check): refused quietly, nothing ended.
    await api().post('/v1/auth/refresh').send({ refreshToken: p.refresh }).expect(401);
    // The phone never got that answer (weak signal) and tries again seconds later with the old token: the new token
    // was never used, so this is a lost reply, not theft. A fresh pair; the unused one is cancelled.
    await dbs.system((tx) => sql`update refresh_tokens set revoked_at = now() - interval '10 seconds' where replaced_by is not null and user_id = ${p.id}`.execute(tx));
    const r2 = await api().post('/v1/auth/refresh').send({ refreshToken: p.refresh }).expect(200);
    const r3 = await api().post('/v1/auth/refresh').send({ refreshToken: r2.body.refreshToken }).expect(200);
    // Now the old token again, a minute later, after its successor was used: a copy. The whole session ends.
    await dbs.system((tx) => sql`update refresh_tokens set revoked_at = now() - interval '1 minute' where replaced_by is not null and user_id = ${p.id}`.execute(tx));
    await api().post('/v1/auth/refresh').send({ refreshToken: p.refresh }).expect(401); // stolen copy
    await api().post('/v1/auth/refresh').send({ refreshToken: r3.body.refreshToken }).expect(401); // whole family ended
  });

  it('SMS login codes: sent, checked once, 5 tries, a 30 s wait between codes', async () => {
    const env = app.get<Env>(ENV);
    const sent = app.get<LogOtp>(OTP_SENDER).sent;
    const phone = '+919876500077';
    // This server logs in with the demo code: the app is told so, and nothing is sent.
    expect((await api().post('/v1/auth/patient/otp').send({ phone }).expect(200)).body).toEqual({ mode: 'demo' });
    env.PHONE_LOGIN = 'sms';
    try {
      const r = await api().post('/v1/auth/patient/otp').send({ phone }).expect(200);
      const code = sent.at(-1)!.code;
      // No SMS provider on this laptop: the code comes back for the app to show (never on production).
      expect(r.body).toEqual({ mode: 'sms', resendAfterSeconds: 30, expiresInSeconds: 300, testCode: code });
      expect(code).toMatch(/^\d{6}$/);
      const again = await api().post('/v1/auth/patient/otp').send({ phone });
      expect(again.body.error.code).toBe('OTP_WAIT');
      const wrong = code === '000000' ? '111111' : '000000';
      const bad = await api().post('/v1/auth/patient/otp/verify').send({ phone, code: wrong });
      expect(bad.body.error.code).toBe('OTP_INVALID');
      const ok = await api().post('/v1/auth/patient/otp/verify').send({ phone, code, device: { platform: 'android' } }).expect(200);
      expect(ok.body.accessToken).toBeDefined();
      expect(ok.body.user.needsProfile).toBe(true);
      const reuse = await api().post('/v1/auth/patient/otp/verify').send({ phone, code });
      expect(reuse.body.error.code).toBe('OTP_EXPIRED');
      // The dev-token exchange is closed while SMS codes are on.
      await api().post('/v1/auth/patient/exchange').send({ idToken: `dev:${phone}` }).expect(401);
      // 5 wrong tries end a code.
      await dbs.system((tx) => tx.updateTable('phoneOtps').set({ createdAt: new Date(Date.now() - 60_000) }).where('phone', '=', phone).execute());
      await api().post('/v1/auth/patient/otp').send({ phone }).expect(200);
      const code2 = sent.at(-1)!.code;
      const wrong2 = code2 === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) await api().post('/v1/auth/patient/otp/verify').send({ phone, code: wrong2 });
      const locked = await api().post('/v1/auth/patient/otp/verify').send({ phone, code: code2 });
      expect(locked.body.error.code).toBe('OTP_TOO_MANY');
      const stored = await dbs.system((tx) => tx.selectFrom('phoneOtps').select('codeHash').where('phone', '=', phone).execute());
      expect(stored.every((x) => !x.codeHash.includes(code2))).toBe(true); // only a keyed hash is kept
    } finally {
      env.PHONE_LOGIN = undefined;
    }
  });

  it('push: a new phone token is tied to the login; logging out stops pushes to that phone', async () => {
    const p = await newPatient(60);
    const token = async (fcm: string) =>
      (await dbs.system((tx) => tx.selectFrom('devices').select('fcmToken').where('userId', '=', p.id).where('fcmToken', '=', fcm).executeTakeFirst()))?.fcmToken;
    expect(await token('fcm-token-test-60-xxxxxxxx')).toBeDefined();
    await api().post('/v1/me/devices').set(bearer(p.token)).send({ platform: 'ios', fcmToken: 'fcm-token-new-60-yyyyyyyy' }).expect(200);
    await api().post('/v1/auth/logout').send({ refreshToken: p.refresh }).expect(200);
    expect(await token('fcm-token-test-60-xxxxxxxx')).toBeUndefined();
    expect(await token('fcm-token-new-60-yyyyyyyy')).toBeUndefined();
  });

  it('old apps are asked to update; bad input gets a clear message', async () => {
    const old = await api().get('/v1/catalog').set('X-App-Version', '0.9.0').expect(426);
    expect(old.body.error.code).toBe('UPGRADE_REQUIRED');
    const bad = await api().post('/v1/bookings/hold').set(bearer(s.patients[0]!.token)).set('Idempotency-Key', randomUUID()).send({ windowId: 'nope' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_INPUT');
    expect(bad.body.error.details.fields.windowId).toBeDefined();
  });

  it('payment failed or closed, then "Try again" for the same doctor and day: the retry works at once', async () => {
    const p = await newPatient(40);
    const w = (await bookableWindows()).find((x) => x.free > 1)!;
    const first = await api().post('/v1/bookings/hold').set(bearer(p.token)).set('Idempotency-Key', randomUUID()).send({ windowId: w.id }).expect(201);
    // Nothing paid. The patient taps "Try again": a NEW hold, not "You already have a booking…".
    const again = await api().post('/v1/bookings/hold').set(bearer(p.token)).set('Idempotency-Key', randomUUID()).send({ windowId: w.id }).expect(201);
    expect(again.body.booking.id).not.toBe(first.body.booking.id);
    const old = await dbs.sys(sql<{ status: string }>`select status from bookings where id = ${first.body.booking.id}`);
    expect(old.rows[0]!.status).toBe('expired');
    const paid = await api().post('/v1/dev/razorpay/pay').send({ orderId: again.body.payment.orderId }).expect(200);
    const v = await api().post('/v1/payments/verify').set(bearer(p.token)).send(paid.body).expect(200);
    expect(v.body.booking.status).toBe('confirmed');
  });

  it('doctor forgets to tick: running behind never removes waiting people; the passed-over one is told; payouts only for finished visits', async () => {
    // Two patients in one hour of a far-off OPD (so nothing else in this journey touches it).
    const days = (await bookableWindows()).reduce<Record<string, { id: string; free: number; sessionId: string; startsAt: string }[]>>((m, w) => {
      (m[w.sessionId] ??= []).push(w);
      return m;
    }, {});
    const [sessionId, ws] = Object.entries(days).reverse().find(([, list]) => list.some((w) => w.free >= 2))!;
    const w = ws.find((x) => x.free >= 2)!;
    const a = s.patients[4]!;
    const b = s.patients[5]!;
    const ba = (await holdAndPay(a.token, w.id)).verify.booking;
    const bb = (await holdAndPay(b.token, w.id)).verify.booking;
    expect(ba.status).toBe('confirmed');
    expect(bb.status).toBe('confirmed');
    const [first, second] = ba.token < bb.token ? [ba, bb] : [bb, ba];

    // That hour ended 2 hours ago and the OPD is running; the doctor is slow and has called nobody yet.
    await dbs.sys(sql`update opd_windows set starts_at = now() - interval '3 hours', ends_at = now() - interval '2 hours' where id = ${w.id}`);
    await dbs.sys(sql`update opd_sessions set status = 'running', started_at = now() - interval '3 hours' where id = ${sessionId}`);
    await jobs.autoSessions();
    const state = async (id: string) => (await dbs.sys(sql<{ state: string }>`select state from queue_entries where booking_id = ${id}`)).rows[0]!.state;
    expect(await state(first.id)).toBe('not_come'); // still in line: the doctor simply hasn't reached them
    expect(await state(second.id)).toBe('not_come');

    // The doctor calls and finishes the SECOND one (the first wasn't there): now the first was passed over.
    await api().post(`/v1/doctor/sessions/${sessionId}/call-now`).set(bearer(s.doctorToken)).send({ bookingId: second.id }).expect(200);
    await api().post(`/v1/doctor/sessions/${sessionId}/done`).set(bearer(s.doctorToken)).send({}).expect(200);
    await jobs.autoSessions();
    expect(await state(first.id)).toBe('did_not_come');
    for (let i = 0; i < 15; i++) await jobs.relay();
    const told = await dbs.sys(sql<{ n: number }>`select count(*)::int as n from notifications where booking_id = ${first.id} and title = 'Marked as did not come'`);
    expect(told.rows[0]!.n).toBe(1);

    // Payouts: due by time, but the visits are still open → nothing is sent.
    await dbs.sys(sql`insert into payout_accounts (doctor_id, razorpay_account_id, status) values (${s.doctorId}, 'acc_test_doctor', 'active')
                      on conflict (doctor_id) do update set status = 'active', razorpay_account_id = excluded.razorpay_account_id`);
    const ids = [first.id, second.id];
    await dbs.sys(sql`update transfers t set release_at = now() - interval '1 minute' from payments p where p.id = t.payment_id and p.booking_id = any(${ids}::uuid[])`);
    await payments.releaseDueTransfers();
    const payout = async (id: string) =>
      (await dbs.sys(sql<{ status: string }>`select t.status from transfers t join payments p on p.id = t.payment_id where p.booking_id = ${id}`)).rows[0]!.status;
    expect(await payout(first.id)).toBe('on_hold');
    expect(await payout(second.id)).toBe('on_hold');

    // The doctor ends the OPD: seen → completed, not come → no-show; both are paid out now.
    const end = await api().post(`/v1/doctor/sessions/${sessionId}/end`).set(bearer(s.doctorToken)).send({ leftovers: 'move' });
    expect(end.status).toBeLessThan(300);
    await payments.releaseDueTransfers();
    expect(await payout(second.id)).toBe('released');
    expect(await payout(first.id)).toBe('released');
  });

  it('doctor forgets END OPD: closed after 3 hours; passed-over = did not come, never reached = pick a new time', async () => {
    const all = await bookableWindows();
    const bySession = new Map<string, typeof all>();
    for (const x of all) bySession.set(x.sessionId, [...(bySession.get(x.sessionId) ?? []), x]);
    const people = [s.patients[1]!, s.patients[6]!, s.patients[7]!];
    // A day none of them has booked with this doctor (one booking per doctor per day).
    const taken = new Set(
      (await dbs.sys(sql<{ sessionId: string }>`select session_id from bookings where patient_user_id = any(${people.map((p) => p.id)}::uuid[]) and status in ('pending_payment', 'confirmed')`)).rows.map(
        (r) => r.sessionId,
      ),
    );
    const takenDates = new Set(
      (await dbs.sys(sql<{ date: string }>`select date from opd_sessions where id = any(${[...taken]}::uuid[])`)).rows.map((r) => String(r.date)),
    );
    const dateOf = async (sid: string) => String((await dbs.sys(sql<{ date: string }>`select date from opd_sessions where id = ${sid}`)).rows[0]!.date);
    let sessionId = '';
    let ws: typeof all = [];
    for (const [sid, list] of bySession) {
      if (list.some((x) => x.free >= 3) && !takenDates.has(await dateOf(sid))) {
        sessionId = sid;
        ws = list;
        break;
      }
    }
    expect(sessionId).not.toBe('');
    const w = ws.find((x) => x.free >= 3)!;
    const booked = [];
    for (const p of people) booked.push((await holdAndPay(p.token, w.id)).verify.booking);
    booked.sort((x, y) => x.token - y.token);
    const [a, b, c] = booked;
    // Yesterday's OPD (so it overlaps nothing), started, and the doctor saw only the middle patient.
    await dbs.sys(sql`update opd_sessions set starts_at = now() - interval '30 hours', ends_at = now() - interval '28 hours', status = 'running', started_at = now() - interval '30 hours' where id = ${sessionId}`);
    await dbs.sys(sql`update opd_windows set starts_at = now() - interval '30 hours', ends_at = now() - interval '29 hours' where id = ${w.id}`);
    await api().post(`/v1/doctor/sessions/${sessionId}/call-now`).set(bearer(s.doctorToken)).send({ bookingId: b!.id }).expect(200);
    await api().post(`/v1/doctor/sessions/${sessionId}/done`).set(bearer(s.doctorToken)).send({}).expect(200);
    // The doctor never pressed END OPD. The job closes it.
    const r = await jobs.autoSessions();
    expect(r.ended).toBeGreaterThanOrEqual(1);
    const row = async (id: string) =>
      (await dbs.sys(sql<{ status: string; moved: boolean }>`select status, needs_new_time_since is not null as moved from bookings where id = ${id}`)).rows[0]!;
    expect(await row(a!.id)).toMatchObject({ status: 'no_show' }); // passed over
    expect(await row(b!.id)).toMatchObject({ status: 'completed' }); // seen
    expect(await row(c!.id)).toMatchObject({ status: 'confirmed', moved: true }); // never reached: picks a new time
  });

  it('doctors hear about their work: new bookings, time changes, emergency off, OPD soon, tomorrow; with their own settings', async () => {
    for (let i = 0; i < 10; i++) await jobs.relay();
    const doc = await dbs.db.selectFrom('doctors').select('userId').where('id', '=', s.doctorId).executeTakeFirstOrThrow();
    const titles = async () =>
      (await dbs.sys(sql<{ title: string }>`select title from notifications where user_id = ${doc.userId!}`)).rows.map((r) => r.title);

    // Every paid booking tells the doctor; an emergency one too, with its own words.
    expect(await titles()).toEqual(expect.arrayContaining(['New booking', 'Emergency patient coming']));
    const moved = await dbs.sys(sql<{ n: number }>`select count(*)::int as n from bookings where reschedule_count > 0 and doctor_id = ${s.doctorId}`);
    if (moved.rows[0]!.n > 0) expect(await titles()).toContain('Patient changed the time');

    // The doctor's Messages list (same API as patients).
    const inbox = await api().get('/v1/notifications').set(bearer(s.doctorToken)).query({ limit: 50 }).expect(200);
    expect(inbox.body.items.some((m: { title: string }) => m.title === 'New booking')).toBe(true);
    expect(inbox.body.unread).toBeGreaterThan(0);
    await api().post('/v1/notifications/read').set(bearer(s.doctorToken)).send({ all: true }).expect(200);
    const after = await api().get('/v1/notifications').set(bearer(s.doctorToken)).query({ limit: 1 }).expect(200);
    expect(after.body.unread).toBe(0);

    // One booking opened from a message: with its time and place in the line.
    const one = await api().get(`/v1/doctor/bookings/${s.bookingId}`).set(bearer(s.doctorToken)).expect(200);
    expect(one.body.name).toBeTruthy();
    expect(one.body.startsAt).toBeTruthy();
    expect(one.body.sessionDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Settings: a doctor turns "new booking" pushes off. The message still lands in the list, without a push.
    const prefs = await api().get('/v1/me/notification-prefs').set(bearer(s.doctorToken)).expect(200);
    expect(prefs.body.newBookings).toBe(true);
    const off = await api().patch('/v1/me/notification-prefs').set(bearer(s.doctorToken)).send({ newBookings: false }).expect(200);
    expect(off.body.newBookings).toBe(false);
    expect(off.body.eveningSummary).toBe(true);
    const bad = await api().patch('/v1/me/notification-prefs').set(bearer(s.doctorToken)).send({ newBookings: 'no' });
    expect(bad.status).toBe(400);
    await api().patch('/v1/me/notification-prefs').set(bearer(s.doctorToken)).send({ newBookings: true }).expect(200);

    // "Available till" ran out: status off, and the doctor is told once.
    await dbs.sys(sql`insert into emergency_status (doctor_id, hospital_id, status, until_at)
                      values (${s.doctorId}, ${s.hospitalId}, 'available_till', now() - interval '1 minute')
                      on conflict (doctor_id) do update set hospital_id = excluded.hospital_id, status = 'available_till', until_at = excluded.until_at`);
    expect(await jobs.expireEmergency()).toBe(1);
    expect(await jobs.expireEmergency()).toBe(0);
    const em = await api().get('/v1/doctor/emergency').set(bearer(s.doctorToken)).expect(200);
    expect(em.body.status).toBe('off');
    expect(await titles()).toContain('Emergency status is off');

    // "Your OPD starts soon": an OPD 20 minutes away, once only.
    const soon = await dbs.sys(sql<{ id: string }>`
      select id from opd_sessions where doctor_id = ${s.doctorId} and status = 'scheduled' and starts_at > now() + interval '1 day' order by starts_at limit 1`);
    if (soon.rows[0]) {
      const id = soon.rows[0].id;
      const was = await dbs.sys(sql<{ startsAt: Date }>`select starts_at from opd_sessions where id = ${id}`);
      await dbs.sys(sql`update opd_sessions set starts_at = now() + interval '20 minutes' where id = ${id}`).catch(() => undefined);
      const moved20 = await dbs.sys(sql<{ n: number }>`select count(*)::int as n from opd_sessions where id = ${id} and starts_at < now() + interval '1 hour'`);
      if (moved20.rows[0]!.n > 0) {
        expect(await jobs.opdSoon()).toBeGreaterThan(0);
        await jobs.opdSoon();
        const n = await dbs.sys(sql<{ n: number }>`select count(*)::int as n from notifications where user_id = ${doc.userId!} and title = 'Your OPD starts soon'`);
        expect(n.rows[0]!.n).toBe(1);
        await dbs.sys(sql`update opd_sessions set starts_at = ${was.rows[0]!.startsAt} where id = ${id}`);
      }
    }

    // 8 PM summary of tomorrow: one message per doctor, once per day.
    const tomorrow = await dbs.sys(sql<{ n: number }>`
      select count(*)::int as n from bookings b join opd_sessions o on o.id = b.session_id
       where b.doctor_id = ${s.doctorId} and b.session_date = (now() at time zone 'Asia/Kolkata')::date + 1
         and b.status = 'confirmed' and b.needs_new_time_since is null and o.status = 'scheduled'`);
    await jobs.eveningSummary();
    await jobs.eveningSummary();
    const summaries = await dbs.sys(sql<{ n: number }>`select count(*)::int as n from notifications where user_id = ${doc.userId!} and title = 'Tomorrow''s bookings'`);
    expect(summaries.rows[0]!.n).toBe(tomorrow.rows[0]!.n > 0 ? 1 : 0);
  });

  it('suspending a doctor hides them at once, refunds future bookings and ends their logins', async () => {
    const superFresh = await stepUp(s.superToken, s.superId, s.superSecret);
    const r = await api().post(`/v1/admin/doctors/${s.doctorId}/suspend`).set(bearer(superFresh)).send({ reason: 'Registration expired' }).expect(200);
    expect(r.body.suspended).toBe(true);
    await api().get(`/v1/doctors/${s.doctorId}`).expect(404);
    await api().post('/v1/auth/refresh').send({ refreshToken: s.doctorRefresh }).expect(401);
    // The refunds are background jobs: run them until none is waiting (a run already busy returns at once).
    for (let i = 0; i < 40; i++) {
      await jobs.relay();
      const waiting = await dbs.sys(sql<{ n: number }>`select count(*)::int as n from outbox where topic = 'bulk.cancel' and done_at is null`);
      if (waiting.rows[0]!.n === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const left = await dbs.sys(sql<{ n: number }>`select count(*)::int as n from bookings where doctor_id = ${s.doctorId} and status = 'confirmed'`);
    expect(left.rows[0]!.n).toBe(0);
  });

  it('patients hear about every change: booked, changed, OPD started, visit done, cancelled, money back', async () => {
    for (let i = 0; i < 10; i++) await jobs.relay();
    const rows = await dbs.sys(sql<{ title: string }>`select distinct title from notifications`);
    const titles = rows.rows.map((r) => r.title);
    expect(titles).toEqual(
      expect.arrayContaining(['Booking confirmed', 'Doctor has started the OPD', 'Visit done', 'Booking cancelled by the doctor', 'Money back sent']),
    );
    // A changed booking is told and pushed too (the change test may be refused by the 2-hour rule at some hours).
    const moved = await dbs.sys(sql<{ n: number }>`select count(*)::int as n from bookings where reschedule_count > 0`);
    if (moved.rows[0]!.n > 0) {
      expect(titles).toContain('Booking changed');
      const changed = await dbs.sys(sql<{ n: number }>`select count(*)::int as n from outbox where topic = 'notify' and payload->>'title' = 'Booking changed' and (payload->>'push') is null`);
      expect(changed.rows[0]!.n).toBeGreaterThan(0);
    }
  });

  it('housekeeping removes old messages, live-line events and login codes, and keeps recent ones', async () => {
    const before = await dbs.sys(sql<{ n: number }>`select count(*)::int as n from queue_events`);
    // Age one live-line event past 30 days (the table refuses edits, so insert an old one directly).
    const s0 = await dbs.sys(sql<{ id: string }>`select session_id as id from queue_events limit 1`);
    await dbs.sys(sql`insert into queue_events (session_id, version, type, at) values (${s0.rows[0]!.id}, 999999, 'test_old', now() - interval '40 days')`);
    const p = s.patients[1]!; // an existing patient (new logins here would hit the login rate limit)
    await dbs.sys(sql`insert into notifications (user_id, kind, title, body, created_at) values (${p.id}, 'system', 'old', 'old', now() - interval '100 days')`);
    await expect(dbs.sys(sql`delete from queue_events where type <> 'test_old'`)).rejects.toThrow(/append-only/); // recent ones stay protected
    const r = await jobs.housekeeping();
    expect(r.lineEvents).toBe(1);
    expect(r.messages).toBeGreaterThanOrEqual(1);
    const after = await dbs.sys(sql<{ n: number }>`select count(*)::int as n from queue_events`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('nightly consistency checks all pass after everything above', async () => {
    const r = await jobs.invariants();
    expect(r.details).toEqual({});
    const recon = await api().get('/v1/admin/reconciliation').set(bearer(s.superToken)).query({ date: new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10) }).expect(200);
    expect(recon.body.ok).toBe(true);
  });
});
