import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'kysely';
import sharp from 'sharp';

import { captureError } from '../../common/sentry';
import type { NotifyPayload, OutboxTopic } from '../../common/outbox';
import { uuidv7 } from '../../common/outbox';
import { istClock, istDayLabel, istToday } from '../../common/time';
import { ENV, Env } from '../../config/env';
import { LiveBus } from '../../infra/bus/live-bus';
import { DbService } from '../../infra/db/db.service';
import { EMAIL, EmailSender, PUSH, PushSender, SMS, SmsSender } from '../../infra/messaging/messaging';
import { RulesService } from '../../infra/rules/rules.service';
import { STORAGE, Storage } from '../../infra/storage/storage';
import { TokensService } from '../auth/tokens.service';
import { BookingsService } from '../bookings/bookings.service';
import { DoctorService } from '../doctor/doctor.service';
import { LiveService } from '../live/live.service';
import { lockSession } from '../live/session-events';
import { PaymentsService } from '../payments/payments.service';
import { ScheduleService } from '../schedule/schedule.service';

interface OutboxRow {
  id: string;
  topic: OutboxTopic;
  payload: unknown;
  attempts: number;
}

const MAX_ATTEMPTS = 10;

/**
 * The worker: delivers outbox rows and runs the timed jobs (ARCHITECTURE.md §6). Each timed job takes a
 * lease in `job_leases`, so with several worker machines each job still runs once at a time.
 * Works without Redis.
 */
@Injectable()
export class JobsService implements OnApplicationShutdown {
  private readonly log = new Logger('Worker');
  private timers: NodeJS.Timeout[] = [];
  private stopping = false;
  private relayBusy = false;

  constructor(
    private readonly dbs: DbService,
    private readonly rules: RulesService,
    private readonly bus: LiveBus,
    private readonly payments: PaymentsService,
    private readonly bookings: BookingsService,
    private readonly schedule: ScheduleService,
    private readonly live: LiveService,
    private readonly doctors: DoctorService,
    private readonly tokens: TokensService,
    @Inject(PUSH) private readonly push: PushSender,
    @Inject(EMAIL) private readonly email: EmailSender,
    @Inject(SMS) private readonly sms: SmsSender,
    @Inject(STORAGE) private readonly storage: Storage,
    @Inject(ENV) private readonly env: Env,
  ) {}

  start(): void {
    this.log.log('Background jobs started');
    this.every(this.env.OUTBOX_POLL_MS, () => this.relay());
    this.timed('holds.expire', this.env.HOLD_SWEEP_SECONDS, () => this.payments.expireHolds());
    this.timed('refunds.retry', 15 * 60, () => this.payments.retryDueRefunds());
    this.timed('payouts.release', 60 * 60, () => this.payments.releaseDueTransfers());
    this.timed('sessions.auto', 5 * 60, () => this.autoSessions());
    this.timed('emergency.expire', 5 * 60, () => this.expireEmergency());
    this.timed('moves.refund', 30 * 60, () => this.bookings.refundUnpickedMoves());
    this.timed('housekeeping', 60 * 60, () => this.housekeeping());
    this.timed('invariants.check', 6 * 60 * 60, () => this.invariants());
    this.daily('sessions.generate', '00:30', () => this.schedule.syncAll());
    this.daily('privacy.purge', '03:00', () => this.privacyPurge());
    // Right after start, make sure the next days exist (a fresh database, or a missed night).
    setTimeout(() => void this.runLeased('sessions.generate.boot', 6 * 3600, () => this.schedule.syncAll()), 3000).unref();
  }

  onApplicationShutdown(): void {
    this.stopping = true;
    for (const t of this.timers) clearInterval(t);
  }

  private every(ms: number, fn: () => Promise<unknown>): void {
    const t = setInterval(() => {
      if (!this.stopping) {
        void fn().catch((err: Error) => {
          this.log.error(`Job failed: ${err.message}`);
          captureError(err, { where: 'job' });
        });
      }
    }, ms);
    // Not unref'd: in the worker process these timers ARE the work, and must keep it running.
    this.timers.push(t);
  }

  /** Runs every N seconds on one machine at a time. */
  private timed(name: string, seconds: number, fn: () => Promise<unknown>): void {
    this.every(Math.min(seconds * 1000, 60_000), () => this.runLeased(name, seconds, fn));
  }

