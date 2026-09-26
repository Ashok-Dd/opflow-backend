import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { bookingCode } from '../../common/crypto';
import { AppError } from '../../common/errors/app-error';
import { isUniqueViolation, pgError } from '../../common/errors/pg-errors';
import { emergencyCharge, money, platformFee } from '../../common/money';
import { enqueue, notify, uuidv7 } from '../../common/outbox';
import { istDayLabel, istRange, istToday } from '../../common/time';
import { LiveBus } from '../../infra/bus/live-bus';
import type { ActorType } from '../../infra/db/schema';
import { DbService, Tx } from '../../infra/db/db.service';
import { PAYMENT_GATEWAY, PaymentGateway } from '../../infra/payments/gateway';
import { RulesService } from '../../infra/rules/rules.service';
import { DirectoryService } from '../directory/directory.service';
import { bumpSession, lockSession, lockSessions, orderKeyFor } from '../live/session-events';
import { PaymentsService } from '../payments/payments.service';
import { ChangeRules, loadBookings, patientView, whyNoChange } from './booking-views';

const notFound = () => new AppError('BOOKING_NOT_FOUND', 'We could not find this booking.', HttpStatus.NOT_FOUND);
const windowFull = () => new AppError('WINDOW_FULL', 'This time just got full. Please pick another.', HttpStatus.CONFLICT);
const alreadyBooked = () =>
  new AppError('ALREADY_BOOKED', 'You already have a booking with this doctor on this day.', HttpStatus.CONFLICT);

export interface Actor {
  type: ActorType;
  id: string | null;
}

/**
 * Patient bookings: hold a place → pay → confirmed (PaymentsService.confirm). Change date/time once.
 * No patient cancel (money rule): only the doctor or OPflow can cancel, always with 100% money back.
 */
