import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AppError } from '../../common/errors/app-error';
import { money } from '../../common/money';
import { enqueue, uuidv7 } from '../../common/outbox';
import { addDays, istDayLabel, istRange, istToday } from '../../common/time';
import { ENV, Env } from '../../config/env';
import { LiveBus } from '../../infra/bus/live-bus';
import { DbService, Tx } from '../../infra/db/db.service';
import { STORAGE, Storage } from '../../infra/storage/storage';
import { PasswordsService } from '../auth/passwords.service';
import { TokensService } from '../auth/tokens.service';
import { RulesService } from '../../infra/rules/rules.service';
import { BookingsService } from '../bookings/bookings.service';
import { DirectoryService } from '../directory/directory.service';
import { doctorLine, LiveService } from '../live/live.service';
import { lockSession, tokenLabel } from '../live/session-events';
import { ScheduleService, WeekInput } from '../schedule/schedule.service';

export interface DoctorIdentity {
  userId: string;
  doctorId: string;
}

const as = (d: DoctorIdentity) => ({ role: 'doctor' as const, userId: d.userId, doctorId: d.doctorId });

/** Everything the doctor's app does. Row-level security limits every query to the doctor's own rows. */
@Injectable()
export class DoctorService {
  constructor(
    private readonly dbs: DbService,
    private readonly dir: DirectoryService,
    private readonly schedule: ScheduleService,
    private readonly bookings: BookingsService,
    private readonly live: LiveService,
    private readonly passwords: PasswordsService,
    private readonly tokens: TokensService,
    private readonly rules: RulesService,
    private readonly bus: LiveBus,
    @Inject(STORAGE) private readonly storage: Storage,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async me(d: DoctorIdentity) {
    return this.dbs.as(as(d), async (tx) => {
      const doc = await tx
        .selectFrom('doctors as d')
        .innerJoin('doctorTypes as t', 't.id', 'd.typeId')
        .innerJoin('doctorCredentials as c', 'c.userId', 'd.userId')
        .select([
          'd.id', 'd.name', 'd.gender', 'd.typeId', 't.simpleName as typeName', 't.properName', 'd.degrees', 'd.regCouncil', 'd.regNo',
          'd.yearsExperience', 'd.languages', 'd.about', 'd.feePaise', 'd.photoKey', 'd.verification', 'd.verificationNote', 'd.status',
          'd.bookingsPaused', 'd.bookingsPausedAt', 'd.listedAt', 'c.loginId',
        ])
        .where('d.id', '=', d.doctorId)
        .executeTakeFirstOrThrow();
      const hasTimings = await tx.selectFrom('scheduleTemplates').select('id').where('doctorId', '=', d.doctorId).executeTakeFirst();
      const strength = [!!doc.photoKey, doc.about.trim().length >= 20, doc.languages.length > 0, doc.feePaise > 0, !!hasTimings].filter(Boolean).length * 20;
      const payout = await tx.selectFrom('payoutAccounts').select(['status', 'bankLast4']).where('doctorId', '=', d.doctorId).executeTakeFirst();
      return {
        ...doc,
        fee: money(doc.feePaise),
        share: money(doc.feePaise - Math.floor(doc.feePaise / 10)),
        photo: this.dir.photo(doc.photoKey),
        profileStrength: strength,
        live: doc.verification === 'verified' && doc.status === 'active',
        verificationMessage:
          doc.verification === 'verified' ? 'You are live on OPflow.'
          : doc.verification === 'needs_correction' ? 'Please contact the OPflow team about your profile.'
          : 'Verification in progress. You can set your timings meanwhile.',
        payout: payout ? { status: payout.status, bankLast4: payout.bankLast4 } : null,
        lockedNote: 'Name, degrees and registration are changed only by the OPflow team.',
      };
    });
  }

  /** Editable by the doctor: gender, years, languages, about, fee, photo. The database refuses anything else. */
  async update(d: DoctorIdentity, body: { gender?: 'female' | 'male' | 'other'; yearsExperience?: number; languages?: string[]; about?: string; feePaise?: number; photoUploadKey?: string | null }) {
    await this.dbs.as(as(d), async (tx) => {
      const set: Record<string, unknown> = {};
      if (body.gender) set.gender = body.gender;
      if (body.yearsExperience !== undefined) set.yearsExperience = body.yearsExperience;
      if (body.languages) set.languages = [...new Set(body.languages.map((l) => l.trim()).filter(Boolean))].slice(0, 8);
      if (body.about !== undefined) set.about = body.about.trim();
      if (body.feePaise !== undefined) set.feePaise = body.feePaise;
      if (body.photoUploadKey === null) set.photoKey = null;
      if (Object.keys(set).length) await tx.updateTable('doctors').set(set).where('id', '=', d.doctorId).execute();
      if (body.photoUploadKey) {
        if (!body.photoUploadKey.startsWith(`uploads/doctors/${d.doctorId}/`)) {
          throw new AppError('BAD_UPLOAD', 'Please upload the photo again.', HttpStatus.BAD_REQUEST);
        }
        await enqueue(tx, { topic: 'photo.process', payload: { doctorId: d.doctorId, uploadKey: body.photoUploadKey } });
      }
    });
    return this.me(d);
  }

  async photoUploadUrl(d: DoctorIdentity, contentType: string) {
    const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
    const key = `uploads/doctors/${d.doctorId}/${uuidv7()}.${ext}`;
    const put = await this.storage.presignPut('private', key, contentType, 300);
    return { key, url: put.url, headers: put.headers, method: 'PUT', maxBytes: this.env.UPLOAD_MAX_BYTES, expiresInSeconds: 300 };
  }

  /** "Pause bookings": no new bookings until resumed. Existing bookings stay. */
  async setPaused(d: DoctorIdentity, paused: boolean) {
    await this.dbs.as(as(d), (tx) =>
      tx.updateTable('doctors').set({ bookingsPaused: paused, bookingsPausedAt: paused ? new Date() : null }).where('id', '=', d.doctorId).execute(),
    );
    return { bookingsPaused: paused };
  }

  async hospitals(d: DoctorIdentity) {
    return this.dbs.as(as(d), (tx) =>
      tx
        .selectFrom('doctorHospitals as dh')
        .innerJoin('hospitals as h', 'h.id', 'dh.hospitalId')
        .select(['h.id', 'h.name', 'h.area', 'h.city', 'h.address', 'h.phone', 'h.hasEmergency', 'dh.isPrimary', 'dh.feePaiseOverride', 'dh.status'])
        .where('dh.doctorId', '=', d.doctorId)
        .orderBy('dh.isPrimary', 'desc')
        .execute(),
    );
  }

  /** Today: each OPD with its line, so the console opens in one call. */
  async today(d: DoctorIdentity, hospitalId?: string) {
    const today = istToday();
    const sessions = await this.dbs.db
      .selectFrom('opdSessions')
      .select('id')
      .where('doctorId', '=', d.doctorId)
      .where('date', '=', today)
      .where('status', '<>', 'cancelled')
      .$if(!!hospitalId, (q) => q.where('hospitalId', '=', hospitalId!))
      .orderBy('startsAt')
      .execute();
    const out = [];
    for (const s of sessions) {
      const { head, entries } = await this.live.load(undefined, s.id);
      out.push(doctorLine(head, entries));
    }
    const doc = await this.dbs.db.selectFrom('doctors').select(['bookingsPaused']).where('id', '=', d.doctorId).executeTakeFirstOrThrow();
    const em = await this.dbs.db.selectFrom('emergencyStatus').select(['status', 'untilAt', 'hospitalId', 'mode']).where('doctorId', '=', d.doctorId).executeTakeFirst();
    return { date: today, bookingsPaused: doc.bookingsPaused, emergency: em ?? { status: 'off', untilAt: null, hospitalId: null, mode: 'at_hospital' }, sessions: out };
  }

  /** Bookings on any day (the Bookings tab). */
  async bookingsOn(d: DoctorIdentity, date: string, hospitalId?: string, filter?: 'all' | 'upcoming' | 'cancelled') {
    return this.dbs.as(as(d), async (tx) => {
      const rows = await sql<{
        id: string; code: string; status: string; source: string; token: number; patientName: string; patientAge: number | null; patientGender: string | null;
        note: string; hospitalId: string; hospitalName: string; startsAt: Date; endsAt: Date; queueState: string | null; rescheduleCount: number;
        needsNewTimeSince: Date | null; feePaise: number; emergencyChargePaise: number; sessionId: string;
      }>`
        select b.id, b.code, b.status, b.source, b.token, b.patient_name, b.patient_age, b.patient_gender, b.note, b.hospital_id,
               h.name as hospital_name, coalesce(w.starts_at, s.starts_at) as starts_at, coalesce(w.ends_at, s.ends_at) as ends_at,
               q.state as queue_state, b.reschedule_count, b.needs_new_time_since, b.fee_paise, b.emergency_charge_paise, b.session_id
          from bookings b join hospitals h on h.id = b.hospital_id join opd_sessions s on s.id = b.session_id
          left join opd_windows w on w.id = b.window_id left join queue_entries q on q.booking_id = b.id
         where b.doctor_id = ${d.doctorId} and b.session_date = ${date}::date
           and b.status in ('confirmed', 'completed', 'no_show', 'cancelled_by_provider')
           and (${hospitalId ?? null}::uuid is null or b.hospital_id = ${hospitalId ?? null}::uuid)
           and (${filter ?? 'all'} = 'all'
                or (${filter ?? 'all'} = 'upcoming' and b.status = 'confirmed')
                or (${filter ?? 'all'} = 'cancelled' and b.status = 'cancelled_by_provider'))
         order by coalesce(w.starts_at, s.starts_at), case when b.source = 'emergency' then 0 else 1 end, b.token`.execute(tx);
      return {
        date,
        dayLabel: istDayLabel(date),
        items: rows.rows.map((b) => ({
          id: b.id,
          code: b.code,
          status: b.status,
          tokenLabel: tokenLabel(b.source, b.token),
          emergency: b.source === 'emergency',
          name: b.patientName,
          age: b.patientAge,
          gender: b.patientGender,
          note: b.note,
          hospital: { id: b.hospitalId, name: b.hospitalName },
          hour: istRange(new Date(b.startsAt), new Date(b.endsAt)),
          startsAt: b.startsAt,
          queueState: b.queueState,
          changed: b.rescheduleCount > 0,
          waitingForNewTime: b.needsNewTimeSince !== null && b.status === 'confirmed',
          fee: money(b.feePaise),
          sessionId: b.sessionId,
        })),
      };
    });
  }

  /** Per day: patients still coming (paid, not moved) and all bookings (not cancelled), at every hospital. */
  async bookingCounts(d: DoctorIdentity, from: string, days: number) {
    const to = addDays(from, days - 1);
    const rows = await this.dbs.as(as(d), async (tx) =>
      (
        await sql<{ date: string; coming: number; total: number }>`
          select b.session_date as date,
                 count(*) filter (where b.status = 'confirmed' and b.needs_new_time_since is null)::int as coming,
                 count(*) filter (where b.status <> 'cancelled_by_provider')::int as total
            from bookings b
           where b.doctor_id = ${d.doctorId} and b.session_date between ${from}::date and ${to}::date
             and b.status in ('confirmed', 'completed', 'no_show', 'cancelled_by_provider')
           group by b.session_date`.execute(tx)
      ).rows,
    );
    const by = new Map(rows.map((r) => [String(r.date), r]));
    return {
      from,
      days: Array.from({ length: days }, (_, i) => {
        const date = addDays(from, i);
        const r = by.get(date);
        return { date, coming: r?.coming ?? 0, total: r?.total ?? 0 };
      }),
    };
  }

  async booking(d: DoctorIdentity, id: string) {
    return this.dbs.as(as(d), async (tx) => {
      const b = await tx
        .selectFrom('bookings')
        .select(['id', 'code', 'status', 'source', 'token', 'patientName', 'patientAge', 'patientGender', 'note', 'sessionDate', 'sessionId', 'hospitalId', 'feePaise', 'emergencyChargePaise', 'rescheduleCount', 'cancelledReason'])
        .where('id', '=', id)
        .where('status', '<>', 'pending_payment')
        .where('status', '<>', 'expired')
        .executeTakeFirst();
      if (!b) throw new AppError('BOOKING_NOT_FOUND', 'We could not find this booking.', HttpStatus.NOT_FOUND);
      const events = await tx.selectFrom('bookingEvents').select(['type', 'at']).where('bookingId', '=', id).orderBy('at').execute();
      // When (the booked hour) and where the patient is in the line, so a booking opened from a message shows fully.
      const when = await sql<{ startsAt: Date | null; queueState: string | null; needsNewTimeSince: Date | null }>`
        select coalesce(w.starts_at, s.starts_at) as starts_at, q.state as queue_state, b.needs_new_time_since
          from bookings b join opd_sessions s on s.id = b.session_id
          left join opd_windows w on w.id = b.window_id left join queue_entries q on q.booking_id = b.id
         where b.id = ${id}`.execute(tx);
      const w = when.rows[0];
      return {
        ...b,
        bookingId: b.id,
        name: b.patientName,
        age: b.patientAge,
        gender: b.patientGender,
        emergency: b.source === 'emergency',
        startsAt: w?.startsAt ?? null,
        state: w?.queueState ?? null,
        waitingForNewTime: !!w?.needsNewTimeSince,
        changed: b.rescheduleCount > 0,
        tokenLabel: tokenLabel(b.source, b.token),
        fee: money(b.feePaise),
        events,
      };
    });
  }

  /** Doctor cancels one booking: the patient gets 100% of their money back. */
  async cancelBooking(d: DoctorIdentity, bookingId: string, reason: string) {
    const r = await this.dbs.as(as(d), async (tx) => {
      const b = await tx.selectFrom('bookings').select(['sessionId']).where('id', '=', bookingId).executeTakeFirst();
      if (!b) throw new AppError('BOOKING_NOT_FOUND', 'We could not find this booking.', HttpStatus.NOT_FOUND);
      await lockSession(tx, b.sessionId);
      const res = await this.bookings.cancelByProvider(tx, bookingId, { type: 'doctor', id: d.userId }, reason);
      if (!res) throw new AppError('BOOKING_CHANGED', 'This booking was already closed.', HttpStatus.CONFLICT);
      return res;
    });
    this.bus.publish(r);
    return { ok: true, refund: money(r.refundPaise) };
  }

  /** Doctor moves one booking: the patient picks a new time themselves (or gets money back after 48 h). */
  async moveBooking(d: DoctorIdentity, bookingId: string, reason: string) {
    const r = await this.dbs.as(as(d), async (tx) => {
      const b = await tx.selectFrom('bookings').select(['sessionId']).where('id', '=', bookingId).executeTakeFirst();
      if (!b) throw new AppError('BOOKING_NOT_FOUND', 'We could not find this booking.', HttpStatus.NOT_FOUND);
      await lockSession(tx, b.sessionId);
      const res = await this.bookings.moveByProvider(tx, bookingId, { type: 'doctor', id: d.userId }, reason);
      if (!res) throw new AppError('BOOKING_CHANGED', 'This booking cannot be moved now.', HttpStatus.CONFLICT);
      return res;
    });
    this.bus.publish(r);
    return { ok: true };
  }

  /**
   * "I can't come on this day": marks leave, stops new bookings, then cancels every booking with full money
   * back in the background (progress in /doctor/bulk/:id).
   */
  async cancelDay(d: DoctorIdentity, date: string, reason: string, hospitalId?: string) {
    if (date < istToday()) throw new AppError('PAST_DAY', 'This day is already over.', HttpStatus.UNPROCESSABLE_ENTITY);
    return this.dbs.as(as(d), async (tx) => {
      const sessions = await tx
        .selectFrom('opdSessions')
        .select(['id', 'status'])
        .where('doctorId', '=', d.doctorId)
        .where('date', '=', date)
        .where('status', 'in', ['scheduled', 'running', 'paused'])
        .$if(!!hospitalId, (q) => q.where('hospitalId', '=', hospitalId!))
        .execute();
      await tx
        .insertInto('doctorLeaves')
        .values({ doctorId: d.doctorId, hospitalId: hospitalId ?? null, date, reason: reason.slice(0, 120), createdBy: d.userId })
        .onConflict((oc) => oc.doNothing())
        .execute();
      const ops = [];
      let total = 0;
      let totalPaise = 0;
      for (const s of sessions) {
        await lockSession(tx, s.id);
        await tx.updateTable('opdWindows').set({ status: 'closed' }).where('sessionId', '=', s.id).execute();
        const live = await tx
          .selectFrom('bookings')
          .select(['id', 'feePaise', 'emergencyChargePaise'])
          .where('sessionId', '=', s.id)
          .where('status', '=', 'confirmed')
          .execute();
        const op = await tx
          .insertInto('bulkOperations')
          .values({ doctorId: d.doctorId, sessionId: s.id, kind: 'cancel_day', total: live.length, createdBy: d.userId, status: live.length ? 'running' : 'finished' })
          .returning('id')
          .executeTakeFirstOrThrow();
        for (const b of live) {
          await enqueue(tx, { topic: 'bulk.cancel', payload: { bulkId: op.id, bookingId: b.id, reason, actorId: d.userId } }, { dedupeKey: `bulk:${op.id}:${b.id}` });
          totalPaise += b.feePaise + b.emergencyChargePaise;
        }
        total += live.length;
        if (live.length === 0) await tx.updateTable('opdSessions').set({ status: 'cancelled' }).where('id', '=', s.id).execute();
        ops.push(op.id);
      }
      return { date, bulkIds: ops, bookings: total, refund: money(totalPaise), message: total ? `${total} patients will get all their money back.` : 'No bookings on this day.' };
    });
  }

  /** Worker: one booking of a bulk cancel (idempotent). */
  async runBulkCancel(bulkId: string, bookingId: string, reason: string, actorId: string | null): Promise<void> {
    let publish: { sessionId: string; version: number } | null = null;
    try {
      publish = await this.dbs.system(async (tx) => {
        const b = await tx.selectFrom('bookings').select(['sessionId']).where('id', '=', bookingId).executeTakeFirstOrThrow();
        await lockSession(tx, b.sessionId);
        const r = await this.bookings.cancelByProvider(tx, bookingId, { type: 'doctor', id: actorId }, reason);
        await this.bulkProgress(tx, bulkId, 'done');
        return r;
      });
    } catch (err) {
      await this.dbs.system((tx) => this.bulkProgress(tx, bulkId, 'failed'));
      throw err;
    }
    if (publish) this.bus.publish(publish);
  }

  private async bulkProgress(tx: Tx, bulkId: string, field: 'done' | 'failed'): Promise<void> {
    const r = await sql<{ done: number; failed: number; total: number; sessionId: string | null }>`
      update bulk_operations set ${sql.ref(field)} = ${sql.ref(field)} + 1 where id = ${bulkId}
      returning done, failed, total, session_id`.execute(tx);
    const op = r.rows[0];
    if (op && op.done + op.failed >= op.total) {
      await tx.updateTable('bulkOperations').set({ status: op.failed > 0 ? 'needs_attention' : 'finished' }).where('id', '=', bulkId).execute();
      if (op.sessionId && op.failed === 0) {
        await tx.updateTable('opdSessions').set({ status: 'cancelled' }).where('id', '=', op.sessionId).where('status', 'in', ['scheduled', 'running', 'paused']).execute();
      }
    }
  }

  async bulk(d: DoctorIdentity, bulkId: string) {
    const op = await this.dbs.db.selectFrom('bulkOperations').selectAll().where('id', '=', bulkId).where('doctorId', '=', d.doctorId).executeTakeFirst();
    if (!op) throw new AppError('NOT_FOUND', 'We could not find this.', HttpStatus.NOT_FOUND);
    return { ...op, message: `${op.done} of ${op.total} refunds started${op.failed ? `, ${op.failed} need the OPflow team` : ''}.` };
  }

  // ── Timings, leave, emergency ─────────────────────────────────────────────────────────────────────

  async week(d: DoctorIdentity, hospitalId: string) {
    return this.schedule.week(d.doctorId, hospitalId);
  }

  async saveWeek(d: DoctorIdentity, input: WeekInput) {
    const report = await this.dbs.as(as(d), (tx) => this.schedule.saveWeek(tx, d.doctorId, input), 30_000);
    return {
      week: await this.schedule.week(d.doctorId, input.hospitalId),
      report,
      message: report.keptWithBookings.length
        ? `Saved. ${report.keptWithBookings.length} earlier OPD${report.keptWithBookings.length === 1 ? '' : 's'} still ha${report.keptWithBookings.length === 1 ? 's' : 've'} booked patients. Please cancel or move them if you won't be there.`
        : 'Saved. Patients can book the new times now.',
    };
  }

  async leaves(d: DoctorIdentity) {
    return this.dbs.db
      .selectFrom('doctorLeaves')
      .select(['id', 'date', 'hospitalId', 'reason'])
      .where('doctorId', '=', d.doctorId)
      .where('date', '>=', istToday())
      .orderBy('date')
      .execute();
  }

  /** Replaces future leave days. Days with booked patients are refused here: use "cancel day" for those. */
  async setLeaves(d: DoctorIdentity, days: { date: string; hospitalId?: string | null; reason?: string }[]) {
    const today = istToday();
    const report = await this.dbs.as(as(d), async (tx) => {
      for (const day of days) {
        if (day.date < today || day.date > addDays(today, 180)) throw new AppError('BAD_DATE', 'Please pick a day in the next 6 months.', HttpStatus.UNPROCESSABLE_ENTITY);
        const booked = await tx
          .selectFrom('bookings')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('doctorId', '=', d.doctorId)
          .where('sessionDate', '=', day.date)
          .where('status', '=', 'confirmed')
          // Patients already asked to pick a new time are not on this day any more.
          .where('needsNewTimeSince', 'is', null)
          .$if(!!day.hospitalId, (q) => q.where('hospitalId', '=', day.hospitalId!))
          .executeTakeFirstOrThrow();
        const already = await tx.selectFrom('doctorLeaves').select('id').where('doctorId', '=', d.doctorId).where('date', '=', day.date).executeTakeFirst();
        if (Number(booked.n) > 0 && !already) {
          throw new AppError('DAY_HAS_BOOKINGS', `${istDayLabel(day.date)} has ${booked.n} booked patients. Please use "Cancel this day" so they get their money back.`, HttpStatus.CONFLICT, false, { date: day.date, bookings: Number(booked.n) });
        }
      }
      await tx.deleteFrom('doctorLeaves').where('doctorId', '=', d.doctorId).where('date', '>=', today).execute();
      if (days.length) {
        await tx
          .insertInto('doctorLeaves')
          .values(days.map((x) => ({ doctorId: d.doctorId, date: x.date, hospitalId: x.hospitalId ?? null, reason: x.reason?.slice(0, 120) ?? null, createdBy: d.userId })))
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
      return this.schedule.syncDoctor(tx, d.doctorId);
    }, 30_000);
    return { leaves: await this.leaves(d), report };
  }

  async emergency(d: DoctorIdentity) {
    const e = await this.dbs.db.selectFrom('emergencyStatus').select(['status', 'untilAt', 'hospitalId', 'mode', 'updatedAt']).where('doctorId', '=', d.doctorId).executeTakeFirst();
    return e ?? { status: 'off', untilAt: null, hospitalId: null, mode: 'at_hospital', updatedAt: null };
  }

  /** Emergency status: off · available now · available till <time>. (No "on call".) */
  async setEmergency(d: DoctorIdentity, body: { status: 'off' | 'available_now' | 'available_till'; untilAt?: string; hospitalId?: string; mode?: 'at_hospital' | 'phone_first' }) {
    if (body.status !== 'off') {
      if (!body.hospitalId) throw new AppError('INVALID_INPUT', 'Please choose the hospital.', HttpStatus.BAD_REQUEST);
      const link = await this.dbs.db.selectFrom('doctorHospitals').select('status').where('doctorId', '=', d.doctorId).where('hospitalId', '=', body.hospitalId).executeTakeFirst();
      if (link?.status !== 'active') throw new AppError('HOSPITAL_NOT_LINKED', 'This hospital is not on your profile.', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const until = body.status === 'available_till' ? new Date(body.untilAt ?? '') : null;
    if (body.status === 'available_till' && (!until || Number.isNaN(until.getTime()) || until.getTime() <= Date.now() || until.getTime() > Date.now() + 24 * 3_600_000)) {
      throw new AppError('INVALID_INPUT', 'Please choose a time in the next 24 hours.', HttpStatus.BAD_REQUEST);
    }
    const values = {
      status: body.status,
      untilAt: until,
      hospitalId: body.status === 'off' ? null : body.hospitalId!,
      mode: body.mode ?? 'at_hospital',
      updatedAt: new Date(),
    };
    await this.dbs.as(as(d), (tx) =>
      tx.insertInto('emergencyStatus').values({ doctorId: d.doctorId, ...values }).onConflict((oc) => oc.column('doctorId').doUpdateSet(values)).execute(),
    );
    return this.emergency(d);
  }

  // ── Money and reports ─────────────────────────────────────────────────────────────────────────────

  /** Earnings from transfers (what really reaches the bank), per day. */
  async earnings(d: DoctorIdentity, days: number) {
    const from = addDays(istToday(), -(days - 1));
    const rows = await this.dbs.sys(sql<{ date: string; patients: number; fee: number; platform: number; share: number; inBank: number; coming: number; back: number }>`
      select b.session_date as date, count(*)::int as patients,
             sum(b.fee_paise)::int as fee, sum(b.platform_fee_paise)::int as platform,
             sum(t.amount_paise)::int as share,
             -- In the bank = its payout reached the bank; coming = on hold, or in a payout still on its way.
             coalesce(sum(t.amount_paise) filter (where t.status = 'released' and po.status = 'success'), 0)::int as in_bank,
             coalesce(sum(t.amount_paise) filter (where t.status = 'on_hold' or (t.status = 'released' and po.status is distinct from 'success')), 0)::int as coming,
             coalesce(sum(t.amount_paise) filter (where t.status = 'reversed'), 0)::int as back
        from transfers t join payments p on p.id = t.payment_id join bookings b on b.id = p.booking_id
        left join payouts po on po.id = t.payout_id
       where t.doctor_id = ${d.doctorId} and b.session_date >= ${from}::date
       group by b.session_date order by b.session_date desc`);
    const sum = (k: 'share' | 'inBank' | 'coming' | 'back' | 'patients') => rows.rows.reduce((a, r) => a + r[k], 0);
    return {
      days,
      totals: { patients: sum('patients'), earned: money(sum('share') - sum('back')), inBank: money(sum('inBank')), coming: money(sum('coming')), moneyBackGiven: money(sum('back')) },
      rows: rows.rows.map((r) => ({
        date: r.date,
        dayLabel: istDayLabel(r.date),
        patients: r.patients,
        fees: money(r.fee),
        opflow: money(r.platform),
        yours: money(r.share),
        inBank: money(r.inBank),
        coming: money(r.coming),
        moneyBack: money(r.back),
      })),
    };
  }

  /** Bank payouts to this doctor (one per run, covering many visits), newest first. */
  async payouts(d: DoctorIdentity, limit = 30) {
    const rows = await this.dbs.sys(sql<{ id: string; amountPaise: number; visitsPaise: number; deductedPaise: number; status: string; utr: string | null; createdAt: Date; settledAt: Date | null; visits: number }>`
      select po.id, po.amount_paise, po.visits_paise, po.deducted_paise, po.status, po.utr, po.created_at, po.settled_at,
             (select count(*)::int from transfers t where t.payout_id = po.id) as visits
        from payouts po where po.doctor_id = ${d.doctorId} order by po.created_at desc limit ${limit}`);
    const acc = await this.dbs.sys(sql<{ bankLast4: string | null; status: string }>`select bank_last4, status from payout_accounts where doctor_id = ${d.doctorId}`);
    return {
      bank: acc.rows[0] ? { last4: acc.rows[0].bankLast4, active: acc.rows[0].status === 'active' } : null,
      items: rows.rows.map((r) => ({
        id: r.id,
        amount: money(r.amountPaise),
        visits: r.visits,
        deducted: r.deductedPaise ? money(r.deductedPaise) : null,
        // "failed" never reached the doctor: those visits are paid again in a later payout.
        status: r.status as 'pending' | 'success' | 'failed',
        bankReference: r.utr,
        createdAt: r.createdAt,
        settledAt: r.settledAt,
      })),
    };
  }

  async reports(d: DoctorIdentity, days: number) {
    const from = addDays(istToday(), -(days - 1));
    const r = await this.dbs.sys(sql<{ sessions: number; booked: number; seen: number; missed: number; cancelled: number; emergency: number; avgConsultSec: number | null }>`
      select (select count(*)::int from opd_sessions s where s.doctor_id = ${d.doctorId} and s.date >= ${from}::date and s.status = 'ended') as sessions,
             count(*) filter (where b.status in ('confirmed', 'completed', 'no_show'))::int as booked,
             count(*) filter (where b.status = 'completed')::int as seen,
             count(*) filter (where b.status = 'no_show')::int as missed,
             count(*) filter (where b.status = 'cancelled_by_provider')::int as cancelled,
             count(*) filter (where b.source = 'emergency' and b.status in ('confirmed', 'completed'))::int as emergency,
             (select avg(s.avg_consult_sec)::int from opd_sessions s where s.doctor_id = ${d.doctorId} and s.date >= ${from}::date and s.status = 'ended') as avg_consult_sec
        from bookings b where b.doctor_id = ${d.doctorId} and b.session_date >= ${from}::date`);
    const x = r.rows[0]!;
    return { days, ...x, avgConsultMinutes: x.avgConsultSec ? Math.round(x.avgConsultSec / 6) / 10 : null, showRate: x.booked ? Math.round((x.seen / x.booked) * 100) : null };
  }

  /** Devices this doctor account is signed in on (at most 2), newest first. */
  async devices(d: DoctorIdentity, currentSid: string) {
    const max = await this.rules.doctorMaxDevices();
    const maxWeb = await this.rules.doctorMaxWebDevices();
    const rows = await this.dbs.system((tx) => this.tokens.liveSessions(tx, d.userId, 'doctor'));
    return {
      max,
      maxWeb,
      items: rows.reverse().map((r) => ({
        id: r.familyId,
        thisDevice: r.familyId === currentSid,
        device: r.deviceLabel.replace(/^an? /, ''),
        platform: r.platform,
        appVersion: r.appVersion,
        signedInAt: r.startedAt,
        lastUsedAt: r.lastUsedAt,
      })),
    };
  }

  async signOutDevice(d: DoctorIdentity, familyId: string) {
    const r = await this.dbs.system(async (tx) => {
      const own = await tx.selectFrom('refreshTokens').select('familyId').where('familyId', '=', familyId).where('userId', '=', d.userId).where('role', '=', 'doctor').executeTakeFirst();
      if (!own) return false;
      await this.tokens.revokeFamily(tx, familyId);
      return true;
    });
    if (!r) throw new AppError('NOT_FOUND', 'We could not find this device.', HttpStatus.NOT_FOUND);
    return { ok: true, message: 'Signed out on that device.' };
  }

  /** Change password (logged in). Other phones are logged out. */
  async changePassword(d: DoctorIdentity, sid: string, current: string, next: string) {
    const cred = await this.dbs.db.selectFrom('doctorCredentials').select(['passwordHash', 'loginId']).where('userId', '=', d.userId).executeTakeFirstOrThrow();
    if (!(await this.passwords.verify(cred.passwordHash, current))) {
      throw new AppError('WRONG_PASSWORD', 'Your current password is not right.', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    this.passwords.checkStrength(next, { notSameAs: [cred.loginId] });
    if (current === next) throw new AppError('SAME_PASSWORD', 'Please choose a new password.', HttpStatus.UNPROCESSABLE_ENTITY);
    const hash = await this.passwords.hash(next);
    await this.dbs.system(async (tx) => {
      await tx.updateTable('doctorCredentials').set({ passwordHash: hash, passwordChangedAt: new Date(), mustChange: false }).where('userId', '=', d.userId).execute();
      await tx.updateTable('refreshTokens').set({ revokedAt: new Date() }).where('userId', '=', d.userId).where('familyId', '<>', sid).where('revokedAt', 'is', null).execute();
    });
    return { ok: true, message: 'Password changed. Other phones are logged out.' };
  }
}