  /** Runs once a day at an Indian clock time (checked every minute; the lease stops repeats). */
  private daily(name: string, at: string, fn: () => Promise<unknown>): void {
    this.every(60_000, async () => {
      const now = new Date();
      const [h, m] = at.split(':').map(Number) as [number, number];
      const ist = new Date(now.getTime() + 330 * 60_000);
      if (ist.getUTCHours() * 60 + ist.getUTCMinutes() < h * 60 + m) return;
      const last = await this.dbs.db.selectFrom('jobLeases').select('lastFinishedAt').where('name', '=', name).executeTakeFirst();
      if (last?.lastFinishedAt && istToday(new Date(last.lastFinishedAt)) === istToday(now)) return;
      await this.runLeased(name, 3600, fn);
    });
  }

  /** Takes the lease if it's free and the job is due. Returns false when someone else has it. */
  async runLeased(name: string, everySeconds: number, fn: () => Promise<unknown>): Promise<boolean> {
    const lease = await this.dbs.sys(sql<{ name: string }>`
      insert into job_leases (name, locked_until, last_started_at) values (${name}, now() + interval '10 minutes', now())
      on conflict (name) do update set locked_until = now() + interval '10 minutes', last_started_at = now()
        where job_leases.locked_until < now()
          and (job_leases.last_finished_at is null or job_leases.last_finished_at < now() - make_interval(secs => ${everySeconds * 0.9}))
      returning name`);
    if (lease.rows.length === 0) return false;
    let error: string | null = null;
    try {
      const result = await fn();
      if (result && typeof result === 'object' && Object.values(result).some((v) => typeof v === 'number' && v > 0)) {
        this.log.log(`${name}: ${JSON.stringify(result)}`);
      }
    } catch (err) {
      error = (err as Error).message.slice(0, 500);
      this.log.error(`${name} failed: ${error}`);
    } finally {
      await this.dbs.sys(sql`update job_leases set locked_until = '-infinity', last_finished_at = now(), last_error = ${error} where name = ${name}`);
    }
    return true;
  }

  // ── Outbox ────────────────────────────────────────────────────────────────────────────────────────

  /** Claims due rows (SKIP LOCKED, so many workers never take the same row), delivers them, retries failures. */
  async relay(batch = 25): Promise<number> {
    if (this.relayBusy) return 0;
    this.relayBusy = true;
    try {
      let total = 0;
      for (;;) {
        const rows = await this.dbs.sys(sql<OutboxRow>`
          update outbox set available_at = now() + interval '2 minutes', attempts = attempts + 1
           where id in (select id from outbox where done_at is null and available_at <= now() and attempts < ${MAX_ATTEMPTS}
                         order by available_at, id limit ${batch} for update skip locked)
          returning id, topic, payload, attempts`);
        if (rows.rows.length === 0) return total;
        await Promise.all(
          rows.rows.map(async (row) => {
            try {
              await this.deliver(row);
              await this.dbs.sys(sql`update outbox set done_at = now(), last_error = null where id = ${row.id}`);
            } catch (err) {
              const wait = Math.min(3600, 5 * 2 ** row.attempts);
              // Retried with growing waits; reported once it has failed for good.
              if (row.attempts >= MAX_ATTEMPTS) captureError(err, { where: 'outbox', topic: row.topic });
              await this.dbs.sys(sql`update outbox set available_at = now() + make_interval(secs => ${wait}), last_error = ${(err as Error).message.slice(0, 500)}
                         where id = ${row.id}`);
              this.log.warn(`outbox ${row.topic} #${row.id} failed (try ${row.attempts}): ${(err as Error).message}`);
            }
          }),
        );
        total += rows.rows.length;
        if (rows.rows.length < batch) return total;
      }
    } finally {
      this.relayBusy = false;
    }
  }

