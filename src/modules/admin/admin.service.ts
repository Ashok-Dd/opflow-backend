import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import type { AdminPrincipal, RequestMeta } from '../../common/auth/auth.decorators';
import { audit } from '../../common/audit';
import { AppError } from '../../common/errors/app-error';
import { isUniqueViolation } from '../../common/errors/pg-errors';
import { money } from '../../common/money';
import { enqueue, notify, uuidv7 } from '../../common/outbox';
import { addDays, istToday } from '../../common/time';
import { ENV, Env } from '../../config/env';
import { LiveBus } from '../../infra/bus/live-bus';
import { DbService } from '../../infra/db/db.service';
import { STORAGE, Storage } from '../../infra/storage/storage';
import { maskContact } from '../../infra/messaging/messaging';
import { RulesService } from '../../infra/rules/rules.service';
import { TokensService } from '../auth/tokens.service';
import { loadBookings, patientView } from '../bookings/booking-views';
import { BookingsService } from '../bookings/bookings.service';
import { DirectoryService } from '../directory/directory.service';
import { doctorLine, LiveService } from '../live/live.service';
import { lockSession } from '../live/session-events';
import { PaymentsService } from '../payments/payments.service';
import { ChangesService } from './changes.service';

const as = (who: AdminPrincipal) => ({ role: 'admin' as const, adminId: who.adminId });

/** Switches that stop a feature for everyone at once (e.g. bookings during a payment outage). */
export const KILL_SWITCHES = ['bookings.enabled', 'emergency.enabled', 'emergency_consult.enabled', 'push.turn_alerts', 'picks.enabled'];

