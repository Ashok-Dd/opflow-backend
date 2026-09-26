import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';

import { AppError } from '../../common/errors/app-error';
import { money } from '../../common/money';
import { enqueue, notify } from '../../common/outbox';
import { istDayLabel, istRange } from '../../common/time';
import { ENV, Env } from '../../config/env';
import { LiveBus } from '../../infra/bus/live-bus';
import type { ActorType, RefundReason } from '../../infra/db/schema';
import { DbService, Tx } from '../../infra/db/db.service';
import { GatewayPayment, PAYMENT_GATEWAY, PaymentGateway } from '../../infra/payments/gateway';
import { RulesService } from '../../infra/rules/rules.service';
import { bumpSession, lockSession, orderKeyFor, tokenLabel } from '../live/session-events';

export type ConfirmOutcome = 'confirmed' | 'already' | 'refunded_duplicate' | 'refunded_late';

interface BookingForConfirm {
  id: string;
  status: string;
  source: 'online' | 'emergency' | 'direct';
  token: number;
  windowId: string | null;
  sessionId: string;
  sessionDate: string;
  doctorId: string;
  patientUserId: string | null;
  feePaise: number;
  platformFeePaise: number;
  code: string;
}

/**
 * Money in and out: confirming paid bookings, refunds, doctor payouts (Razorpay Route) and webhooks.
 * Amounts always come from the database, never from the phone; the database also refuses a payment that
 * isn't exactly fee + emergency charge, or a doctor transfer that isn't exactly 90% of the fee.
 */
@Injectable()
export class PaymentsService {
  private readonly log = new Logger(PaymentsService.name);