  private async deliver(row: OutboxRow): Promise<void> {
    const p = row.payload as Record<string, unknown>;
    switch (row.topic) {
      case 'notify':
        return this.deliverNotify(p as unknown as NotifyPayload);
      case 'refund.start':
        return this.payments.runRefund(String(p.refundId));
      case 'transfer.reverse':
        return this.payments.runTransferReversal(String(p.transferId));
      case 'live.publish': {
        const s = await this.dbs.db.selectFrom('opdSessions').select(['version']).where('id', '=', String(p.sessionId)).executeTakeFirst();
        if (s) this.bus.publish({ sessionId: String(p.sessionId), version: s.version });
        return;
      }
      case 'turn.check':
        return this.live.turnCheck(String(p.sessionId));
      case 'photo.process':
        return this.processPhoto(String(p.doctorId), String(p.uploadKey));
      case 'bulk.cancel':
        return this.doctors.runBulkCancel(String(p.bulkId), String(p.bookingId), String(p.reason), (p.actorId as string | null) ?? null);
      case 'reminder':
        return this.reminder(String(p.bookingId), (p.windowId as string | null) ?? null, p.which as 'day' | 'hour');
      case 'email':
        return this.email.send(String(p.to), String(p.subject), String(p.text));
      case 'sms':
        return this.sms.send(String(p.to), p.variables as Record<string, string>, String(p.text));
      default:
        this.log.warn(`Unknown outbox topic ${row.topic as string}; marking done`);
    }
  }

  /** In-app message (once per dedupe key) + phone push, respecting the person's settings. */
  private async deliverNotify(n: NotifyPayload): Promise<void> {
    const inserted = await this.dbs.system((tx) =>
      tx
        .insertInto('notifications')
        .values({ userId: n.userId, kind: n.kind, title: n.title.slice(0, 120), body: n.body.slice(0, 500), bookingId: n.bookingId ?? null, data: JSON.stringify(n.data ?? {}), dedupeKey: n.dedupeKey ?? null })
        .onConflict((oc) => oc.columns(['userId', 'dedupeKey']).doNothing())
        .returning('id')
        .executeTakeFirst(),
    );
    if (!inserted || n.push === false) return;
    const prefs = await this.dbs.db.selectFrom('notificationPrefs').selectAll().where('userId', '=', n.userId).executeTakeFirst();
    if (prefs) {
      if (n.kind === 'reminder' && !prefs.reminders) return;
      if (n.kind === 'late' && !prefs.lateAlerts) return;
      if (n.kind === 'turn' && !prefs.turnAlerts) return;
    }
    const devices = await this.dbs.system((tx) => tx.selectFrom('devices').select(['fcmToken']).where('userId', '=', n.userId).where('fcmToken', 'is not', null).execute());
    const tokens = devices.map((d) => d.fcmToken!).filter(Boolean);
    if (!tokens.length) return;
    const r = await this.push.send(tokens, {
      title: n.title,
      body: n.body,
      data: { kind: n.kind, notificationId: inserted.id, ...(n.bookingId ? { bookingId: n.bookingId } : {}), ...(n.data ?? {}) },
    });
    if (r.deadTokens.length) await this.dbs.system((tx) => tx.updateTable('devices').set({ fcmToken: null }).where('fcmToken', 'in', r.deadTokens).execute());
  }

  private async reminder(bookingId: string, windowId: string | null, which: 'day' | 'hour'): Promise<void> {
    const b = await this.dbs.sys(sql<{ patientUserId: string; status: string; windowId: string | null; token: number; doctorName: string; hospitalName: string; startsAt: Date; date: string; needsNewTimeSince: Date | null }>`
      select b.patient_user_id, b.status, b.window_id, b.token, d.name as doctor_name, h.name as hospital_name, w.starts_at, b.session_date as date, b.needs_new_time_since
        from bookings b join doctors d on d.id = b.doctor_id join hospitals h on h.id = b.hospital_id join opd_windows w on w.id = b.window_id
       where b.id = ${bookingId}`);
    const r = b.rows[0];
    // Skip if the booking changed since the reminder was planned.
    if (!r || r.status !== 'confirmed' || r.windowId !== windowId || r.needsNewTimeSince) return;
    await this.deliverNotify({
      userId: r.patientUserId,
      kind: 'reminder',
      title: which === 'day' ? 'Your visit is tomorrow' : 'Your visit is in 1 hour',
      body: `${r.doctorName} at ${r.hospitalName}, ${istDayLabel(r.date)} at ${istClock(new Date(r.startsAt))}. Token ${String(r.token).padStart(2, '0')}.`,
      bookingId,
      dedupeKey: `reminder:${bookingId}:${windowId}:${which}`,
    });
  }