export interface HospitalInput {
  slug?: string;
  name: string;
  address: string;
  area: string;
  city: string;
  pin: string;
  lat: number;
  lng: number;
  phone: string;
  opdTimingsText?: string | null;
  hasEmergency?: boolean;
  departments?: string[];
  status?: 'active' | 'hidden';
  /** A staged upload to turn into the hospital's landscape photo; null removes the photo. */
  photoUploadKey?: string | null;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly dbs: DbService,
    private readonly rules: RulesService,
    private readonly dir: DirectoryService,
    private readonly live: LiveService,
    private readonly bookings: BookingsService,
    private readonly payments: PaymentsService,
    private readonly changes: ChangesService,
    private readonly tokens: TokensService,
    private readonly bus: LiveBus,
    @Inject(ENV) private readonly env: Env,
    @Inject(STORAGE) private readonly storage: Storage,
  ) {}

  // ── Dashboard ─────────────────────────────────────────────────────────────────────────────────────

  async today() {
    const today = istToday();
    const r = await this.dbs.sys(sql<Record<string, number>>`
      select
        (select count(*)::int from bookings where session_date = ${today}::date and status in ('confirmed', 'completed', 'no_show')) as bookings_today,
        (select count(*)::int from bookings where created_at >= ${today}::date - interval '5 hours 30 minutes' and status <> 'expired' and status <> 'pending_payment') as booked_today,
        (select count(*)::int from opd_sessions where status in ('running', 'paused')) as opds_running,
        (select count(*)::int from bookings where session_date = ${today}::date and status = 'completed') as seen_today,
        (select coalesce(sum(p.amount_paise), 0)::bigint from payments p where p.status = 'captured' and p.updated_at >= ${today}::date - interval '5 hours 30 minutes') as collected_paise,
        (select count(*)::int from refunds where created_at >= ${today}::date - interval '5 hours 30 minutes') as refunds_today,
        (select count(*)::int from doctors where verification in ('pending', 'needs_correction')) as doctors_pending,
        (select count(*)::int from payments where created_at > now() - interval '24 hours') as payments_24h,
        (select count(*)::int from payments where created_at > now() - interval '24 hours' and status = 'captured') as captured_24h`);
    const x = r.rows[0]!;
    const hourly = await this.dbs.sys(sql<{ hour: number; today: number; lastWeek: number }>`
      with h as (select generate_series(0, 23) as hour)
      select h.hour,
             (select count(*)::int from bookings b where b.status in ('confirmed', 'completed', 'no_show')
                and b.created_at >= ${today}::date - interval '5 hours 30 minutes' + make_interval(hours => h.hour)
                and b.created_at <  ${today}::date - interval '5 hours 30 minutes' + make_interval(hours => h.hour + 1)) as today,
             (select count(*)::int from bookings b where b.status in ('confirmed', 'completed', 'no_show')
                and b.created_at >= ${addDays(today, -7)}::date - interval '5 hours 30 minutes' + make_interval(hours => h.hour)
                and b.created_at <  ${addDays(today, -7)}::date - interval '5 hours 30 minutes' + make_interval(hours => h.hour + 1)) as last_week
        from h order by h.hour`);
    return {
      date: today,
      bookingsToday: x.bookingsToday,
      bookedToday: x.bookedToday,
      opdsRunning: x.opdsRunning,
      seenToday: x.seenToday,
      collected: money(Number(x.collectedPaise)),
      refundsToday: x.refundsToday,
      doctorsPending: x.doctorsPending,
      paymentSuccessRate: x.payments24h ? Math.round((x.captured24h! / x.payments24h) * 100) : null,
      hourly: hourly.rows,
    };
  }

  /** One list of everything a person must look at. */
  async attention() {
    const [refunds, bulk, doctors, docs, tickets, holdsStuck, transfers, webhooks, payouts] = await Promise.all([
      this.dbs.sys(sql`select r.id, r.amount_paise, r.attempts, r.failure_reason, r.updated_at, p.booking_id from refunds r join payments p on p.id = r.payment_id
           where r.status = 'failed' and (r.attempts >= 3 or r.next_attempt_at is null) order by r.updated_at desc limit 50`),
      this.dbs.sys(sql`select id, doctor_id, kind, done, failed, total, updated_at from bulk_operations
           where status = 'needs_attention' or (status = 'running' and updated_at < now() - interval '30 minutes') limit 50`),
      this.dbs.sys(sql`select id, name, created_at from doctors where verification = 'pending' and created_at < now() - interval '48 hours' limit 50`),
      this.dbs.sys(sql`select id, doctor_id, kind, note from doctor_documents where status = 'rejected' and reviewed_at > now() - interval '14 days' limit 50`),
      this.dbs.sys(sql`select id, created_at from support_tickets where status = 'open' and created_at < now() - interval '24 hours' limit 50`),
      this.dbs.sys(sql`select count(*)::int as n from bookings where status = 'pending_payment' and hold_expires_at < now() - interval '5 minutes'`),
      this.dbs.sys(sql`select t.id, t.doctor_id, t.amount_paise, t.release_at from transfers t left join payout_accounts pa on pa.doctor_id = t.doctor_id
           where t.status in ('on_hold', 'failed') and t.release_at < now() - interval '2 hours' and (pa.status is distinct from 'active' or t.status = 'failed') limit 50`),
      this.dbs.sys(sql`select id, type, error, received_at from webhook_events where processed_at is null and received_at < now() - interval '10 minutes' limit 50`),
      // Bank payouts the bank refused (last 14 days), or still not settled after a day.
      this.dbs.sys(sql`select po.id, po.doctor_id, d.name as doctor, po.amount_paise, po.status, po.failure_reason, po.created_at from payouts po join doctors d on d.id = po.doctor_id
           where (po.status = 'failed' and po.settled_at > now() - interval '14 days') or (po.status = 'pending' and po.created_at < now() - interval '1 day')
           order by po.created_at desc limit 50`),
    ]);
    const idle = await this.dbs.sys(sql`select s.id, s.doctor_id, d.name, s.updated_at from opd_sessions s join doctors d on d.id = s.doctor_id
                            where s.status in ('running', 'paused') and s.updated_at < now() - interval '45 minutes'`);
    return {
      failedRefunds: refunds.rows,
      stuckBulkOperations: bulk.rows,
      doctorsWaitingOver48h: doctors.rows,
      rejectedDocuments: docs.rows,
      oldTickets: tickets.rows,
      holdsNotExpired: (holdsStuck.rows[0] as { n: number }).n,
      payoutsWaiting: transfers.rows,
      unprocessedWebhooks: webhooks.rows,
      payoutProblems: payouts.rows,
      idleOpds: idle.rows,
    };
  }

  // ── Hospitals ─────────────────────────────────────────────────────────────────────────────────────

  hospitals(q: string | undefined, p: { limit: number; offset: number }) {
    return this.dir.hospitals({ q, offset: p.offset, limit: p.limit, includeHidden: true });
  }

  async createHospital(who: AdminPrincipal, h: HospitalInput, meta: RequestMeta) {
    const slug = (h.slug ?? `${h.name}-${h.area}`).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
    try {
      return await this.dbs.as(as(who), async (tx) => {
        const row = await tx
          .insertInto('hospitals')
          .values({ slug, name: h.name, address: h.address, area: h.area, city: h.city, pin: h.pin, lat: h.lat, lng: h.lng, phone: h.phone, opdTimingsText: h.opdTimingsText ?? null, hasEmergency: h.hasEmergency ?? false })
          .returning(['id', 'slug'])
          .executeTakeFirstOrThrow();
        if (h.departments?.length) await tx.insertInto('hospitalDepartments').values(h.departments.map((t) => ({ hospitalId: row.id, typeId: t }))).execute();
        await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'hospital.create', entity: 'hospital', entityId: row.id, after: h, meta });
        return row;
      });
    } catch (err) {
      if (isUniqueViolation(err, 'hospitals_slug_key')) throw new AppError('DUPLICATE_HOSPITAL', 'A hospital with this name and area already exists.', HttpStatus.CONFLICT);
      throw err;
    }
  }

  async updateHospital(who: AdminPrincipal, id: string, h: Partial<HospitalInput>, meta: RequestMeta) {
    return this.dbs.as(as(who), async (tx) => {
      const before = await tx.selectFrom('hospitals').selectAll().where('id', '=', id).executeTakeFirst();
      if (!before) throw new AppError('HOSPITAL_NOT_FOUND', 'We could not find this hospital.', HttpStatus.NOT_FOUND);
      const { departments, slug: _slug, photoUploadKey, ...rest } = h;
      const set: Record<string, unknown> = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      if (photoUploadKey === null) set.photoKey = null; // photo removed
      else if (photoUploadKey) await enqueue(tx, { topic: 'hospital.photo', payload: { hospitalId: id, uploadKey: photoUploadKey } });
      if (Object.keys(set).length) await tx.updateTable('hospitals').set(set).where('id', '=', id).execute();
      if (departments) {
        await tx.deleteFrom('hospitalDepartments').where('hospitalId', '=', id).execute();
        if (departments.length) await tx.insertInto('hospitalDepartments').values(departments.map((t) => ({ hospitalId: id, typeId: t }))).execute();
      }
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'hospital.update', entity: 'hospital', entityId: id, before, after: h, meta });
      return { ok: true };
    });
  }

  /** A 5-minute upload link for a hospital's photo (the file goes straight to storage; the worker makes the sizes). */
  async hospitalPhotoUploadUrl(id: string, contentType: string) {
    const exists = await this.dbs.db.selectFrom('hospitals').select('id').where('id', '=', id).executeTakeFirst();
    if (!exists) throw new AppError('HOSPITAL_NOT_FOUND', 'We could not find this hospital.', HttpStatus.NOT_FOUND);
    const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
    const key = `uploads/hospitals/${id}/${uuidv7()}.${ext}`;
    const put = await this.storage.presignPut('private', key, contentType, 300);
    return { key, url: put.url, headers: put.headers, method: 'PUT', maxBytes: this.env.UPLOAD_MAX_BYTES, expiresInSeconds: 300 };
  }

  async hospital(id: string) {
    const h = await this.dbs.db.selectFrom('hospitals').selectAll().where('id', '=', id).executeTakeFirst();
    if (!h) throw new AppError('HOSPITAL_NOT_FOUND', 'We could not find this hospital.', HttpStatus.NOT_FOUND);
    const departments = await this.dbs.db.selectFrom('hospitalDepartments').select('typeId').where('hospitalId', '=', id).execute();
    const doctors = await this.dir.cards({ hospital: id, includeUnlisted: true, limit: 100 });
    const sessions = await this.dbs.db
      .selectFrom('opdSessions as s')
      .innerJoin('doctors as d', 'd.id', 's.doctorId')
      .select(['s.id', 's.status', 's.startsAt', 's.endsAt', 'd.name as doctorName'])
      .where('s.hospitalId', '=', id)
      .where('s.date', '=', istToday())
      .execute();
    return { ...h, photo: this.dir.photo(h.photoKey), departments: departments.map((d) => d.typeId), doctors: doctors.items, todaySessions: sessions };
  }

  /** Address → map pin (Google Geocoding), when a key is configured. */
  /**
   * Address → map points for a hospital. Google Maps when GOOGLE_MAPS_API_KEY is set; otherwise OpenStreetMap
   * (Nominatim: free, no key; its rules allow this light admin-only use: one search per click, identified).
   */
  async geocode(address: string) {
    const key = this.env.GOOGLE_MAPS_API_KEY;
    if (key) {
      const res = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?region=in&address=${encodeURIComponent(address)}&key=${key}`, { signal: AbortSignal.timeout(6000) });
      const body = (await res.json()) as { results?: { formatted_address: string; geometry: { location: { lat: number; lng: number } } }[] };
      return (body.results ?? []).slice(0, 5).map((r) => ({ address: r.formatted_address, lat: r.geometry.location.lat, lng: r.geometry.location.lng }));
    }
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=in&limit=5&q=${encodeURIComponent(address)}`;
    const res = await fetch(url, {
      headers: { 'user-agent': `OPflow-admin/1.0 (${this.env.ADMIN_PUBLIC_URL})`, 'accept-language': 'en-IN' },
      signal: AbortSignal.timeout(8000),
    }).catch(() => null);
    if (!res?.ok) throw new AppError('GEOCODE_UNAVAILABLE', 'Map search is not working right now. Please paste the location from Google Maps.', HttpStatus.SERVICE_UNAVAILABLE, true);
    const rows = (await res.json()) as { display_name: string; lat: string; lon: string }[];
    return rows.slice(0, 5).map((r) => ({ address: r.display_name, lat: Number(r.lat), lng: Number(r.lon) }));
  }

  // ── Bookings ──────────────────────────────────────────────────────────────────────────────────────

  async searchBookings(f: { code?: string; phone?: string; doctor?: string; date?: string; token?: number; limit: number; offset: number }) {
    const rows = await this.dbs.sys(sql<{ id: string }>`
      select b.id from bookings b left join users u on u.id = b.patient_user_id
       where (${f.code ?? null}::text is null or b.code = upper(${f.code ?? null}::text))
         and (${f.phone ?? null}::text is null or u.phone = ${f.phone ?? null}::text)
         and (${f.doctor ?? null}::uuid is null or b.doctor_id = ${f.doctor ?? null}::uuid)
         and (${f.date ?? null}::date is null or b.session_date = ${f.date ?? null}::date)
         and (${f.token ?? null}::int is null or b.token = ${f.token ?? null}::int)
       order by b.created_at desc limit ${f.limit + 1} offset ${f.offset}`);
    const ids = rows.rows.slice(0, f.limit).map((r) => r.id);
    const rules = await this.bookings.changeRules();
    const loaded = ids.length ? await this.dbs.system((tx) => loadBookings(tx, { ids, limit: ids.length })) : [];
    const byId = new Map(loaded.map((b) => [b.id, patientView(b, this.dir, rules)]));
    return { items: ids.map((id) => byId.get(id)).filter(Boolean), hasMore: rows.rows.length > f.limit };
  }

  async booking(id: string) {
    const rules = await this.bookings.changeRules();
    return this.dbs.system(async (tx) => {
      const rows = await loadBookings(tx, { ids: [id] });
      const b = rows[0];
      if (!b) throw new AppError('BOOKING_NOT_FOUND', 'We could not find this booking.', HttpStatus.NOT_FOUND);
      const events = await tx.selectFrom('bookingEvents').select(['type', 'actorType', 'actorId', 'data', 'at']).where('bookingId', '=', id).orderBy('at').orderBy('id').execute();
      const payments = await tx.selectFrom('payments').select(['id', 'gatewayOrderId', 'gatewayPaymentId', 'amountPaise', 'status', 'method', 'failureReason', 'abandoned', 'createdAt']).where('bookingId', '=', id).execute();
      const refunds = await tx
        .selectFrom('refunds as r')
        .innerJoin('payments as p', 'p.id', 'r.paymentId')
        .select(['r.id', 'r.amountPaise', 'r.reason', 'r.status', 'r.attempts', 'r.gatewayRefundId', 'r.failureReason', 'r.manualReference', 'r.createdAt'])
        .where('p.bookingId', '=', id)
        .execute();
      const transfers = await tx
        .selectFrom('transfers as t')
        .innerJoin('payments as p', 'p.id', 't.paymentId')
        .select(['t.id', 't.amountPaise', 't.status', 't.releaseAt', 't.releasedAt', 't.reversedAt', 't.payoutId', 't.recoverPaise'])
        .where('p.bookingId', '=', id)
        .execute();
      const queue = await tx.selectFrom('queueEvents').select(['version', 'type', 'at', 'actorId']).where('bookingId', '=', id).orderBy('version').execute();
      return { booking: patientView(b, this.dir, rules), events, payments, refunds, transfers, queue };
    });
  }

  async resendReceipt(who: AdminPrincipal, id: string, meta: RequestMeta) {
    await this.dbs.as(as(who), async (tx) => {
      const b = await tx.selectFrom('bookings').select(['id', 'patientUserId', 'code', 'status']).where('id', '=', id).executeTakeFirst();
      if (!b?.patientUserId) throw new AppError('BOOKING_NOT_FOUND', 'We could not find this booking.', HttpStatus.NOT_FOUND);
      await notify(tx, { userId: b.patientUserId, kind: 'system', title: 'Your receipt', body: `Your receipt for booking ${b.code} is in the app under My bookings.`, bookingId: b.id, dedupeKey: `receipt:${b.id}:${Date.now()}` });
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'booking.resend_receipt', entity: 'booking', entityId: id, meta });
    });
    return { ok: true };
  }

  /** Goodwill refund (the admin re-enters their authenticator code; written to the audit log). */
  async refund(who: AdminPrincipal, bookingId: string, amountPaise: number, reason: string, meta: RequestMeta) {
    return this.dbs.as(as(who), async (tx) => {
      const pay = await tx
        .selectFrom('payments as p')
        .innerJoin('bookings as b', 'b.id', 'p.bookingId')
        .select(['p.id', 'p.amountPaise', 'b.patientUserId'])
        .where('p.bookingId', '=', bookingId)
        .where('p.status', '=', 'captured')
        .executeTakeFirst();
      if (!pay) throw new AppError('NOT_PAID', 'This booking has no payment to refund.', HttpStatus.UNPROCESSABLE_ENTITY);
      const refunded = await tx.selectFrom('refunds').select((eb) => eb.fn.coalesce(eb.fn.sum<number>('amountPaise'), eb.lit(0)).as('s')).where('paymentId', '=', pay.id).where('status', '<>', 'failed').executeTakeFirstOrThrow();
      const left = pay.amountPaise - Number(refunded.s);
      if (amountPaise > left) throw new AppError('TOO_MUCH', `At most ${money(left).display} can still be refunded.`, HttpStatus.UNPROCESSABLE_ENTITY);
      const refundId = await this.payments.createRefund(tx, { paymentId: pay.id, amountPaise, reason: 'admin_goodwill', byType: 'admin', by: who.adminId, bookingId, patientUserId: pay.patientUserId });
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'booking.refund', entity: 'booking', entityId: bookingId, after: { amountPaise, reason, refundId }, meta });
      return { refundId, status: 'pending' };
    });
  }

  /** "Move to another time" on the doctor's behalf (consent noted in the reason). */
  async moveBooking(who: AdminPrincipal, bookingId: string, reason: string, meta: RequestMeta) {
    const r = await this.dbs.as(as(who), async (tx) => {
      const b = await tx.selectFrom('bookings').select('sessionId').where('id', '=', bookingId).executeTakeFirst();
      if (!b) throw new AppError('BOOKING_NOT_FOUND', 'We could not find this booking.', HttpStatus.NOT_FOUND);
      await lockSession(tx, b.sessionId);
      const res = await this.bookings.moveByProvider(tx, bookingId, { type: 'admin', id: who.adminId }, reason);
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'booking.move', entity: 'booking', entityId: bookingId, after: { reason }, meta });
      return res;
    });
    if (r) this.bus.publish(r);
    return { ok: !!r };
  }

  /** Cancel on the doctor's behalf, with full refund. */
  async cancelBooking(who: AdminPrincipal, bookingId: string, reason: string, meta: RequestMeta) {
    const r = await this.dbs.as(as(who), async (tx) => {
      const b = await tx.selectFrom('bookings').select('sessionId').where('id', '=', bookingId).executeTakeFirst();
      if (!b) throw new AppError('BOOKING_NOT_FOUND', 'We could not find this booking.', HttpStatus.NOT_FOUND);
      await lockSession(tx, b.sessionId);
      const res = await this.bookings.cancelByProvider(tx, bookingId, { type: 'admin', id: who.adminId }, reason);
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'booking.cancel', entity: 'booking', entityId: bookingId, after: { reason }, meta });
      return res;
    });
    if (r) this.bus.publish(r);
    return { ok: !!r, refund: r ? money(r.refundPaise) : null };
  }

  // ── Live OPDs (read-only: admins never press the doctor's buttons) ────────────────────────────────

  async liveSessions() {
    const r = await this.dbs.sys(sql`
      select s.id, s.status, s.starts_at, s.ends_at, s.late_minutes, s.now_seeing_token, s.updated_at, d.name as doctor, h.name as hospital,
             (select count(*)::int from queue_entries q where q.session_id = s.id and q.state = 'waiting') as waiting,
             (select count(*)::int from queue_entries q where q.session_id = s.id and q.state = 'done') as done,
             (select max(e.at) from queue_events e where e.session_id = s.id) as last_action,
             coalesce((select max(e.at) from queue_events e where e.session_id = s.id), s.started_at) < now() - interval '45 minutes' as maybe_forgotten
        from opd_sessions s join doctors d on d.id = s.doctor_id join hospitals h on h.id = s.hospital_id
       where s.status in ('running', 'paused') order by s.starts_at`);
    return r.rows;
  }

  async liveSession(id: string) {
    const { head, entries } = await this.live.load(undefined, id);
    const events = await this.dbs.db.selectFrom('queueEvents').select(['version', 'type', 'bookingId', 'at']).where('sessionId', '=', id).orderBy('version', 'desc').limit(200).execute();
    return { ...doctorLine(head, entries), events };
  }

  // ── Money ─────────────────────────────────────────────────────────────────────────────────────────

  paymentsList(f: { status?: string; method?: string; from?: string; to?: string; limit: number; offset: number }) {
    return this.dbs.sys(sql`
      select p.id, p.booking_id, b.code, p.gateway_order_id, p.gateway_payment_id, p.amount_paise, p.status, p.method, p.failure_reason, p.created_at
        from payments p join bookings b on b.id = p.booking_id
       where (${f.status ?? null}::text is null or p.status::text = ${f.status ?? null}::text)
         and (${f.method ?? null}::text is null or p.method = ${f.method ?? null}::text)
         and (${f.from ?? null}::date is null or p.created_at >= ${f.from ?? null}::date - interval '5 hours 30 minutes')
         and (${f.to ?? null}::date is null or p.created_at < ${f.to ?? null}::date + interval '18 hours 30 minutes')
       order by p.created_at desc limit ${f.limit} offset ${f.offset}`).then((r) => r.rows);
  }

  refunds(status: string | undefined, limit: number, offset: number) {
    return this.dbs.sys(sql`
      select r.id, r.amount_paise, r.reason, r.status, r.attempts, r.failure_reason, r.next_attempt_at, r.gateway_refund_id, r.manual_reference,
             r.created_at, b.id as booking_id, b.code, b.patient_name
        from refunds r join payments p on p.id = r.payment_id join bookings b on b.id = p.booking_id
       where (${status ?? null}::text is null or r.status::text = ${status ?? null}::text)
       order by r.created_at desc limit ${limit} offset ${offset}`).then((r) => r.rows);
  }

  async retryRefund(who: AdminPrincipal, id: string, meta: RequestMeta) {
    await this.dbs.as(as(who), async (tx) => {
      const r = await tx.updateTable('refunds').set({ status: 'pending', nextAttemptAt: null, attempts: 0 }).where('id', '=', id).where('status', '=', 'failed').executeTakeFirst();
      if (Number(r.numUpdatedRows) !== 1) throw new AppError('NOT_FAILED', 'Only a failed refund can be retried.', HttpStatus.CONFLICT);
      await enqueue(tx, { topic: 'refund.start', payload: { refundId: id } });
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'refund.retry', entity: 'refund', entityId: id, meta });
    });
    return { ok: true };
  }

  /** Paid by hand (bank transfer) when the card/UPI route keeps failing. */
  async markRefundPaid(who: AdminPrincipal, id: string, utr: string, meta: RequestMeta) {
    await this.dbs.as(as(who), async (tx) => {
      const r = await tx.selectFrom('refunds').select(['status']).where('id', '=', id).executeTakeFirst();
      if (!r || r.status === 'processed') throw new AppError('NOT_ALLOWED', 'This refund is already done.', HttpStatus.CONFLICT);
      await tx.updateTable('refunds').set({ manualReference: utr }).where('id', '=', id).execute();
      await this.payments.markRefund(tx, id, 'processed');
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'refund.mark_paid', entity: 'refund', entityId: id, after: { utr }, meta });
    });
    return { ok: true };
  }

  transfers(status: string | undefined, doctorId: string | undefined, limit: number, offset: number) {
    return this.dbs.sys(sql`
      select t.id, t.doctor_id, d.name as doctor, t.amount_paise, t.status, t.release_at, t.released_at, t.reversed_at, t.payout_id,
             po.status as payout_status, t.recover_paise, b.code
        from transfers t join doctors d on d.id = t.doctor_id join payments p on p.id = t.payment_id join bookings b on b.id = p.booking_id
        left join payouts po on po.id = t.payout_id
       where (${status ?? null}::text is null or t.status::text = ${status ?? null}::text)
         and (${doctorId ?? null}::uuid is null or t.doctor_id = ${doctorId ?? null}::uuid)
       order by t.release_at desc limit ${limit} offset ${offset}`).then((r) => r.rows);
  }

  /** Bank payouts to doctors (Cashfree Payouts): one per doctor per run, newest first. */
  payoutsList(status: string | undefined, doctorId: string | undefined, limit: number, offset: number) {
    return this.dbs.sys(sql`
      select po.id, po.doctor_id, d.name as doctor, po.amount_paise, po.visits_paise, po.deducted_paise, po.status, po.utr,
             po.failure_reason, po.created_at, po.settled_at, a.bank_last4,
             (select count(*)::int from transfers t where t.payout_id = po.id) as visits
        from payouts po join doctors d on d.id = po.doctor_id left join payout_accounts a on a.doctor_id = po.doctor_id
       where (${status ?? null}::text is null or po.status = ${status ?? null}::text)
         and (${doctorId ?? null}::uuid is null or po.doctor_id = ${doctorId ?? null}::uuid)
       order by po.created_at desc limit ${limit} offset ${offset}`).then((r) => r.rows);
  }

  /** "Pay doctors now": runs the payout job at once (it only pays what is due, exactly as the hourly run). */
  async runPayouts(who: AdminPrincipal, meta: RequestMeta) {
    const r = await this.payments.releaseDueTransfers();
    await this.dbs.as(as(who), (tx) => audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'payouts.run', entity: 'payouts', entityId: null, after: r, meta }));
    return r;
  }

  /** Daily money check: captured − refunded − doctor transfers = OPflow's share, and every rule holds. */
  async reconciliation(date: string) {
    const r = await this.dbs.sys(sql<Record<string, number>>`
      with day as (select p.* from payments p join bookings b on b.id = p.booking_id
                    where p.status = 'captured' and p.updated_at >= ${date}::date - interval '5 hours 30 minutes'
                      and p.updated_at < ${date}::date + interval '18 hours 30 minutes')
      select (select count(*)::int from day) as payments,
             (select coalesce(sum(amount_paise), 0)::bigint from day) as captured,
             (select coalesce(sum(r.amount_paise), 0)::bigint from refunds r where r.payment_id in (select id from day) and r.status <> 'failed') as refunded,
             (select coalesce(sum(t.amount_paise), 0)::bigint from transfers t where t.payment_id in (select id from day) and t.status <> 'reversed') as to_doctors,
             (select count(*)::int from day d where not exists (select 1 from transfers t where t.payment_id = d.id)
                and not exists (select 1 from refunds r where r.payment_id = d.id)) as captured_without_transfer_or_refund`);
    const x = r.rows[0]!;
    const captured = Number(x.captured);
    const refunded = Number(x.refunded);
    const toDoctors = Number(x.toDoctors);
    return {
      date,
      payments: x.payments,
      captured: money(captured),
      refunded: money(refunded),
      toDoctors: money(toDoctors),
      opflow: money(captured - refunded - toDoctors),
      mismatches: x.capturedWithoutTransferOrRefund,
      ok: x.capturedWithoutTransferOrRefund === 0,
    };
  }

  /** CSV exports for finance. */
  async exportCsv(kind: 'payments' | 'refunds' | 'transfers' | 'payouts', from: string, to: string): Promise<string> {
    const q =
      kind === 'payments'
        ? sql`select p.created_at, b.code, p.gateway_order_id, p.gateway_payment_id, p.amount_paise, p.status, p.method from payments p join bookings b on b.id = p.booking_id
               where p.created_at >= ${from}::date - interval '5 hours 30 minutes' and p.created_at < ${to}::date + interval '18 hours 30 minutes' order by p.created_at`
        : kind === 'refunds'
          ? sql`select r.created_at, b.code, r.amount_paise, r.reason, r.status, r.gateway_refund_id, r.manual_reference from refunds r join payments p on p.id = r.payment_id join bookings b on b.id = p.booking_id
                 where r.created_at >= ${from}::date - interval '5 hours 30 minutes' and r.created_at < ${to}::date + interval '18 hours 30 minutes' order by r.created_at`
          : kind === 'transfers'
            ? sql`select t.release_at, d.name as doctor, b.code, t.amount_paise, t.status, t.payout_id, t.recover_paise from transfers t join doctors d on d.id = t.doctor_id join payments p on p.id = t.payment_id join bookings b on b.id = p.booking_id
                   where t.release_at >= ${from}::date - interval '5 hours 30 minutes' and t.release_at < ${to}::date + interval '18 hours 30 minutes' order by t.release_at`
            : sql`select po.created_at, d.name as doctor, po.amount_paise, po.visits_paise, po.deducted_paise, po.status, po.utr, po.settled_at from payouts po join doctors d on d.id = po.doctor_id
                   where po.created_at >= ${from}::date - interval '5 hours 30 minutes' and po.created_at < ${to}::date + interval '18 hours 30 minutes' order by po.created_at`;
    const rows = (await this.dbs.sys(q)).rows as Record<string, unknown>[];
    const esc = (v: unknown) => {
      const s = v instanceof Date ? v.toISOString() : v === null || v === undefined ? '' : String(v);
      // Guard against spreadsheet formula injection.
      const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const headers = rows[0] ? Object.keys(rows[0]) : [];
    return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n');
  }

  // ── Patients (least data: masked phone, logged reveal) ────────────────────────────────────────────

  async patients(phone: string | undefined, code: string | undefined) {
    const rows = await this.dbs.sys(sql<{ id: string; phone: string | null; status: string; createdAt: Date; name: string | null; birthYear: number | null; gender: string | null; place: string | null }>`
      select u.id, u.phone, u.status, u.created_at, p.name, p.birth_year, p.gender, p.place
        from users u left join patient_profiles p on p.user_id = u.id
       where exists (select 1 from user_roles r where r.user_id = u.id and r.role = 'patient')
         and ((${phone ?? null}::text is not null and u.phone = ${phone ?? null}::text)
              or (${code ?? null}::text is not null and u.id = (select patient_user_id from bookings where code = upper(${code ?? null}::text))))
       limit 20`);
    return rows.rows.map((r) => ({ ...r, phone: r.phone ? maskContact(r.phone) : null }));
  }

  async patient(id: string) {
    const u = await this.dbs.system((tx) => tx
      .selectFrom('users as u')
      .leftJoin('patientProfiles as p', 'p.userId', 'u.id')
      .select(['u.id', 'u.phone', 'u.status', 'u.createdAt', 'u.lastLoginAt', 'p.name', 'p.birthYear', 'p.gender', 'p.place'])
      .where('u.id', '=', id)
      .executeTakeFirst());
    if (!u) throw new AppError('NOT_FOUND', 'We could not find this person.', HttpStatus.NOT_FOUND);
    const rules = await this.bookings.changeRules();
    const bookings = await this.dbs.system((tx) => loadBookings(tx, { patientUserId: id, limit: 50 }));
    return { ...u, phone: u.phone ? maskContact(u.phone) : null, bookings: bookings.map((b) => patientView(b, this.dir, rules)) };
  }

  async reveal(who: AdminPrincipal, id: string, reason: string, meta: RequestMeta) {
    return this.dbs.as(as(who), async (tx) => {
      const u = await tx.selectFrom('users').select(['phone']).where('id', '=', id).executeTakeFirst();
      if (!u) throw new AppError('NOT_FOUND', 'We could not find this person.', HttpStatus.NOT_FOUND);
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'patient.reveal_phone', entity: 'user', entityId: id, after: { reason }, meta });
      return { phone: u.phone };
    });
  }

  async block(who: AdminPrincipal, id: string, blocked: boolean, reason: string, meta: RequestMeta) {
    await this.dbs.as(as(who), async (tx) => {
      await tx.updateTable('users').set({ status: blocked ? 'suspended' : 'active' }).where('id', '=', id).where('status', '<>', 'deleted').execute();
      if (blocked) await this.tokens.revokeAllForUser(tx, id, 'patient');
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: blocked ? 'patient.block' : 'patient.unblock', entity: 'user', entityId: id, after: { reason }, meta });
    });
    return { ok: true };
  }

  /** DPDP deletion on request: same as the patient deleting their account. */
  async deletePatient(who: AdminPrincipal, id: string, reason: string, meta: RequestMeta) {
    await this.dbs.as(as(who), async (tx) => {
      const live = await tx.selectFrom('bookings').select('id').where('patientUserId', '=', id).where('status', 'in', ['pending_payment', 'confirmed']).executeTakeFirst();
      if (live) throw new AppError('HAS_BOOKINGS', 'This person has an upcoming booking. Cancel or finish it first.', HttpStatus.CONFLICT);
      await tx.updateTable('users').set({ status: 'deleted', deletedAt: new Date(), phone: null, email: null }).where('id', '=', id).execute();
      await tx.deleteFrom('patientProfiles').where('userId', '=', id).execute();
      await tx.deleteFrom('devices').where('userId', '=', id).execute();
      await sql`update bookings set patient_name = 'Deleted user', note = '' where patient_user_id = ${id}`.execute(tx);
      await this.tokens.revokeAllForUser(tx, id);
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'patient.delete', entity: 'user', entityId: id, after: { reason }, meta });
    });
    return { ok: true };
  }

  async exportPatient(who: AdminPrincipal, id: string, meta: RequestMeta) {
    const data = await this.patient(id);
    const full = await this.dbs.db.selectFrom('users').select(['phone']).where('id', '=', id).executeTakeFirst();
    await this.dbs.as(as(who), (tx) => audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'patient.export', entity: 'user', entityId: id, meta }));
    return { ...data, phone: full?.phone ?? null, exportedAt: new Date() };
  }

  // ── Emergency ─────────────────────────────────────────────────────────────────────────────────────

  async emergencyList() {
    const r = await this.dbs.sys(sql`
      select es.doctor_id, d.name, es.status, es.until_at, es.mode, es.updated_at, h.name as hospital
        from emergency_status es join doctors d on d.id = es.doctor_id left join hospitals h on h.id = es.hospital_id
       where es.status <> 'off' order by es.updated_at desc`);
    return r.rows;
  }

  async emergencyOff(who: AdminPrincipal, doctorId: string, reason: string, meta: RequestMeta) {
    await this.dbs.as(as(who), async (tx) => {
      await tx.updateTable('emergencyStatus').set({ status: 'off', untilAt: null, hospitalId: null, updatedAt: new Date() }).where('doctorId', '=', doctorId).execute();
      const d = await tx.selectFrom('doctors').select('userId').where('id', '=', doctorId).executeTakeFirst();
      if (d) await notify(tx, { userId: d.userId, kind: 'system', title: 'Emergency status turned off', body: `The OPflow team turned off your emergency status: ${reason}` });
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'emergency.off', entity: 'doctor', entityId: doctorId, after: { reason }, meta });
    });
    return { ok: true };
  }

  // ── Content: first aid and catalog ────────────────────────────────────────────────────────────────

  firstAidList() {
    return this.dbs.db.selectFrom('firstAidGuides').selectAll().orderBy('kindId').execute();
  }

  /** Any edit sends the page back to review: emergency advice is never changed casually. */
  async putFirstAid(
    who: AdminPrincipal,
    kind: string,
    g: { intro?: string | null; signs: string[]; callNowIf: string[]; dos: string[]; donts: string[]; sources: { title: string; year?: number | null; url?: string | null }[]; sourceToConfirm: boolean },
    meta: RequestMeta,
  ) {
    await this.dbs.as(as(who), async (tx) => {
      const before = await tx.selectFrom('firstAidGuides').selectAll().where('kindId', '=', kind).executeTakeFirst();
      const values = {
        intro: g.intro ?? null,
        signs: g.signs,
        callNowIf: g.callNowIf,
        dos: g.dos,
        donts: g.donts,
        sources: JSON.stringify(g.sources),
        sourceToConfirm: g.sourceToConfirm,
        status: 'in_review' as const,
        reviewedByDoctor: null,
        reviewedAt: null,
        publishedAt: null,
      };
      await tx.insertInto('firstAidGuides').values({ kindId: kind, ...values }).onConflict((oc) => oc.column('kindId').doUpdateSet(values)).execute();
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'first_aid.edit', entity: 'first_aid', entityId: kind, before, after: g, meta });
    });
    return { ok: true, status: 'in_review' };
  }

  async publishFirstAid(who: AdminPrincipal, kind: string, reviewedByDoctor: string, meta: RequestMeta) {
    await this.dbs.as(as(who), async (tx) => {
      const g = await tx.selectFrom('firstAidGuides').select(['sourceToConfirm']).where('kindId', '=', kind).executeTakeFirst();
      if (!g) throw new AppError('NOT_FOUND', 'We could not find this page.', HttpStatus.NOT_FOUND);
      if (g.sourceToConfirm) throw new AppError('SOURCE_NOT_CONFIRMED', 'Please confirm the exact WHO source before publishing.', HttpStatus.UNPROCESSABLE_ENTITY);
      await tx.updateTable('firstAidGuides').set({ status: 'published', reviewedByDoctor, reviewedAt: new Date(), publishedAt: new Date() }).where('kindId', '=', kind).execute();
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'first_aid.publish', entity: 'first_aid', entityId: kind, after: { reviewedByDoctor }, meta });
    });
    return { ok: true, status: 'published' };
  }

  catalog(part: 'types' | 'problems' | 'emergency-kinds') {
    if (part === 'types') return this.dbs.db.selectFrom('doctorTypes').selectAll().orderBy('sort').execute();
    if (part === 'problems') {
      return Promise.all([
        this.dbs.db.selectFrom('healthProblems').selectAll().orderBy('sort').execute(),
        this.dbs.db.selectFrom('problemTypeMap').selectAll().execute(),
      ]).then(([problems, map]) => problems.map((p) => ({ ...p, map: map.filter((m) => m.problemId === p.id) })));
    }
    return Promise.all([
      this.dbs.db.selectFrom('emergencyKinds').selectAll().orderBy('sort').execute(),
      this.dbs.db.selectFrom('emergencyKindTypes').selectAll().execute(),
    ]).then(([kinds, types]) => kinds.map((k) => ({ ...k, typeIds: types.filter((t) => t.kindId === k.id).map((t) => t.typeId) })));
  }

  /** Upserts catalog rows (never deletes: old bookings and doctors refer to them). */
  async putCatalog(who: AdminPrincipal, part: 'types' | 'problems' | 'emergency-kinds', items: Record<string, unknown>[], meta: RequestMeta) {
    await this.dbs.as(as(who), async (tx) => {
      for (const it of items) {
        if (part === 'types') {
          const v = { simpleName: String(it.simpleName), properName: String(it.properName), icon: String(it.icon), sort: Number(it.sort ?? 0), isCommon: Boolean(it.isCommon) };
          await tx.insertInto('doctorTypes').values({ id: String(it.id), ...v }).onConflict((oc) => oc.column('id').doUpdateSet(v)).execute();
        } else if (part === 'problems') {
          const v = { name: String(it.name), icon: String(it.icon), isDanger: Boolean(it.isDanger), sort: Number(it.sort ?? 0) };
          await tx.insertInto('healthProblems').values({ id: String(it.id), ...v }).onConflict((oc) => oc.column('id').doUpdateSet(v)).execute();
          const map = it.map as { typeId: string; audience: 'adult' | 'child'; rank?: number }[] | undefined;
          if (map) {
            await tx.deleteFrom('problemTypeMap').where('problemId', '=', String(it.id)).execute();
            if (map.length) await tx.insertInto('problemTypeMap').values(map.map((m) => ({ problemId: String(it.id), typeId: m.typeId, audience: m.audience, rank: m.rank ?? 1 }))).execute();
          }
        } else {
          const v = { name: String(it.name), detail: String(it.detail), icon: String(it.icon), sort: Number(it.sort ?? 0) };
          await tx.insertInto('emergencyKinds').values({ id: String(it.id), ...v }).onConflict((oc) => oc.column('id').doUpdateSet(v)).execute();
          const typeIds = it.typeIds as string[] | undefined;
          if (typeIds) {
            await tx.deleteFrom('emergencyKindTypes').where('kindId', '=', String(it.id)).execute();
            if (typeIds.length) await tx.insertInto('emergencyKindTypes').values(typeIds.map((t) => ({ kindId: String(it.id), typeId: t }))).execute();
          }
        }
      }
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: `catalog.${part}.update`, entity: 'catalog', entityId: part, after: items, meta });
    });
    return { ok: true, message: 'Saved. The app shows it at its next refresh (within a minute).' };
  }

  // ── Support ───────────────────────────────────────────────────────────────────────────────────────

  tickets(status: string | undefined, limit: number, offset: number) {
    return this.dbs.sys(sql`
      select t.id, t.message, t.status, t.request_id, t.created_at, t.updated_at, t.user_id, a.name as assigned_to,
             coalesce(p.name, d.name) as from_name, case when d.id is not null then 'doctor' else 'patient' end as from_role
        from support_tickets t left join admin_users a on a.id = t.assigned_to left join patient_profiles p on p.user_id = t.user_id
        left join doctors d on d.user_id = t.user_id
       where (${status ?? null}::text is null or t.status::text = ${status ?? null}::text)
       order by t.created_at desc limit ${limit} offset ${offset}`).then((r) => r.rows);
  }

  async replyTicket(who: AdminPrincipal, id: string, reply: string, meta: RequestMeta) {
    await this.dbs.as(as(who), async (tx) => {
      const t = await tx.selectFrom('supportTickets').select(['userId', 'status']).where('id', '=', id).executeTakeFirst();
      if (!t) throw new AppError('NOT_FOUND', 'We could not find this ticket.', HttpStatus.NOT_FOUND);
      await tx.updateTable('supportTickets').set({ status: 'answered', assignedTo: who.adminId }).where('id', '=', id).execute();
      if (t.userId) await notify(tx, { userId: t.userId, kind: 'system', title: 'Reply from OPflow', body: reply.slice(0, 500), data: { ticketId: id } });
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'ticket.reply', entity: 'ticket', entityId: id, after: { reply }, meta });
    });
    return { ok: true };
  }

  async closeTicket(who: AdminPrincipal, id: string, meta: RequestMeta) {
    await this.dbs.as(as(who), async (tx) => {
      await tx.updateTable('supportTickets').set({ status: 'closed' }).where('id', '=', id).execute();
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'ticket.close', entity: 'ticket', entityId: id, meta });
    });
    return { ok: true };
  }

  // ── Settings ──────────────────────────────────────────────────────────────────────────────────────

  config() {
    return this.dbs.db.selectFrom('appConfig').selectAll().orderBy('key').execute().then((rows) => rows.map((r) => ({ ...r, killSwitch: KILL_SWITCHES.includes(r.key) })));
  }

  /** Changes a rule at once (step-up + reason + audit log). */
  async setConfig(who: AdminPrincipal, key: string, value: unknown, reason: string, meta: RequestMeta) {
    return this.dbs.as(as(who), async (tx) => {
      const row = await tx.selectFrom('appConfig').select(['value']).where('key', '=', key).executeTakeFirst();
      if (!row) throw new AppError('NOT_FOUND', 'There is no such rule.', HttpStatus.NOT_FOUND);
      if (typeof value !== typeof row.value && row.value !== null) throw new AppError('INVALID_INPUT', 'This value has the wrong type.', HttpStatus.BAD_REQUEST);
      // "Find Your Right Doctor": a sensible price (₹1–₹1,000) and distance (1–100 km); some text for "How we recommend".
      if (key === 'picks.price_paise' && !(Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 100_000)) {
        throw new AppError('INVALID_INPUT', 'The price must be in paise, between 100 (₹1) and 100000 (₹1,000).', HttpStatus.BAD_REQUEST);
      }
      if (key === 'payouts.min_paise' && !(Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 500_000)) {
        throw new AppError('INVALID_INPUT', 'The smallest payout must be in paise, between 100 (₹1) and 500000 (₹5,000).', HttpStatus.BAD_REQUEST);
      }
      if (key === 'picks.max_km' && !(Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 100)) {
        throw new AppError('INVALID_INPUT', 'The distance must be between 1 and 100 km.', HttpStatus.BAD_REQUEST);
      }
      if (key === 'picks.criteria' && !(typeof value === 'string' && value.trim().length >= 40 && value.length <= 600)) {
        throw new AppError('INVALID_INPUT', 'Please write how OPflow recommends in 40 to 600 letters.', HttpStatus.BAD_REQUEST);
      }
      if (key === 'platform_fee_percent') throw new AppError('LOCKED_RULE', 'The 10% fee is fixed in the database and changed only by a migration.', HttpStatus.UNPROCESSABLE_ENTITY);
      await this.changes.apply(tx, who, { type: 'app_config', id: key }, { kind: 'config_change', key, value }, reason, meta);
      return { ok: true, key, value, message: 'Saved. Every server follows within about 15 seconds.' };
    });
  }

  /** Break glass: one admin can turn a kill switch OFF immediately. */
  async kill(who: AdminPrincipal, key: string, reason: string, meta: RequestMeta) {
    if (!KILL_SWITCHES.includes(key)) throw new AppError('NOT_A_SWITCH', 'This rule is not a kill switch.', HttpStatus.UNPROCESSABLE_ENTITY);
    await this.dbs.as(as(who), async (tx) => {
      await tx.updateTable('appConfig').set({ value: JSON.stringify(false), updatedBy: who.adminId }).where('key', '=', key).execute();
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'config.kill', entity: 'app_config', entityId: key, after: { value: false, reason }, meta });
      if (this.env.ADMIN_ALERT_EMAIL) {
        await enqueue(tx, { topic: 'email', payload: { to: this.env.ADMIN_ALERT_EMAIL, subject: `OPflow: ${key} turned OFF`, text: `An admin turned off ${key}. Reason: ${reason}` } });
      }
    });
    this.rules.invalidate();
    return { ok: true, key, value: false, message: 'Turned off. Every server follows within about 15 seconds.' };
  }

  /** Audit search: everything that was done, newest first. */
  audit(who: AdminPrincipal, f: { actor?: string; entity?: string; entityId?: string; action?: string; from?: string; to?: string; limit: number; offset: number }) {
    const actor = f.actor ?? null;
    return this.dbs.sys(sql`
      select l.id, l.at, l.actor_type, l.actor_id, a.name as actor_name, l.action, l.entity, l.entity_id, l.before, l.after, l.ip, l.request_id
        from audit_log l left join admin_users a on a.id = l.actor_id
       where (${actor}::uuid is null or l.actor_id = ${actor}::uuid)
         and (${f.entity ?? null}::text is null or l.entity = ${f.entity ?? null}::text)
         and (${f.entityId ?? null}::text is null or l.entity_id = ${f.entityId ?? null}::text)
         and (${f.action ?? null}::text is null or l.action like ${f.action ?? null}::text || '%')
         and (${f.from ?? null}::date is null or l.at >= ${f.from ?? null}::date - interval '5 hours 30 minutes')
         and (${f.to ?? null}::date is null or l.at < ${f.to ?? null}::date + interval '18 hours 30 minutes')
       order by l.at desc limit ${f.limit} offset ${f.offset}`).then((r) => r.rows);
  }
}