  constructor(
    private readonly dbs: DbService,
    private readonly rules: RulesService,
    private readonly bus: LiveBus,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** After Checkout: check the signature and the payment itself with Razorpay, then confirm. */
  async verify(patientUserId: string, input: { orderId: string; paymentId: string; signature: string }) {
    const row = await this.dbs.as({ role: 'patient', userId: patientUserId }, (tx) =>
      tx
        .selectFrom('payments as p')
        .innerJoin('bookings as b', 'b.id', 'p.bookingId')
        .select(['p.id', 'p.amountPaise', 'p.bookingId', 'p.status'])
        .where('p.razorpayOrderId', '=', input.orderId)
        .executeTakeFirst(),
    );
    if (!row) throw new AppError('PAYMENT_NOT_FOUND', 'We could not find this payment. If money was taken, it will come back automatically.', HttpStatus.NOT_FOUND);
    if (!this.gateway.verifyPaymentSignature(input.orderId, input.paymentId, input.signature)) {
      throw new AppError('PAYMENT_NOT_VERIFIED', 'We could not confirm this payment. If money was taken, it will come back automatically.', HttpStatus.BAD_REQUEST);
    }
    const gp = await this.gateway.fetchPayment(input.paymentId);
    if (gp.orderId !== input.orderId || gp.amount !== row.amountPaise) {
      this.log.error(`Payment ${input.paymentId} does not match order ${input.orderId} (amount ${gp.amount} vs ${row.amountPaise})`);
      throw new AppError('PAYMENT_NOT_VERIFIED', 'We could not confirm this payment. If money was taken, it will come back automatically.', HttpStatus.BAD_REQUEST);
    }
    if (gp.status === 'authorized' || gp.status === 'created') {
      return { bookingId: row.bookingId, outcome: 'processing' as const };
    }
    if (gp.status === 'failed') {
      await this.dbs.system((tx) => tx.updateTable('payments').set({ failureReason: gp.error ?? 'failed' }).where('id', '=', row.id).where('status', '=', 'created').execute());
      throw new AppError('PAYMENT_FAILED', 'The payment did not go through. No money was taken. Please try again.', HttpStatus.PAYMENT_REQUIRED);
    }
    const outcome = await this.confirm(row.id, gp, 'patient');
    return { bookingId: row.bookingId, outcome };
  }

  /**
   * "Was I charged?" for the patient's own booking: when the phone is unsure (Checkout said failed or cancelled,
   * the confirm call timed out, UPI still processing), this asks Razorpay directly and confirms a captured
   * payment through the same single path as the webhook. Never charges and never cancels anything.
   */
  async checkStatus(patientUserId: string, bookingId: string): Promise<{ status: string; paid: boolean }> {
    const booking = await this.dbs.as({ role: 'patient', userId: patientUserId }, (tx) =>
      tx.selectFrom('bookings').select(['id', 'status']).where('id', '=', bookingId).where('patientUserId', '=', patientUserId).executeTakeFirst(),
    );
    if (!booking) throw new AppError('BOOKING_NOT_FOUND', 'We could not find this booking.', HttpStatus.NOT_FOUND);
    if (booking.status === 'pending_payment' || booking.status === 'expired') {
      const orders = await this.dbs.system((tx) =>
        tx.selectFrom('payments').select(['id', 'razorpayOrderId']).where('bookingId', '=', bookingId).where('status', 'in', ['created', 'authorized']).execute(),
      );
      for (const o of orders) {
        const captured = (await this.gateway.fetchOrderPayments(o.razorpayOrderId).catch(() => [])).find((p) => p.status === 'captured');
        if (captured) {
          await this.confirm(o.id, captured, 'patient');
          break;
        }
      }
    }
    const now = await this.dbs.system((tx) => tx.selectFrom('bookings').select('status').where('id', '=', bookingId).executeTakeFirstOrThrow());
    const paid = await this.dbs.system((tx) =>
      tx.selectFrom('payments').select('id').where('bookingId', '=', bookingId).where('status', '=', 'captured').executeTakeFirst(),
    );
    return { status: now.status, paid: !!paid };
  }

  /**
   * THE place a paid booking becomes confirmed. Called by verify, the webhook and the hold sweeper,
   * possibly at the same moment: the locks and the "already captured" check make it happen exactly once.
   */
  async confirm(paymentRowId: string, gp: GatewayPayment, via: 'patient' | 'webhook' | 'sweeper'): Promise<ConfirmOutcome> {
    const publish: { sessionId: string; version: number }[] = [];
    const outcome = await this.dbs.system(async (tx) => {
      const pre = await tx
        .selectFrom('payments as p')
        .innerJoin('bookings as b', 'b.id', 'p.bookingId')
        .select(['b.sessionId'])
        .where('p.id', '=', paymentRowId)
        .executeTakeFirstOrThrow();
      const session = await lockSession(tx, pre.sessionId);
      const pay = await tx.selectFrom('payments').selectAll().where('id', '=', paymentRowId).forUpdate().executeTakeFirstOrThrow();
      const booking = (await tx
        .selectFrom('bookings')
        .select(['id', 'status', 'source', 'token', 'windowId', 'sessionId', 'sessionDate', 'doctorId', 'patientUserId', 'feePaise', 'platformFeePaise', 'code'])
        .where('id', '=', pay.bookingId)
        .forUpdate()
        .executeTakeFirstOrThrow()) as BookingForConfirm;

      if (pay.status === 'captured') return 'already' as const;
      if (gp.amount !== pay.amountPaise) throw new Error(`Amount mismatch on payment ${pay.id}: ${gp.amount} vs ${pay.amountPaise}`);
      await tx
        .updateTable('payments')
        .set({ status: 'captured', razorpayPaymentId: gp.id, method: gp.method, raw: JSON.stringify({ via, status: gp.status, method: gp.method }) })
        .where('id', '=', pay.id)
        .execute();

      const otherCaptured = await tx
        .selectFrom('payments')
        .select('id')
        .where('bookingId', '=', booking.id)
        .where('id', '<>', pay.id)
        .where('status', '=', 'captured')
        .executeTakeFirst();
      if (otherCaptured || ['confirmed', 'completed', 'no_show', 'cancelled_by_provider'].includes(booking.status)) {
        // Paid twice (two tabs, a retry that also went through): give this one back in full.
        await this.createRefund(tx, { paymentId: pay.id, amountPaise: pay.amountPaise, reason: 'duplicate', byType: 'system', by: null, bookingId: booking.id, patientUserId: booking.patientUserId });
        return 'refunded_duplicate' as const;
      }

      // The doctor was suspended or the OPD cancelled while the patient was paying: all money back.
      const doctor = await tx.selectFrom('doctors').select('status').where('id', '=', booking.doctorId).executeTakeFirstOrThrow();
      if (doctor.status !== 'active' || session.status === 'cancelled' || session.status === 'ended') {
        if (booking.status === 'pending_payment') await this.releaseSlotAndExpire(tx, booking.id);
        return this.refundLate(tx, booking, pay.id, pay.amountPaise);
      }

      let token = booking.token;
      if (booking.status === 'pending_payment') {
        if (booking.source === 'online') {
          const took = await sql`
            update window_slots set state = 'booked', held_until = null, version = version + 1
             where window_id = ${booking.windowId} and token = ${booking.token} and booking_id = ${booking.id} and state = 'held'`.execute(tx);
          if (Number(took.numAffectedRows ?? 0) !== 1) {
            const retaken = await this.retake(tx, booking);
            if (retaken === null) return this.refundLate(tx, booking, pay.id, pay.amountPaise);
            token = retaken;
          }
        }
      } else if (booking.status === 'expired') {
        // Paid after the hold ended: keep the same place if it's still free, else any place in that hour.
        const sameDay = await tx
          .selectFrom('bookings')
          .select('id')
          .where('patientUserId', '=', booking.patientUserId)
          .where('doctorId', '=', booking.doctorId)
          .where('sessionDate', '=', booking.sessionDate)
          .where('source', '=', booking.source)
          .where('status', 'in', ['pending_payment', 'confirmed'])
          .where('id', '<>', booking.id)
          .executeTakeFirst();
        if (sameDay || !['scheduled', 'running', 'paused'].includes(session.status)) return this.refundLate(tx, booking, pay.id, pay.amountPaise);
        if (booking.source === 'online') {
          const retaken = await this.retake(tx, booking);
          if (retaken === null) return this.refundLate(tx, booking, pay.id, pay.amountPaise);
          token = retaken;
        }
      } else {
        return this.refundLate(tx, booking, pay.id, pay.amountPaise);
      }

      // Confirm.
      await tx
        .updateTable('bookings')
        .set({ status: 'confirmed', confirmedAt: new Date(), token })
        .where('id', '=', booking.id)
        .execute();
      const holdHours = await this.rules.payoutHoldHours();
      await tx
        .insertInto('transfers')
        .values({
          paymentId: pay.id,
          doctorId: booking.doctorId,
          amountPaise: booking.feePaise - booking.platformFeePaise,
          releaseAt: new Date(new Date(session.endsAt).getTime() + holdHours * 3_600_000),
        })
        .execute();
      await tx
        .insertInto('queueEntries')
        .values({ bookingId: booking.id, sessionId: booking.sessionId, orderKey: orderKeyFor(booking.source, token), state: 'not_come' })
        .onConflict((oc) => oc.column('bookingId').doNothing())
        .execute();
      await tx
        .insertInto('bookingEvents')
        .values({ bookingId: booking.id, type: 'confirmed', actorType: via === 'patient' ? 'patient' : 'system', actorId: via === 'patient' ? booking.patientUserId : null, data: JSON.stringify({ via, token, paymentId: gp.id }) })
        .execute();
      const version = await bumpSession(tx, booking.sessionId, booking.source === 'emergency' ? 'emergency_booked' : 'booked', { bookingId: booking.id });
      publish.push({ sessionId: booking.sessionId, version });

      await this.afterConfirmMessages(tx, booking.id);
      return 'confirmed' as const;
    });
    for (const p of publish) this.bus.publish(p);
    return outcome;
  }

  private async releaseSlotAndExpire(tx: Tx, bookingId: string): Promise<void> {
    await tx.updateTable('bookings').set({ status: 'expired' }).where('id', '=', bookingId).execute();
    await sql`update window_slots set state = 'free', booking_id = null, held_until = null, version = version + 1
               where booking_id = ${bookingId} and state = 'held'`.execute(tx);
  }

  /** Try the same token again, else any free place in the same hour. Returns the token, or null. */
  private async retake(tx: Tx, b: BookingForConfirm): Promise<number | null> {
    const window = await tx.selectFrom('opdWindows').select(['status', 'endsAt']).where('id', '=', b.windowId!).executeTakeFirst();
    if (!window || window.status !== 'open' || new Date(window.endsAt).getTime() <= Date.now()) return null;
    const same = await sql`
      update window_slots set state = 'held', booking_id = ${b.id}, held_until = now() + interval '1 minute', version = version + 1
       where window_id = ${b.windowId} and token = ${b.token} and state = 'free'`.execute(tx);
    let token = b.token;
    if (Number(same.numAffectedRows ?? 0) !== 1) {
      const other = await sql<{ token: number }>`
        update window_slots set state = 'held', booking_id = ${b.id}, held_until = now() + interval '1 minute', version = version + 1
         where (window_id, token) = (select window_id, token from window_slots
                                      where window_id = ${b.windowId} and state = 'free' order by token limit 1 for update skip locked)
        returning token`.execute(tx);
      if (!other.rows[0]) return null;
      token = other.rows[0].token;
    }
    await sql`update window_slots set state = 'booked', held_until = null where window_id = ${b.windowId} and token = ${token} and booking_id = ${b.id}`.execute(tx);
    return token;
  }

  private async refundLate(tx: Tx, b: BookingForConfirm, paymentId: string, amountPaise: number): Promise<ConfirmOutcome> {
    await this.createRefund(tx, { paymentId, amountPaise, reason: 'late_payment', byType: 'system', by: null, bookingId: b.id, patientUserId: b.patientUserId });
    return 'refunded_late';
  }

  /** "Booked" message + reminders (1 day and 1 hour before), all through the outbox. */
  private async afterConfirmMessages(tx: Tx, bookingId: string): Promise<void> {
    const b = await sql<{ patientUserId: string; code: string; source: string; token: number; windowId: string | null; doctorName: string; doctorUserId: string; patientName: string; hospitalName: string; date: string; startsAt: Date; endsAt: Date; total: number }>`
      select b.patient_user_id, b.code, b.source, b.token, b.window_id, d.name as doctor_name, d.user_id as doctor_user_id, b.patient_name, h.name as hospital_name, b.session_date as date,
             coalesce(w.starts_at, s.starts_at) as starts_at, coalesce(w.ends_at, s.ends_at) as ends_at,
             b.fee_paise + b.emergency_charge_paise as total
        from bookings b join doctors d on d.id = b.doctor_id join hospitals h on h.id = b.hospital_id
        join opd_sessions s on s.id = b.session_id left join opd_windows w on w.id = b.window_id
       where b.id = ${bookingId}`.execute(tx);
    const r = b.rows[0];
    if (!r?.patientUserId) return;
    const when = `${istDayLabel(r.date)}, ${istRange(new Date(r.startsAt), new Date(r.endsAt))}`;
    await notify(tx, {
      userId: r.patientUserId,
      kind: 'booked',
      title: r.source === 'emergency' ? 'Emergency consultation booked' : 'Booking confirmed',
      body:
        r.source === 'emergency'
          ? `${r.doctorName} at ${r.hospitalName}. Your token is ${tokenLabel(r.source, r.token)}. Please go now. Paid ${money(r.total).display}.`
          : `${r.doctorName}, ${when} at ${r.hospitalName}. Your token is ${tokenLabel(r.source, r.token)}. Paid ${money(r.total).display}.`,
      bookingId,
      dedupeKey: `booked:${bookingId}`,
    });
    if (r.source === 'emergency' && r.doctorUserId) {
      await notify(tx, {
        userId: r.doctorUserId,
        kind: 'system',
        title: 'Emergency patient coming',
        body: `${r.patientName} booked an emergency consultation at ${r.hospitalName}. Token ${tokenLabel(r.source, r.token)} is at the top of your line.`,
        bookingId,
        dedupeKey: `emergency-doctor:${bookingId}`,
      });
    }
    if (r.source !== 'emergency' && r.doctorUserId) {
      await notify(tx, {
        userId: r.doctorUserId,
        kind: 'booked',
        title: 'New booking',
        body: `${r.patientName} booked ${when} at ${r.hospitalName}. Token ${tokenLabel(r.source, r.token)}.`,
        bookingId,
        data: { forDoctor: 'true' },
        pref: 'newBookings',
        dedupeKey: `booked-doctor:${bookingId}`,
      });
    }
    if (r.source !== 'emergency' && r.windowId) {
      const start = new Date(r.startsAt).getTime();
      for (const [which, before] of [['day', 24 * 3_600_000], ['hour', 3_600_000]] as const) {
        const at = start - before;
        if (at > Date.now() + 5 * 60_000) {
          await enqueue(tx, { topic: 'reminder', payload: { bookingId, windowId: r.windowId, which } }, { dedupeKey: `reminder:${bookingId}:${r.windowId}:${which}`, availableAt: new Date(at) });
        }
      }
    }
  }

  // ── Refunds ────────────────────────────────────────────────────────────────────────────────────────

  /** Records a refund and hands it to the worker (Razorpay is called after commit, with retries). */
  async createRefund(
    tx: Tx,
    r: { paymentId: string; amountPaise: number; reason: RefundReason; byType: ActorType; by: string | null; bookingId: string; patientUserId: string | null; approvedBy?: string | null },
  ): Promise<string> {
    const row = await tx
      .insertInto('refunds')
      .values({ paymentId: r.paymentId, amountPaise: r.amountPaise, reason: r.reason, initiatedByType: r.byType, initiatedBy: r.by, approvedBy: r.approvedBy ?? null })
      .returning('id')
      .executeTakeFirstOrThrow();
    await tx
      .insertInto('bookingEvents')
      .values({ bookingId: r.bookingId, type: 'refund_started', actorType: r.byType, actorId: r.by, data: JSON.stringify({ refundId: row.id, amountPaise: r.amountPaise, reason: r.reason }) })
      .execute();
    await enqueue(tx, { topic: 'refund.start', payload: { refundId: row.id } }, { dedupeKey: `refund:${row.id}` });
    if (r.patientUserId) {
      const why =
        r.reason === 'provider_cancelled' ? 'The doctor cancelled your booking.'
        : r.reason === 'duplicate' ? 'You paid twice for the same booking.'
        : r.reason === 'late_payment' ? 'Your payment came after your place was released, and the hour is full.'
        : 'OPflow is giving your money back.';
      await notify(tx, {
        userId: r.patientUserId,
        kind: 'refund',
        title: 'Money back started',
        body: `${why} ${money(r.amountPaise).display} will reach your account in 5–7 working days.`,
        bookingId: r.bookingId,
        dedupeKey: `refund:${row.id}`,
      });
    }
    return row.id;
  }

  /** Worker: send one refund to Razorpay. Failures are retried 3 times over a day, then shown to admins. */
  async runRefund(refundId: string): Promise<void> {
    const r = await this.dbs.system((tx) => tx
      .selectFrom('refunds as r')
      .innerJoin('payments as p', 'p.id', 'r.paymentId')
      .select(['r.id', 'r.status', 'r.amountPaise', 'r.attempts', 'r.razorpayRefundId', 'p.razorpayPaymentId', 'p.bookingId'])
      .where('r.id', '=', refundId)
      .executeTakeFirst());
    if (!r || r.status !== 'pending' || !r.razorpayPaymentId) return;
    try {
      const result = r.razorpayRefundId
        ? await this.gateway.fetchRefund(r.razorpayPaymentId, r.razorpayRefundId)
        : await this.gateway.refund(r.razorpayPaymentId, r.amountPaise, { refundId: r.id, bookingId: r.bookingId });
      await this.dbs.system(async (tx) => {
        await tx.updateTable('refunds').set({ razorpayRefundId: result.id, attempts: r.attempts + 1 }).where('id', '=', r.id).execute();
        if (result.status === 'processed') await this.markRefund(tx, r.id, 'processed');
        if (result.status === 'failed') await this.markRefund(tx, r.id, 'failed', 'Refused by the bank');
      });
    } catch (err) {
      const attempts = r.attempts + 1;
      await this.dbs.system((tx) =>
        tx
          .updateTable('refunds')
          .set({
            status: 'failed',
            attempts,
            failureReason: (err as Error).message.slice(0, 500),
            nextAttemptAt: attempts >= 3 ? null : new Date(Date.now() + 15 * 60_000 * 4 ** attempts),
          })
          .where('id', '=', r.id)
          .where('status', '=', 'pending')
          .execute(),
      );
    }
  }

  async markRefund(tx: Tx, refundId: string, status: 'processed' | 'failed', reason?: string): Promise<void> {
    const r = await tx.selectFrom('refunds').select(['id', 'status', 'amountPaise', 'paymentId']).where('id', '=', refundId).forUpdate().executeTakeFirst();
    if (!r || r.status === status || r.status === 'processed') return;
    if (r.status === 'failed' && status === 'processed') await tx.updateTable('refunds').set({ status: 'pending' }).where('id', '=', r.id).execute();
    await tx.updateTable('refunds').set({ status, failureReason: reason ?? null, nextAttemptAt: status === 'failed' ? new Date(Date.now() + 3_600_000) : null }).where('id', '=', r.id).execute();
    if (status === 'processed') {
      const b = await tx
        .selectFrom('payments as p')
        .innerJoin('bookings as b', 'b.id', 'p.bookingId')
        .select(['b.id', 'b.patientUserId'])
        .where('p.id', '=', r.paymentId)
        .executeTakeFirst();
      if (b?.patientUserId) {
        await tx.insertInto('bookingEvents').values({ bookingId: b.id, type: 'refund_processed', actorType: 'system', data: JSON.stringify({ refundId }) }).execute();
        await notify(tx, {
          userId: b.patientUserId,
          kind: 'refund',
          title: 'Money back sent',
          body: `${money(r.amountPaise).display} was sent back to your account. Banks can take a few days to show it.`,
          bookingId: b.id,
          dedupeKey: `refund-done:${refundId}`,
        });
      }
    }
  }

  /** Job: failed refunds whose retry time has come go back to pending. */
  async retryDueRefunds(): Promise<number> {
    const due = await this.dbs.system(async (tx) => {
      const rows = await tx
        .updateTable('refunds')
        .set({ status: 'pending', nextAttemptAt: null })
        .where('status', '=', 'failed')
        .where('nextAttemptAt', '<=', new Date())
        .where('attempts', '<', 3)
        .returning('id')
        .execute();
      for (const r of rows) await enqueue(tx, { topic: 'refund.start', payload: { refundId: r.id } });
      return rows.length;
    });
    return due;
  }

  // ── Payment retry and holds ────────────────────────────────────────────────────────────────────────

  /** "Try again" in Checkout: a new order for the same held booking (the old one is set aside). */
  async retry(patientUserId: string, bookingId: string) {
    const b = await this.dbs.as({ role: 'patient', userId: patientUserId }, (tx) =>
      tx.selectFrom('bookings').select(['id', 'status', 'holdExpiresAt', 'code', 'feePaise', 'emergencyChargePaise']).where('id', '=', bookingId).executeTakeFirst(),
    );
    if (!b) throw new AppError('BOOKING_NOT_FOUND', 'We could not find this booking.', HttpStatus.NOT_FOUND);
    if (b.status !== 'pending_payment' || !b.holdExpiresAt || new Date(b.holdExpiresAt).getTime() <= Date.now()) {
      throw new AppError('HOLD_EXPIRED', 'Your place was released because payment took too long. Please book again.', HttpStatus.CONFLICT);
    }
    const amount = b.feePaise + b.emergencyChargePaise;
    const order = await this.gateway.createOrder({ amountPaise: amount, receipt: b.code, notes: { bookingId: b.id } });
    await this.dbs.as({ role: 'patient', userId: patientUserId }, async (tx) => {
      await tx.updateTable('payments').set({ abandoned: true }).where('bookingId', '=', b.id).where('status', 'in', ['created', 'authorized']).where('abandoned', '=', false).execute();
      await tx.insertInto('payments').values({ bookingId: b.id, razorpayOrderId: order.id, amountPaise: amount }).execute();
    });
    return { bookingId: b.id, payment: this.checkout(order.id, amount), holdExpiresAt: b.holdExpiresAt };
  }

  checkout(orderId: string, amountPaise: number) {
    return { orderId, keyId: this.gateway.keyId, amount: money(amountPaise), currency: 'INR', fake: this.gateway.isFake };
  }

  /**
   * Job (every 30 s): holds whose time ran out. Razorpay is asked once first, in case the payment went
   * through and its webhook is late. Works without Redis.
   */
  /**
   * Before a patient holds a new place: their own unfinished holds (a payment that failed or was closed, then
   * "Try again") would block the retry for up to 10 minutes ("You already have a booking…", "finish paying for
   * your other booking first"). Each is asked about at Razorpay: paid → confirmed (the right answer), not paid
   * → released now. A payment that still arrives later is handled like any late payment (place if free, else
   * money back).
   */
  async releaseOwnHolds(patientUserId: string): Promise<void> {
    const mine = await this.dbs.system((tx) =>
      tx.selectFrom('bookings').select(['id']).where('patientUserId', '=', patientUserId).where('status', '=', 'pending_payment').limit(5).execute(),
    );
    for (const b of mine) {
      const orders = await this.dbs.system((tx) =>
        tx.selectFrom('payments').select(['id', 'razorpayOrderId']).where('bookingId', '=', b.id).where('status', 'in', ['created', 'authorized']).execute(),
      );
      let paid = false;
      let unsure = false;
      for (const o of orders) {
        try {
          const ps = await this.gateway.fetchOrderPayments(o.razorpayOrderId);
          const captured = ps.find((x) => x.status === 'captured');
          if (captured) {
            await this.confirm(o.id, captured, 'patient');
            paid = true;
            break;
          }
          // Money on its way (authorized): leave the hold; the sweeper settles it.
          if (ps.some((x) => x.status === 'authorized')) unsure = true;
        } catch {
          unsure = true; // Razorpay unreachable: keep the hold, never guess
        }
      }
      if (paid || unsure) continue;
      await this.dbs.system(async (tx) => {
        const row = await tx.selectFrom('bookings').select(['id', 'status']).where('id', '=', b.id).forUpdate().executeTakeFirst();
        if (row?.status !== 'pending_payment') return;
        await tx.updateTable('bookings').set({ status: 'expired' }).where('id', '=', row.id).execute();
        await sql`update window_slots set state = 'free', booking_id = null, held_until = null, version = version + 1
                   where booking_id = ${row.id} and state = 'held'`.execute(tx);
        await tx.insertInto('bookingEvents').values({ bookingId: row.id, type: 'expired', actorType: 'patient', actorId: patientUserId, data: JSON.stringify({ why: 'new_attempt' }) }).execute();
      });
    }
  }

  async expireHolds(limit = 200): Promise<{ expired: number; confirmed: number }> {
    const due = await this.dbs.system((tx) =>
      tx
        .selectFrom('bookings')
        .select(['id'])
        .where('status', '=', 'pending_payment')
        .where('holdExpiresAt', '<', new Date())
        .orderBy('holdExpiresAt')
        .limit(limit)
        .execute(),
    );
    let expired = 0;
    let confirmed = 0;
    for (const b of due) {
      const orders = await this.dbs.system((tx) => tx.selectFrom('payments').select(['id', 'razorpayOrderId']).where('bookingId', '=', b.id).where('status', 'in', ['created', 'authorized']).execute());
      let paid = false;
      for (const o of orders) {
        try {
          const captured = (await this.gateway.fetchOrderPayments(o.razorpayOrderId)).find((p) => p.status === 'captured');
          if (captured) {
            await this.confirm(o.id, captured, 'sweeper');
            paid = true;
            confirmed++;
            break;
          }
        } catch {
          /* Razorpay unreachable: expire now; a late webhook still confirms or refunds (confirm handles "expired"). */
        }
      }
      if (paid) continue;
      const done = await this.dbs.system(async (tx) => {
        const row = await tx.selectFrom('bookings').select(['id', 'status', 'holdExpiresAt', 'windowId', 'token']).where('id', '=', b.id).forUpdate().executeTakeFirst();
        if (!row || row.status !== 'pending_payment' || new Date(row.holdExpiresAt!).getTime() >= Date.now()) return false;
        await tx.updateTable('bookings').set({ status: 'expired' }).where('id', '=', row.id).execute();
        await sql`update window_slots set state = 'free', booking_id = null, held_until = null, version = version + 1
                   where booking_id = ${row.id} and state = 'held'`.execute(tx);
        await tx.insertInto('bookingEvents').values({ bookingId: row.id, type: 'expired', actorType: 'system', data: '{}' }).execute();
        return true;
      });
      if (done) expired++;
    }
    return { expired, confirmed };
  }

  // ── Doctor payouts (Route) ─────────────────────────────────────────────────────────────────────────

  /** Job (hourly): transfers whose hold time is over go to the doctor's bank account. */
  async releaseDueTransfers(limit = 100): Promise<{ released: number; waiting: number }> {
    if (!this.env.RAZORPAY_ROUTE_ENABLED) return { released: 0, waiting: 0 };
    const due = await this.dbs.sys(sql<{ id: string; amountPaise: number; doctorId: string; razorpayPaymentId: string | null; accountId: string | null; accountStatus: string | null; bookingId: string }>`
      select t.id, t.amount_paise, t.doctor_id, p.razorpay_payment_id, pa.razorpay_account_id as account_id, pa.status as account_status, p.booking_id
        from transfers t join payments p on p.id = t.payment_id join bookings b on b.id = p.booking_id
        left join payout_accounts pa on pa.doctor_id = t.doctor_id
       where t.status = 'on_hold' and t.release_at <= now()
         -- Only visits that are over (seen, or did not come). A booking still open — e.g. the patient was asked
         -- to pick a new time — is never paid out, so a later refund never has to pull money back from the doctor.
         and b.status in ('completed', 'no_show')
       order by t.release_at limit ${limit}`);
    let released = 0;
    let waiting = 0;
    const sent = new Map<string, number>(); // doctor → paise sent in this run
    for (const t of due.rows) {
      if (!t.accountId || t.accountStatus !== 'active' || !t.razorpayPaymentId) {
        waiting++;
        continue;
      }
      try {
        const r = await this.gateway.transfer(t.razorpayPaymentId, t.accountId, t.amountPaise, { transferId: t.id, bookingId: t.bookingId });
        await this.dbs.system((tx) =>
          tx.updateTable('transfers').set({ status: 'released', releasedAt: new Date(), razorpayTransferId: r.id }).where('id', '=', t.id).where('status', '=', 'on_hold').execute(),
        );
        released++;
        sent.set(t.doctorId, (sent.get(t.doctorId) ?? 0) + t.amountPaise);
      } catch (err) {
        this.log.warn(`Transfer ${t.id} not released yet: ${(err as Error).message}`);
      }
    }
    // One message per doctor per run, not one per patient.
    for (const [doctorId, paise] of sent) {
      await this.dbs.system(async (tx) => {
        const d = await tx.selectFrom('doctors').select('userId').where('id', '=', doctorId).executeTakeFirst();
        if (!d?.userId) return;
        await notify(tx, {
          userId: d.userId,
          kind: 'system',
          title: 'Money sent to your bank',
          body: `${money(paise).display} is on its way to your bank account. It usually arrives within 1 working day.`,
          data: { forDoctor: 'true' },
        });
      });
    }
    return { released, waiting };
  }

  /** Worker: take back money already sent to a doctor (rare: a cancel after payout). */
  async runTransferReversal(transferId: string): Promise<void> {
    const t = await this.dbs.system((tx) => tx.selectFrom('transfers').select(['id', 'razorpayTransferId', 'amountPaise', 'status']).where('id', '=', transferId).executeTakeFirst());
    if (!t?.razorpayTransferId || t.status !== 'reversed') return;
    await this.gateway.reverseTransfer(t.razorpayTransferId, t.amountPaise);
  }

  // ── Webhooks ───────────────────────────────────────────────────────────────────────────────────────

  /** Stores each Razorpay event once (by its id), then applies it. Unknown events are stored and ignored. */
  async handleWebhook(eventId: string, event: { event?: string; payload?: Record<string, { entity?: Record<string, unknown> }> }): Promise<void> {
    const type = String(event.event ?? 'unknown');
    const fresh = await sql<{ id: string }>`
      insert into webhook_events (id, type, payload) values (${eventId}, ${type}, ${JSON.stringify(event)})
      on conflict (id) do nothing returning id`.execute(this.dbs.db);
    if (fresh.rows.length === 0) {
      const prior = await this.dbs.db.selectFrom('webhookEvents').select('processedAt').where('id', '=', eventId).executeTakeFirst();
      if (prior?.processedAt) return; // already handled
    }
    try {
      await this.applyWebhook(type, event.payload ?? {});
      await this.dbs.db.updateTable('webhookEvents').set({ processedAt: new Date(), error: null }).where('id', '=', eventId).execute();
    } catch (err) {
      await this.dbs.db.updateTable('webhookEvents').set({ error: (err as Error).message.slice(0, 500) }).where('id', '=', eventId).execute();
      throw err; // 500 → Razorpay retries the webhook
    }
  }

  private async applyWebhook(type: string, payload: Record<string, { entity?: Record<string, unknown> }>): Promise<void> {
    const payment = payload.payment?.entity;
    const refund = payload.refund?.entity;
    const transfer = payload.transfer?.entity;
    if ((type === 'payment.captured' || type === 'order.paid') && payment) {
      const orderId = String(payment.order_id ?? '');
      const row = await this.dbs.system((tx) => tx.selectFrom('payments').select(['id']).where('razorpayOrderId', '=', orderId).executeTakeFirst());
      if (!row) return;
      await this.confirm(
        row.id,
        { id: String(payment.id), orderId, amount: Number(payment.amount), status: 'captured', method: payment.method ? String(payment.method) : null, error: null },
        'webhook',
      );
    } else if (type === 'payment.failed' && payment) {
      await this.dbs.system((tx) =>
        tx
          .updateTable('payments')
          .set({ failureReason: String(payment.error_description ?? 'failed').slice(0, 300) })
          .where('razorpayOrderId', '=', String(payment.order_id ?? ''))
          .where('status', '=', 'created')
          .execute(),
      );
    } else if ((type === 'refund.processed' || type === 'refund.failed') && refund) {
      const row = await this.dbs.system((tx) => tx.selectFrom('refunds').select('id').where('razorpayRefundId', '=', String(refund.id)).executeTakeFirst());
      if (row) await this.dbs.system((tx) => this.markRefund(tx, row.id, type === 'refund.processed' ? 'processed' : 'failed', 'Refused by the bank'));
    } else if (transfer && type.startsWith('transfer.')) {
      const id = String(transfer.id);
      if (type === 'transfer.failed') {
        await this.dbs.system((tx) => tx.updateTable('transfers').set({ status: 'failed' }).where('razorpayTransferId', '=', id).where('status', '=', 'on_hold').execute());
      } else if (type === 'transfer.reversed') {
        await this.dbs.system((tx) =>
          tx.updateTable('transfers').set({ status: 'reversed', reversedAt: new Date() }).where('razorpayTransferId', '=', id).where('status', 'in', ['on_hold', 'released']).execute(),
        );
      }
    } else if (type === 'account.activated' || type === 'product.route.activated') {
      const accountId = String((payload.account?.entity?.id as string | undefined) ?? '');
      if (accountId) {
        await this.dbs.system((tx) => tx.updateTable('payoutAccounts').set({ status: 'active' }).where('razorpayAccountId', '=', accountId).execute());
      }
    }
  }
}