  /** Doctor photo: 3 WebP sizes, EXIF (and so any location) removed. Rejects files that are not images or too big. */
  private async processPhoto(doctorId: string, uploadKey: string): Promise<void> {
    const original = await this.storage.get('private', uploadKey);
    if (original.length > this.env.UPLOAD_MAX_BYTES) {
      this.log.warn(`Photo for doctor ${doctorId} is too big (${original.length} bytes); ignored`);
      return;
    }
    let meta;
    try {
      meta = await sharp(original).metadata();
    } catch {
      this.log.warn(`Photo for doctor ${doctorId} is not an image; ignored`);
      return;
    }
    if (!meta.width || !meta.height || meta.width * meta.height > 50_000_000) return;
    const base = `doctors/${doctorId}/${uuidv7()}`;
    for (const [size, px] of [['s', 96], ['m', 320], ['l', 800]] as const) {
      const out = await sharp(original).rotate().resize(px, Math.round(px * 1.25), { fit: 'cover', position: 'attention' }).webp({ quality: 82 }).toBuffer();
      await this.storage.put('public', `${base}-${size}.webp`, out, 'image/webp');
    }
    await this.dbs.system((tx) => tx.updateTable('doctors').set({ photoKey: base }).where('id', '=', doctorId).execute());
  }

  // ── Timed jobs ────────────────────────────────────────────────────────────────────────────────────

  /**
   * OPDs left open: 60 min after an hour ends, people who never came are "did not come" (the doctor can
   * put them back). 3 hours after the OPD's end it is closed; if it never started, everyone gets a full
   * refund (the doctor did not sit).
   */
  async autoSessions(): Promise<{ markedNotCome: number; ended: number; neverStarted: number }> {
    const noShowMin = await this.rules.noShowAfterMinutes();
    const marked = await this.dbs.sys(sql`
      update queue_entries q set state = 'did_not_come'
        from bookings b join opd_windows w on w.id = b.window_id join opd_sessions s on s.id = b.session_id
       where q.booking_id = b.id and q.state = 'not_come' and s.status in ('running', 'paused')
         and w.ends_at < now() - make_interval(mins => ${noShowMin})`);
    const stale = await this.dbs.db
      .selectFrom('opdSessions')
      .select(['id', 'status'])
      .where('status', 'in', ['scheduled', 'running', 'paused'])
      .where('endsAt', '<', new Date(Date.now() - 3 * 3_600_000))
      .limit(50)
      .execute();
    let ended = 0;
    let neverStarted = 0;
    for (const s of stale) {
      const publishes: { sessionId: string; version: number }[] = [];
      await this.dbs.system(async (tx) => {
        const locked = await lockSession(tx, s.id);
        if (!['scheduled', 'running', 'paused'].includes(locked.status)) return;
        if (locked.status === 'scheduled') {
          const live = await tx.selectFrom('bookings').select('id').where('sessionId', '=', s.id).where('status', '=', 'confirmed').execute();
          for (const b of live) {
            const r = await this.bookings.cancelByProvider(tx, b.id, { type: 'system', id: null }, 'The doctor did not hold this OPD');
            if (r) publishes.push(r);
          }
          await tx.updateTable('opdSessions').set({ status: 'cancelled' }).where('id', '=', s.id).execute();
          await tx.updateTable('opdWindows').set({ status: 'closed' }).where('sessionId', '=', s.id).execute();
          neverStarted++;
        } else {
          await tx.updateTable('queueEntries').set({ state: 'did_not_come' }).where('sessionId', '=', s.id).where('state', '=', 'not_come').execute();
          await this.live.endSession(tx, locked, 'move', { type: 'system', id: null }, 'The OPD was closed automatically', publishes);
          ended++;
        }
      }, 60_000);
      for (const p of publishes) this.bus.publish(p);
    }
    return { markedNotCome: Number(marked.numAffectedRows ?? 0), ended, neverStarted };
  }

  async expireEmergency(): Promise<number> {
    const r = await this.dbs.system((tx) =>
      tx
        .updateTable('emergencyStatus')
        .set({ status: 'off', untilAt: null, hospitalId: null })
        .where('status', '=', 'available_till')
        .where('untilAt', '<', new Date())
        .executeTakeFirst(),
    );
    return Number(r.numUpdatedRows);
  }