@Injectable()
export class BookingsService {
  constructor(
    private readonly dbs: DbService,
    private readonly rules: RulesService,
    private readonly dir: DirectoryService,
    private readonly payments: PaymentsService,
    private readonly bus: LiveBus,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  async changeRules(): Promise<ChangeRules> {
    return { cutoffMinutes: await this.rules.rescheduleCutoffMinutes(), maxChanges: await this.rules.rescheduleMax() };
  }

  private async patientSnapshot(tx: Tx, userId: string) {
    const p = await tx.selectFrom('patientProfiles').select(['name', 'birthYear', 'gender']).where('userId', '=', userId).executeTakeFirst();
    if (!p) throw new AppError('PROFILE_NEEDED', 'Please add your name and age first.', HttpStatus.UNPROCESSABLE_ENTITY);
    return { name: p.name, age: Math.max(0, Math.min(120, new Date().getFullYear() - p.birthYear)), gender: p.gender };
  }

  private async checkOpenHolds(tx: Tx, userId: string) {
    const max = await this.rules.maxOpenHolds();
    const open = await tx
      .selectFrom('bookings')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('patientUserId', '=', userId)
      .where('status', '=', 'pending_payment')
      .where('holdExpiresAt', '>', new Date())
      .executeTakeFirstOrThrow();
    if (Number(open.n) >= max) {
      throw new AppError('TOO_MANY_HOLDS', 'Please finish paying for your other booking first.', HttpStatus.CONFLICT);
    }
  }

  /** Step 1 of booking: keep one place for 10 minutes and open a Razorpay order for the fee. */
  async hold(userId: string, input: { windowId: string; note?: string }, idempotencyKey?: string) {
    await this.rules.requireBookingsOn();
    const holdMinutes = await this.rules.holdMinutes();
    const feePercent = await this.rules.platformFeePercent();
    let held: { bookingId: string; amount: number; code: string; holdExpiresAt: Date };
    try {
      held = await this.dbs.as({ role: 'patient', userId }, async (tx) => {
        const patient = await this.patientSnapshot(tx, userId);
        const w = await sql<{
          id: string; startsAt: Date; status: string; sessionId: string; sessionStatus: string; date: string; closeMinutesBefore: number;
          doctorId: string; hospitalId: string; feePaise: number; feeOverride: number | null; bookingsPaused: boolean;
          verification: string; doctorStatus: string; linkStatus: string | null; hospitalStatus: string;
        }>`
          select w.id, w.starts_at, w.status, s.id as session_id, s.status as session_status, s.date, s.close_minutes_before,
                 s.doctor_id, s.hospital_id, d.fee_paise, dh.fee_paise_override as fee_override, d.bookings_paused,
                 d.verification, d.status as doctor_status, dh.status as link_status, h.status as hospital_status
            from opd_windows w
            join opd_sessions s on s.id = w.session_id
            join doctors d on d.id = s.doctor_id
            join hospitals h on h.id = s.hospital_id
            left join doctor_hospitals dh on dh.doctor_id = s.doctor_id and dh.hospital_id = s.hospital_id
           where w.id = ${input.windowId}`.execute(tx);
        const win = w.rows[0];
        if (!win || win.verification !== 'verified' || win.doctorStatus !== 'active' || win.linkStatus !== 'active' || win.hospitalStatus !== 'active') {
          throw new AppError('WINDOW_NOT_FOUND', 'This time is not available any more. Please pick another.', HttpStatus.NOT_FOUND);
        }
        if (win.bookingsPaused) {
          throw new AppError('BOOKINGS_PAUSED', 'The doctor is not taking new bookings right now. Please try later or pick another doctor.', HttpStatus.CONFLICT);
        }
        const closesAt = new Date(win.startsAt).getTime() - win.closeMinutesBefore * 60_000;
        if (win.status !== 'open' || !['scheduled', 'running', 'paused'].includes(win.sessionStatus) || closesAt <= Date.now()) {
          throw new AppError('WINDOW_CLOSED', 'Booking for this time has closed. Please pick another time.', HttpStatus.CONFLICT);
        }
        await this.checkOpenHolds(tx, userId);
        const same = await tx
          .selectFrom('bookings')
          .select('id')
          .where('patientUserId', '=', userId)
          .where('doctorId', '=', win.doctorId)
          .where('sessionDate', '=', win.date)
          .where('source', '=', 'online')
          .where('status', 'in', ['pending_payment', 'confirmed'])
          .executeTakeFirst();
        if (same) throw alreadyBooked();

        const bookingId = uuidv7();
        const holdExpiresAt = new Date(Date.now() + holdMinutes * 60_000);
        // The lowest free place in this hour. SKIP LOCKED: 40 people tapping at once each get a different place, or "full".
        const slot = await sql<{ token: number }>`
          update window_slots set state = 'held', booking_id = ${bookingId}, held_until = ${holdExpiresAt}, version = version + 1
           where (window_id, token) = (select window_id, token from window_slots
                                        where window_id = ${win.id} and state = 'free'
                                        order by token limit 1 for update skip locked)
          returning token`.execute(tx);
        const token = slot.rows[0]?.token;
        if (token === undefined) throw windowFull();

        const fee = win.feeOverride ?? win.feePaise;
        const code = bookingCode();
        await tx
          .insertInto('bookings')
          .values({
            id: bookingId,
            code,
            patientUserId: userId,
            patientName: patient.name,
            patientAge: patient.age,
            patientGender: patient.gender,
            doctorId: win.doctorId,
            hospitalId: win.hospitalId,
            sessionId: win.sessionId,
            sessionDate: win.date,
            windowId: win.id,
            source: 'online',
            token,
            status: 'pending_payment',
            holdExpiresAt,
            feePaise: fee,
            platformFeePaise: platformFee(fee, feePercent),
            note: (input.note ?? '').slice(0, 140),
            idempotencyKey: idempotencyKey ?? null,
          })
          .execute();
        await tx.insertInto('bookingEvents').values({ bookingId, type: 'held', actorType: 'patient', actorId: userId, data: JSON.stringify({ token }) }).execute();
        return { bookingId, amount: fee, code, holdExpiresAt };
      }, 3000);
    } catch (err) {
      if (isUniqueViolation(err, 'bookings_one_per_doctor_day')) throw alreadyBooked();
      throw err;
    }
    return this.openOrder(userId, held);
  }

  /** Emergency consultation: fee + emergency charge, E-token, top of the line. */
  async holdEmergency(userId: string, doctorId: string, idempotencyKey?: string) {
    await this.rules.requireEmergencyConsultOn();
    const holdMinutes = await this.rules.holdMinutes();
    const feePercent = await this.rules.platformFeePercent();
    const chargePercent = await this.rules.emergencyChargePercent();
    let held: { bookingId: string; amount: number; code: string; holdExpiresAt: Date };
    try {
      held = await this.dbs.as({ role: 'patient', userId }, async (tx) => {
        const patient = await this.patientSnapshot(tx, userId);
        const d = await sql<{ feePaise: number; verification: string; status: string; emStatus: string | null; untilAt: Date | null; hospitalId: string | null; feeOverride: number | null; linkStatus: string | null }>`
          select d.fee_paise, d.verification, d.status, es.status as em_status, es.until_at, es.hospital_id,
                 dh.fee_paise_override as fee_override, dh.status as link_status
            from doctors d
            left join emergency_status es on es.doctor_id = d.id
            left join doctor_hospitals dh on dh.doctor_id = d.id and dh.hospital_id = es.hospital_id
           where d.id = ${doctorId}`.execute(tx);
        const doc = d.rows[0];
        const available =
          doc && doc.verification === 'verified' && doc.status === 'active' && doc.hospitalId && doc.linkStatus === 'active' &&
          (doc.emStatus === 'available_now' || (doc.emStatus === 'available_till' && doc.untilAt && new Date(doc.untilAt).getTime() > Date.now()));
        if (!doc || !available || !doc.hospitalId) {
          throw new AppError('EMERGENCY_NOT_AVAILABLE', 'This doctor is not taking emergency patients right now. Please pick another doctor or call 108.', HttpStatus.CONFLICT);
        }
        await this.checkOpenHolds(tx, userId);
        const sessionId = await this.emergencySession(tx, doctorId, doc.hospitalId, doc.untilAt);
        const session = await lockSession(tx, sessionId);
        const t = await sql<{ token: number }>`
          update opd_sessions set next_emergency_token = next_emergency_token + 1 where id = ${sessionId} returning next_emergency_token - 1 as token`.execute(tx);
        const token = t.rows[0]!.token;
        const fee = doc.feeOverride ?? doc.feePaise;
        const charge = Math.max(100, emergencyCharge(fee, chargePercent));
        const bookingId = uuidv7();
        const holdExpiresAt = new Date(Date.now() + holdMinutes * 60_000);
        const code = bookingCode();
        await tx
          .insertInto('bookings')
          .values({
            id: bookingId,
            code,
            patientUserId: userId,
            patientName: patient.name,
            patientAge: patient.age,
            patientGender: patient.gender,
            doctorId,
            hospitalId: doc.hospitalId,
            sessionId,
            sessionDate: session.date,
            windowId: null,
            source: 'emergency',
            token,
            status: 'pending_payment',
            holdExpiresAt,
            feePaise: fee,
            platformFeePaise: platformFee(fee, feePercent),
            emergencyChargePaise: charge,
            idempotencyKey: idempotencyKey ?? null,
          })
          .execute();
        await tx.insertInto('bookingEvents').values({ bookingId, type: 'held', actorType: 'patient', actorId: userId, data: JSON.stringify({ token, emergency: true }) }).execute();
        return { bookingId, amount: fee + charge, code, holdExpiresAt };
      }, 3000);
    } catch (err) {
      if (isUniqueViolation(err, 'bookings_one_emergency_per_doctor_day')) {
        throw new AppError('ALREADY_BOOKED', 'You already have an emergency consultation with this doctor today.', HttpStatus.CONFLICT);
      }
      if (pgError(err)?.code === '23P01') {
        throw new AppError('EMERGENCY_NOT_AVAILABLE', 'This doctor is not taking emergency patients right now. Please pick another doctor or call 108.', HttpStatus.CONFLICT);
      }
      throw err;
    }
    return this.openOrder(userId, held);
  }

  /** Today's open session at the emergency hospital, or a short one made just for emergencies. */
  private async emergencySession(tx: Tx, doctorId: string, hospitalId: string, untilAt: Date | null): Promise<string> {
    const today = istToday();
    const open = await tx
      .selectFrom('opdSessions')
      .select('id')
      .where('doctorId', '=', doctorId)
      .where('hospitalId', '=', hospitalId)
      .where('date', '=', today)
      .where((eb) =>
        eb.or([
          eb('status', 'in', ['running', 'paused']),
          eb.and([eb('status', '=', 'scheduled'), eb('endsAt', '>', new Date()), eb('startsAt', '<=', new Date(Date.now() + 3_600_000))]),
        ]),
      )
      .orderBy('startsAt')
      .executeTakeFirst();
    if (open) return open.id;
    const start = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    const endOfDay = new Date(Date.parse(`${today}T18:29:00Z`)); // 23:59 IST
    const next = await tx
      .selectFrom('opdSessions')
      .select('startsAt')
      .where('doctorId', '=', doctorId)
      .where('status', '<>', 'cancelled')
      .where('startsAt', '>', start)
      .orderBy('startsAt')
      .executeTakeFirst();
    const end = new Date(
      Math.min(
        Math.max(untilAt ? new Date(untilAt).getTime() : 0, start.getTime() + 2 * 3_600_000),
        endOfDay.getTime(),
        next ? new Date(next.startsAt).getTime() : Infinity,
      ),
    );
    if (end.getTime() <= start.getTime() + 10 * 60_000) {
      throw new AppError('EMERGENCY_NOT_AVAILABLE', 'This doctor is not taking emergency patients right now. Please pick another doctor or call 108.', HttpStatus.CONFLICT);
    }
    // Made by the system (sessions have no row security; the doctor's own emergency switch allows it).
    const row = await tx
      .insertInto('opdSessions')
      .values({ doctorId, hospitalId, date: today, startsAt: start, endsAt: end, closeMinutesBefore: 0 })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** Creates the Razorpay order for a held booking. If Razorpay is down, the place is released at once. */
  private async openOrder(userId: string, held: { bookingId: string; amount: number; code: string; holdExpiresAt: Date }) {
    let orderId: string;
    try {
      const order = await this.gateway.createOrder({ amountPaise: held.amount, receipt: held.code, notes: { bookingId: held.bookingId } });
      orderId = order.id;
      await this.dbs.as({ role: 'patient', userId }, (tx) =>
        tx.insertInto('payments').values({ bookingId: held.bookingId, razorpayOrderId: order.id, amountPaise: held.amount }).execute(),
      );
    } catch (err) {
      await this.releaseHold(held.bookingId).catch(() => undefined);
      throw err;
    }
    const booking = await this.get(userId, held.bookingId);
    return { booking, payment: this.payments.checkout(orderId, held.amount), holdExpiresAt: held.holdExpiresAt };
  }

  private async releaseHold(bookingId: string): Promise<void> {
    await this.dbs.system(async (tx) => {
      const b = await tx.selectFrom('bookings').select(['id', 'status']).where('id', '=', bookingId).forUpdate().executeTakeFirst();
      if (b?.status !== 'pending_payment') return;
      await tx.updateTable('bookings').set({ status: 'expired' }).where('id', '=', bookingId).execute();
      await sql`update window_slots set state = 'free', booking_id = null, held_until = null, version = version + 1
                 where booking_id = ${bookingId} and state = 'held'`.execute(tx);
      await tx.insertInto('bookingEvents').values({ bookingId, type: 'expired', actorType: 'system', data: JSON.stringify({ why: 'payments_unavailable' }) }).execute();
    });
  }

  async list(userId: string, tab: 'upcoming' | 'past', offset: number, limit: number) {
    const rules = await this.changeRules();
    const rows = await this.dbs.as({ role: 'patient', userId }, (tx) => loadBookings(tx, { patientUserId: userId, tab, limit: limit + 1, offset }));
    return { items: rows.slice(0, limit).map((b) => patientView(b, this.dir, rules)), hasMore: rows.length > limit };
  }

  async get(userId: string, bookingId: string) {
    const rules = await this.changeRules();
    const rows = await this.dbs.as({ role: 'patient', userId }, (tx) => loadBookings(tx, { ids: [bookingId] }));
    const b = rows[0];
    if (!b) throw notFound();
    return patientView(b, this.dir, rules);
  }

  /** Timeline for the booking page ("Booked · Paid · Changed · Money back…"), newest last. */
  async timeline(userId: string, bookingId: string) {
    return this.dbs.as({ role: 'patient', userId }, async (tx) => {
      const b = await tx.selectFrom('bookings').select('id').where('id', '=', bookingId).executeTakeFirst();
      if (!b) throw notFound();
      return tx.selectFrom('bookingEvents').select(['type', 'at', 'data']).where('bookingId', '=', bookingId).orderBy('at').orderBy('id').execute();
    });
  }

  /** Change date or time: once, up to 2 hours before (or freely, when the doctor moved them). No money moves. */
  async reschedule(userId: string, bookingId: string, newWindowId: string) {
    const rules = await this.changeRules();
    const publish: { sessionId: string; version: number }[] = [];
    try {
      // As the system (the move also rewrites the live line, slots and payouts), for the patient's own booking only.
      await this.dbs.system(async (tx) => {
        const pre = await tx.selectFrom('bookings').select(['sessionId']).where('id', '=', bookingId).where('patientUserId', '=', userId).executeTakeFirst();
        if (!pre) throw notFound();
        const target = await sql<{ id: string; sessionId: string; startsAt: Date; status: string; sessionStatus: string; date: string; doctorId: string; hospitalId: string; closeMinutesBefore: number; linkStatus: string | null }>`
          select w.id, w.session_id, w.starts_at, w.status, s.status as session_status, s.date, s.doctor_id, s.hospital_id,
                 s.close_minutes_before, dh.status as link_status
            from opd_windows w join opd_sessions s on s.id = w.session_id
            left join doctor_hospitals dh on dh.doctor_id = s.doctor_id and dh.hospital_id = s.hospital_id
           where w.id = ${newWindowId}`.execute(tx);
        const nw = target.rows[0];
        if (!nw) throw new AppError('WINDOW_NOT_FOUND', 'This time is not available any more. Please pick another.', HttpStatus.NOT_FOUND);
        await lockSessions(tx, [pre.sessionId, nw.sessionId]);
        const rows = await loadBookings(tx, { ids: [bookingId] });
        const b = rows[0];
        if (!b) throw notFound();
        await tx.selectFrom('bookings').select('id').where('id', '=', bookingId).forUpdate().execute();
        const why = whyNoChange(b, rules);
        if (why) throw new AppError('RESCHEDULE_NOT_ALLOWED', why, HttpStatus.UNPROCESSABLE_ENTITY);
        if (nw.doctorId !== b.doctorId || nw.linkStatus !== 'active') {
          throw new AppError('RESCHEDULE_NOT_ALLOWED', 'You can change only to another time with the same doctor.', HttpStatus.UNPROCESSABLE_ENTITY);
        }
        if (nw.id === b.windowId) throw new AppError('RESCHEDULE_NOT_ALLOWED', 'This is already your time.', HttpStatus.UNPROCESSABLE_ENTITY);
        const closesAt = new Date(nw.startsAt).getTime() - nw.closeMinutesBefore * 60_000;
        if (nw.status !== 'open' || !['scheduled', 'running', 'paused'].includes(nw.sessionStatus) || closesAt <= Date.now()) {
          throw new AppError('WINDOW_CLOSED', 'Booking for this time has closed. Please pick another time.', HttpStatus.CONFLICT);
        }

        // Free the old place first (a booking holds exactly one place), then take the new one. If the new time is
        // full, the error rolls the whole change back, so the old place is never lost.
        await sql`update window_slots set state = 'free', booking_id = null, held_until = null, version = version + 1
                   where window_id = ${b.windowId} and booking_id = ${bookingId} and state = 'booked'`.execute(tx);
        const slot = await sql<{ token: number }>`
          update window_slots set state = 'held', booking_id = ${bookingId}, held_until = now() + interval '1 minute', version = version + 1
           where (window_id, token) = (select window_id, token from window_slots
                                        where window_id = ${nw.id} and state = 'free' order by token limit 1 for update skip locked)
          returning token`.execute(tx);
        const token = slot.rows[0]?.token;
        if (token === undefined) throw windowFull();
        await sql`update window_slots set state = 'booked', held_until = null where window_id = ${nw.id} and token = ${token}`.execute(tx);

        const providerMove = b.needsNewTimeSince !== null;
        await tx
          .updateTable('bookings')
          .set({
            sessionId: nw.sessionId,
            sessionDate: nw.date,
            windowId: nw.id,
            hospitalId: nw.hospitalId,
            token,
            rescheduleCount: providerMove ? b.rescheduleCount : b.rescheduleCount + 1,
            rescheduledAt: new Date(),
            needsNewTimeSince: null,
          })
          .where('id', '=', bookingId)
          .execute();
        await tx.deleteFrom('queueEntries').where('bookingId', '=', bookingId).execute();
        await tx.insertInto('queueEntries').values({ bookingId, sessionId: nw.sessionId, orderKey: orderKeyFor('online', token), state: 'not_come' }).execute();
        const newSession = await tx.selectFrom('opdSessions').select('endsAt').where('id', '=', nw.sessionId).executeTakeFirstOrThrow();
        const holdHours = await this.rules.payoutHoldHours();
        await sql`update transfers t set release_at = ${new Date(new Date(newSession.endsAt).getTime() + holdHours * 3_600_000)}
                    from payments p where p.id = t.payment_id and p.booking_id = ${bookingId} and t.status = 'on_hold'`.execute(tx);
        await tx
          .insertInto('bookingEvents')
          .values({ bookingId, type: 'rescheduled', actorType: 'patient', actorId: userId, data: JSON.stringify({ from: { windowId: b.windowId, token: b.token }, to: { windowId: nw.id, token }, providerMove }) })
          .execute();
        publish.push({ sessionId: b.sessionId, version: await bumpSession(tx, b.sessionId, 'moved_out', { bookingId, actorId: userId }) });
        if (nw.sessionId !== b.sessionId) publish.push({ sessionId: nw.sessionId, version: await bumpSession(tx, nw.sessionId, 'moved_in', { bookingId, actorId: userId }) });
        const when = await tx.selectFrom('opdWindows').select(['startsAt', 'endsAt']).where('id', '=', nw.id).executeTakeFirstOrThrow();
        await notify(tx, {
          userId,
          kind: 'changed',
          title: 'Booking changed',
          body: `Your new time is ${istDayLabel(nw.date)}, ${istRange(new Date(when.startsAt), new Date(when.endsAt))}. Token ${String(token).padStart(2, '0')}.`,
          bookingId,
          dedupeKey: `changed:${bookingId}:${nw.id}`,
        });
        // The doctor sees the change too (their line for both days changed).
        const doc = await sql<{ userId: string; patientName: string }>`
          select d.user_id, b.patient_name from bookings b join doctors d on d.id = b.doctor_id where b.id = ${bookingId}`.execute(tx);
        if (doc.rows[0]?.userId) {
          await notify(tx, {
            userId: doc.rows[0].userId,
            kind: 'changed',
            title: providerMove ? 'Patient picked a new time' : 'Patient changed the time',
            body: `${doc.rows[0].patientName} is now on ${istDayLabel(nw.date)}, ${istRange(new Date(when.startsAt), new Date(when.endsAt))}. Token ${String(token).padStart(2, '0')}.`,
            bookingId,
            data: { forDoctor: 'true' },
            pref: 'bookingChanges',
            dedupeKey: `changed-doctor:${bookingId}:${nw.id}`,
          });
        }
        for (const [which, before] of [['day', 24 * 3_600_000], ['hour', 3_600_000]] as const) {
          const at = new Date(when.startsAt).getTime() - before;
          if (at > Date.now() + 5 * 60_000) {
            await enqueue(tx, { topic: 'reminder', payload: { bookingId, windowId: nw.id, which } }, { dedupeKey: `reminder:${bookingId}:${nw.id}:${which}`, availableAt: new Date(at) });
          }
        }
      }, 3000);
    } catch (err) {
      if (isUniqueViolation(err, 'bookings_one_per_doctor_day')) throw alreadyBooked();
      throw err;
    }
    for (const p of publish) this.bus.publish(p);
    return this.get(userId, bookingId);
  }

  /** A simple receipt (the app renders it; the same text can be emailed). */
  async receipt(userId: string, bookingId: string) {
    const b = await this.get(userId, bookingId);
    if (!b.payment || b.payment.status !== 'captured') throw new AppError('NO_RECEIPT', 'A receipt is made after payment.', HttpStatus.UNPROCESSABLE_ENTITY);
    return {
      code: b.code,
      patient: b.patient.name,
      doctor: b.doctor.name,
      hospital: b.hospital.name,
      date: b.date,
      time: b.time.label,
      token: b.tokenLabel,
      lines: [
        { label: 'Doctor fee', amount: b.fee },
        ...(b.emergency ? [{ label: 'Emergency charge', amount: b.emergencyCharge }] : []),
      ],
      total: b.total,
      paidWith: b.payment.method,
      refunds: b.refunds,
    };
  }

  // ── Cancellation by the doctor or OPflow (always 100% money back) ─────────────────────────────────

  /**
   * One booking, inside the caller's transaction (doctor, admin or the bulk worker). The caller has already
   * locked the session (lockSession) — lock order: session → booking → slot → payment.
   */
  async cancelByProvider(tx: Tx, bookingId: string, actor: Actor, reason: string): Promise<{ sessionId: string; version: number; refundPaise: number } | null> {
    const b = await tx
      .selectFrom('bookings')
      .select(['id', 'status', 'sessionId', 'windowId', 'patientUserId', 'code', 'doctorId'])
      .where('id', '=', bookingId)
      .forUpdate()
      .executeTakeFirst();
    if (!b) throw notFound();
    if (b.status !== 'confirmed') return null; // already cancelled/done: nothing to do (safe to repeat)
    const q = await tx.selectFrom('queueEntries').select('state').where('bookingId', '=', bookingId).executeTakeFirst();
    if (q?.state === 'done') throw new AppError('ALREADY_SEEN', 'This patient was already seen.', HttpStatus.CONFLICT);

    await tx
      .updateTable('bookings')
      .set({ status: 'cancelled_by_provider', cancelledAt: new Date(), cancelledBy: actor.id, cancelledReason: reason.slice(0, 120), needsNewTimeSince: null })
      .where('id', '=', bookingId)
      .execute();
    if (b.windowId) {
      await sql`update window_slots set state = 'free', booking_id = null, held_until = null, version = version + 1
                 where booking_id = ${bookingId} and state = 'booked'`.execute(tx);
    }
    if (q && ['not_come', 'waiting', 'with_doctor'].includes(q.state)) {
      await tx.updateTable('queueEntries').set({ state: 'cancelled' }).where('bookingId', '=', bookingId).execute();
    }
    let refundPaise = 0;
    const paid = await tx.selectFrom('payments').select(['id', 'amountPaise']).where('bookingId', '=', bookingId).where('status', '=', 'captured').execute();
    for (const p of paid) {
      const already = await tx
        .selectFrom('refunds')
        .select((eb) => eb.fn.coalesce(eb.fn.sum<number>('amountPaise'), eb.lit(0)).as('sum'))
        .where('paymentId', '=', p.id)
        .where('status', '<>', 'failed')
        .executeTakeFirstOrThrow();
      const left = p.amountPaise - Number(already.sum);
      if (left > 0) {
        await this.payments.createRefund(tx, { paymentId: p.id, amountPaise: left, reason: 'provider_cancelled', byType: actor.type, by: actor.id, bookingId, patientUserId: b.patientUserId });
        refundPaise += left;
      }
      const t = await tx.selectFrom('transfers').select(['id', 'status']).where('paymentId', '=', p.id).forUpdate().executeTakeFirst();
      if (t && (t.status === 'on_hold' || t.status === 'released')) {
        await tx.updateTable('transfers').set({ status: 'reversed', reversedAt: new Date() }).where('id', '=', t.id).execute();
        if (t.status === 'released') await enqueue(tx, { topic: 'transfer.reverse', payload: { transferId: t.id } }, { dedupeKey: `reverse:${t.id}` });
      }
    }
    await tx
      .insertInto('bookingEvents')
      .values({ bookingId, type: 'cancelled_by_provider', actorType: actor.type, actorId: actor.id, data: JSON.stringify({ reason, refundPaise }) })
      .execute();
    if (b.patientUserId) {
      await notify(tx, {
        userId: b.patientUserId,
        kind: 'cancelled',
        title: 'Booking cancelled by the doctor',
        body: `Sorry, your booking ${b.code} was cancelled${reason ? ` (${reason})` : ''}. All your money (${money(refundPaise).display}) is coming back.`,
        bookingId,
        dedupeKey: `cancelled:${bookingId}`,
      });
    }
    const version = await bumpSession(tx, b.sessionId, 'cancelled', { bookingId, actorId: actor.id, data: { reason } });
    return { sessionId: b.sessionId, version, refundPaise };
  }

  /** "Move them to another day": booking stays paid; the patient picks any new time (or gets money back after 48 h). */
  async moveByProvider(tx: Tx, bookingId: string, actor: Actor, reason: string): Promise<{ sessionId: string; version: number } | null> {
    const b = await tx.selectFrom('bookings').select(['id', 'status', 'sessionId', 'windowId', 'patientUserId', 'code', 'source']).where('id', '=', bookingId).forUpdate().executeTakeFirst();
    if (!b) throw notFound();
    if (b.status !== 'confirmed') return null;
    if (b.source === 'emergency') return this.cancelByProvider(tx, bookingId, actor, reason);
    const q = await tx.selectFrom('queueEntries').select('state').where('bookingId', '=', bookingId).executeTakeFirst();
    if (q && !['not_come', 'waiting'].includes(q.state)) return null;
    await tx.updateTable('bookings').set({ needsNewTimeSince: new Date() }).where('id', '=', bookingId).execute();
    if (q) await tx.updateTable('queueEntries').set({ state: 'moved' }).where('bookingId', '=', bookingId).execute();
    // The old place stays theirs (so its token can't be given to someone else) until they pick a new time
    // (reschedule frees it) or get their money back (cancel frees it).
    await tx.insertInto('bookingEvents').values({ bookingId, type: 'moved_by_provider', actorType: actor.type, actorId: actor.id, data: JSON.stringify({ reason }) }).execute();
    const pickHours = await this.rules.movePickHours();
    if (b.patientUserId) {
      await notify(tx, {
        userId: b.patientUserId,
        kind: 'changed',
        title: 'Please pick a new time',
        body: `The doctor could not see you (${reason || 'change of plan'}). Please pick any new time for booking ${b.code}. If you don't pick within ${pickHours} hours, all your money comes back.`,
        bookingId,
        dedupeKey: `moved:${bookingId}:${Date.now()}`,
      });
    }
    const version = await bumpSession(tx, b.sessionId, 'moved', { bookingId, actorId: actor.id });
    return { sessionId: b.sessionId, version };
  }

  /** Job: moved bookings not re-booked within 48 h get all their money back. */
  async refundUnpickedMoves(): Promise<number> {
    const hours = await this.rules.movePickHours();
    const due = await this.dbs.system((tx) =>
      tx
        .selectFrom('bookings')
        .select(['id', 'sessionId'])
        .where('status', '=', 'confirmed')
        .where('needsNewTimeSince', '<', new Date(Date.now() - hours * 3_600_000))
        .limit(100)
        .execute(),
    );
    let n = 0;
    for (const b of due) {
      const r = await this.dbs.system(async (tx) => {
        await lockSession(tx, b.sessionId);
        return this.cancelByProvider(tx, b.id, { type: 'system', id: null }, 'No new time was picked');
      });
      if (r) {
        n++;
        this.bus.publish(r);
      }
    }
    return n;
  }
}