  async housekeeping() {
    const keys = await this.dbs.sys(sql`delete from idempotency_keys where created_at < now() - interval '24 hours'`);
    const outbox = await this.dbs.sys(sql`delete from outbox where done_at < now() - interval '14 days'`);
    const setup = await this.dbs.sys(sql`delete from admin_setup_tokens where expires_at < now() - interval '7 days'`);
    const tokens = await this.tokens.purge();
    // Rows that grow with every patient, kept only as long as they are useful:
    // messages 90 days (the app shows the latest 50), live-line events 30 days, login codes 1 day, and the
    // phone records made at each login once they have no push token and no login for 60 days.
    const messages = await this.dbs.sys(sql`delete from notifications where created_at < now() - interval '90 days'`);
    const events = await this.dbs.sys(sql`delete from queue_events where at < now() - interval '31 days'`);
    const codes = await this.dbs.sys(sql`delete from phone_otps where created_at < now() - interval '1 day'`);
    const devices = await this.dbs.sys(sql`delete from devices d where d.fcm_token is null and d.last_seen_at < now() - interval '60 days'
                                              and not exists (select 1 from refresh_tokens r where r.device_id = d.id and r.revoked_at is null)`);
    return {
      idempotencyKeys: Number(keys.numAffectedRows ?? 0),
      outbox: Number(outbox.numAffectedRows ?? 0),
      setupLinks: Number(setup.numAffectedRows ?? 0),
      refreshTokens: tokens,
      messages: Number(messages.numAffectedRows ?? 0),
      lineEvents: Number(events.numAffectedRows ?? 0),
      loginCodes: Number(codes.numAffectedRows ?? 0),
      devices: Number(devices.numAffectedRows ?? 0),
    };
  }

  /** Deleted accounts: anything left that could identify them (devices, notifications) after 30 days. */
  async privacyPurge() {
    const n = await this.dbs.sys(sql`delete from notifications where user_id in (select id from users where status = 'deleted' and deleted_at < now() - interval '30 days')`);
    return { notifications: Number(n.numAffectedRows ?? 0) };
  }

  /**
   * Consistency guards (§10): things that must never happen. Any failure emails the admins and shows in
   * "Needs attention" via the audit log.
   */
  async invariants() {
    const checks: Record<string, string> = {
      two_places_one_booking: `select count(*)::int as n from (select booking_id from window_slots where booking_id is not null group by booking_id having count(*) > 1) x`,
      confirmed_online_without_booked_slot: `select count(*)::int as n from bookings b where b.status = 'confirmed' and b.source = 'online'
          and not exists (select 1 from window_slots s where s.booking_id = b.id and s.state = 'booked')`,
      paid_but_not_confirmed_or_refunded: `select count(*)::int as n from payments p join bookings b on b.id = p.booking_id where p.status = 'captured'
          and b.status in ('pending_payment', 'expired') and not exists (select 1 from refunds r where r.payment_id = p.id)`,
      overbooked_windows: `select count(*)::int as n from opd_windows w where (select count(*) from window_slots s where s.window_id = w.id and s.state in ('held', 'booked')) > 20`,
      refunds_over_payment: `select count(*)::int as n from payments p where (select coalesce(sum(amount_paise), 0) from refunds r where r.payment_id = p.id and r.status <> 'failed') > p.amount_paise`,
      two_with_doctor: `select count(*)::int as n from (select session_id from queue_entries where state = 'with_doctor' group by session_id having count(*) > 1) x`,
      held_slot_of_finished_booking: `select count(*)::int as n from window_slots s join bookings b on b.id = s.booking_id where s.state = 'held' and b.status <> 'pending_payment'`,
    };
    const failed: Record<string, number> = {};
    for (const [name, q] of Object.entries(checks)) {
      const r = await this.dbs.sys(sql<{ n: number }>`${sql.raw(q)}`);
      const n = r.rows[0]?.n ?? 0;
      if (n > 0) failed[name] = n;
    }
    if (Object.keys(failed).length) {
      this.log.error(`Invariant check FAILED: ${JSON.stringify(failed)}`);
      await this.dbs.system(async (tx) => {
        await tx.insertInto('auditLog').values({ actorType: 'system', action: 'invariants.failed', entity: 'system', after: JSON.stringify(failed) }).execute();
        if (this.env.ADMIN_ALERT_EMAIL) {
          await tx.insertInto('outbox').values({ topic: 'email', payload: JSON.stringify({ to: this.env.ADMIN_ALERT_EMAIL, subject: 'OPflow: consistency check failed', text: JSON.stringify(failed, null, 2) }) }).execute();
        }
      });
    }
    return { failed: Object.keys(failed).length, details: failed };
  }
}
