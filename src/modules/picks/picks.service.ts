import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';

import type { AdminPrincipal, RequestMeta } from '../../common/auth/auth.decorators';
import { audit } from '../../common/audit';
import { AppError } from '../../common/errors/app-error';
import { isUniqueViolation } from '../../common/errors/pg-errors';
import { money } from '../../common/money';
import { maskContact } from '../../infra/messaging/messaging';
import { DbService, Tx } from '../../infra/db/db.service';
import { GatewayPayment, PAYMENT_GATEWAY, PaymentGateway } from '../../infra/payments/gateway';
import { RulesService } from '../../infra/rules/rules.service';
import { DirectoryService } from '../directory/directory.service';

/** At most this many doctors in one suggestion (decided with the user). */
const MAX_PICKS = 3;

type Near = { lat: number; lng: number };
interface Candidate {
  doctorId: string;
  rank: number;
  reasons: string[];
  distanceM: number;
  avgRating: number | null;
}
interface Snapshot {
  doctorId: string;
  reasons: string[];
  distanceM: number;
}

const asPatient = (userId: string) => ({ role: 'patient' as const, userId });
const asAdmin = (who: AdminPrincipal) => ({ role: 'admin' as const, adminId: who.adminId });

/**
 * "Find Your Right Doctor": a paid, one-time suggestion of up to 3 doctors of one type near the patient.
 *
 * - The doctors are OPflow picks set by the admin only (rank + reasons). Doctors can never pay for, ask for or see a
 *   pick; the order is admin rank, then private patient feedback, then distance.
 * - The patient never pays when there is nothing to suggest (checked before the order and again when paid; if the
 *   picks vanished in between, the money goes back automatically).
 * - The result is a snapshot kept with the purchase (one-time; never refreshed).
 * - Visit feedback (1–5 + note) is private: only OPflow (admin) reads it, to choose the picks.
 */
@Injectable()
export class PicksService {
  private readonly log = new Logger('Picks');

  constructor(
    private readonly dbs: DbService,
    private readonly rules: RulesService,
    private readonly dir: DirectoryService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  // ── Choosing the doctors ─────────────────────────────────────────────────────────────────────────

  /** OPflow's picks of one type near a point, best-matched first (at most 3). */
  private async candidates(tx: Tx, typeId: string, near: Near): Promise<Candidate[]> {
    const maxM = (await this.rules.picksMaxKm()) * 1000;
    const rows = await sql<Candidate>`
      select p.doctor_id, p.rank, p.reasons, x.distance_m::float8 as distance_m,
             (select avg(f.rating)::float8 from visit_feedback f where f.doctor_id = d.id) as avg_rating
        from doctor_picks p
        join doctors d on d.id = p.doctor_id
        cross join lateral (
          select min(earth_distance(ll_to_earth(h.lat, h.lng), ll_to_earth(${near.lat}::float8, ${near.lng}::float8))) as distance_m
            from doctor_hospitals dh join hospitals h on h.id = dh.hospital_id
           where dh.doctor_id = d.id and dh.status = 'active' and h.status = 'active'
        ) x
       where p.active and d.type_id = ${typeId} and d.verification = 'verified' and d.status = 'active'
         and not d.bookings_paused and x.distance_m is not null and x.distance_m <= ${maxM}
       order by p.rank asc, avg_rating desc nulls last, x.distance_m asc
       limit ${MAX_PICKS}`.execute(tx);
    return rows.rows;
  }

  private async requireOn(): Promise<void> {
    if (!(await this.rules.picksEnabled())) {
      throw new AppError('PICKS_OFF', 'Doctor suggestions are stopped for a short time. Please try again later.', HttpStatus.SERVICE_UNAVAILABLE, true);
    }
  }

  private async typeName(tx: Tx, typeId: string): Promise<string> {
    const t = await tx.selectFrom('doctorTypes').select('simpleName').where('id', '=', typeId).executeTakeFirst();
    if (!t) throw new AppError('TYPE_NOT_FOUND', 'We could not find this type of doctor.', HttpStatus.NOT_FOUND);
    return t.simpleName;
  }

  // ── Patient ──────────────────────────────────────────────────────────────────────────────────────

  /** For the Home card: whether the feature is on, and its price (set by the admin). */
  async info() {
    const [enabled, pricePaise] = await Promise.all([this.rules.picksEnabled(), this.rules.picksPricePaise()]);
    return { enabled, price: money(pricePaise), max: MAX_PICKS };
  }

  /** Before paying: the price, how OPflow recommends, and how many doctors it can suggest here (0 = don't pay). */
  async offer(typeId: string, near: Near) {
    const [enabled, pricePaise, criteria] = await Promise.all([this.rules.picksEnabled(), this.rules.picksPricePaise(), this.rules.picksCriteria()]);
    const { name, found } = await this.dbs.system(async (tx) => ({ name: await this.typeName(tx, typeId), found: await this.candidates(tx, typeId, near) }));
    return { enabled, typeId, typeName: name, price: money(pricePaise), criteria, available: found.length, max: MAX_PICKS };
  }

  /** Opens the ₹99 order (Razorpay). Refused when there is nothing to suggest, so nobody pays for an empty list. */
  async purchase(userId: string, body: { type: string; near: Near; place?: string }) {
    await this.requireOn();
    const pricePaise = await this.rules.picksPricePaise();
    const found = await this.dbs.system(async (tx) => {
      await this.typeName(tx, body.type);
      return this.candidates(tx, body.type, body.near);
    });
    if (found.length === 0) {
      throw new AppError('NO_PICKS', 'OPflow has no suggestions for this type of doctor near you yet. Nothing was charged.', HttpStatus.CONFLICT);
    }
    const order = await this.gateway.createOrder({ amountPaise: pricePaise, receipt: `PICK-${Date.now().toString(36)}`, notes: { kind: 'picks', typeId: body.type } });
    const row = await this.dbs.as(asPatient(userId), (tx) =>
      tx
        .insertInto('pickPurchases')
        .values({
          patientUserId: userId,
          typeId: body.type,
          nearLat: body.near.lat,
          nearLng: body.near.lng,
          place: body.place?.slice(0, 80) ?? null,
          amountPaise: pricePaise,
          razorpayOrderId: order.id,
          consentAt: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow(),
    );
    return {
      purchase: { id: row.id, status: 'pending_payment' },
      payment: { orderId: order.id, keyId: this.gateway.keyId, amount: money(pricePaise), currency: 'INR', fake: this.gateway.isFake },
    };
  }

  /** After Checkout: check the signature and the payment itself with Razorpay, then build the suggestion. */
  async verify(userId: string, input: { orderId: string; paymentId: string; signature: string }) {
    const row = await this.dbs.as(asPatient(userId), (tx) =>
      tx.selectFrom('pickPurchases').select(['id', 'amountPaise']).where('razorpayOrderId', '=', input.orderId).executeTakeFirst(),
    );
    if (!row) throw new AppError('PAYMENT_NOT_FOUND', 'We could not find this payment. If money was taken, it will come back automatically.', HttpStatus.NOT_FOUND);
    if (!this.gateway.verifyPaymentSignature(input.orderId, input.paymentId, input.signature)) {
      throw new AppError('PAYMENT_NOT_VERIFIED', 'We could not confirm this payment. If money was taken, it will come back automatically.', HttpStatus.BAD_REQUEST);
    }
    const gp = await this.gateway.fetchPayment(input.paymentId);
    if (gp.orderId !== input.orderId || gp.amount !== row.amountPaise) {
      this.log.error(`Pick payment ${input.paymentId} does not match order ${input.orderId}`);
      throw new AppError('PAYMENT_NOT_VERIFIED', 'We could not confirm this payment. If money was taken, it will come back automatically.', HttpStatus.BAD_REQUEST);
    }
    if (gp.status === 'failed') throw new AppError('PAYMENT_FAILED', 'The payment did not go through. No money was taken. Please try again.', HttpStatus.PAYMENT_REQUIRED);
    if (gp.status === 'captured') await this.settle(row.id, gp);
    return this.get(userId, row.id);
  }

  /** "Was I charged?" after a web redirect or an unsure result: asks Razorpay; never charges. */
  async check(userId: string, id: string) {
    const row = await this.dbs.as(asPatient(userId), (tx) =>
      tx.selectFrom('pickPurchases').select(['id', 'status', 'razorpayOrderId']).where('id', '=', id).executeTakeFirst(),
    );
    if (!row) throw new AppError('NOT_FOUND', 'We could not find this suggestion.', HttpStatus.NOT_FOUND);
    if (row.status === 'pending_payment') {
      const captured = (await this.gateway.fetchOrderPayments(row.razorpayOrderId).catch(() => [])).find((p) => p.status === 'captured');
      if (captured) await this.settle(row.id, captured);
    }
    return this.get(userId, id);
  }

  /** From the Razorpay webhook: a pick order was paid (the phone may never have come back). True when it was one. */
  async webhookPaid(orderId: string, gp: GatewayPayment): Promise<boolean> {
    const row = await this.dbs.system((tx) => tx.selectFrom('pickPurchases').select('id').where('razorpayOrderId', '=', orderId).executeTakeFirst());
    if (!row) return false;
    await this.settle(row.id, gp);
    return true;
  }

  /**
   * THE place a paid suggestion is made (verify, check and webhook may race: the row lock makes it happen once).
   * If there is nothing to suggest any more, the money goes back at once.
   */
  private async settle(purchaseId: string, gp: GatewayPayment): Promise<void> {
    const refundNeeded = await this.dbs.system(async (tx) => {
      const p = await tx.selectFrom('pickPurchases').selectAll().where('id', '=', purchaseId).forUpdate().executeTakeFirstOrThrow();
      if (p.status !== 'pending_payment') return false;
      if (gp.amount !== p.amountPaise) {
        this.log.error(`Pick ${purchaseId}: paid ${gp.amount}, expected ${p.amountPaise}`);
        return false;
      }
      const found = await this.candidates(tx, p.typeId, { lat: p.nearLat, lng: p.nearLng });
      const snapshot: Snapshot[] = found.map((c) => ({ doctorId: c.doctorId, reasons: c.reasons, distanceM: Math.round(c.distanceM) }));
      await tx
        .updateTable('pickPurchases')
        .set({ status: 'paid', paidAt: new Date(), razorpayPaymentId: gp.id, result: JSON.stringify(snapshot) })
        .where('id', '=', purchaseId)
        .execute();
      return snapshot.length === 0;
    });
    if (refundNeeded) await this.refund(purchaseId, 'No suggestions were left near the patient when the payment arrived.');
  }

  private async refund(purchaseId: string, reason: string): Promise<void> {
    const p = await this.dbs.system((tx) => tx.selectFrom('pickPurchases').selectAll().where('id', '=', purchaseId).executeTakeFirstOrThrow());
    if (p.status !== 'paid' || !p.razorpayPaymentId) throw new AppError('NOT_REFUNDABLE', 'Only a paid suggestion can be refunded.', HttpStatus.CONFLICT);
    const r = await this.gateway.refund(p.razorpayPaymentId, p.amountPaise, { purchaseId, reason: reason.slice(0, 200) });
    await this.dbs.system((tx) =>
      tx
        .updateTable('pickPurchases')
        .set({ status: 'refunded', refundId: r.id, refundReason: reason, refundedAt: new Date() })
        .where('id', '=', purchaseId)
        .where('status', '=', 'paid')
        .execute(),
    );
  }

  /** One suggestion, with each doctor's current public card (the list itself never changes). */
  async get(userId: string, id: string) {
    const p = await this.dbs.as(asPatient(userId), (tx) => tx.selectFrom('pickPurchases').selectAll().where('id', '=', id).executeTakeFirst());
    if (!p) throw new AppError('NOT_FOUND', 'We could not find this suggestion.', HttpStatus.NOT_FOUND);
    return this.view(p);
  }

  async mine(userId: string) {
    const rows = await this.dbs.as(asPatient(userId), (tx) =>
      tx.selectFrom('pickPurchases').selectAll().where('status', 'in', ['paid', 'refunded']).orderBy('createdAt', 'desc').limit(30).execute(),
    );
    const names = await this.dbs.system((tx) => tx.selectFrom('doctorTypes').select(['id', 'simpleName']).execute());
    const byId = new Map(names.map((t) => [t.id, t.simpleName]));
    return {
      items: rows.map((p) => ({
        id: p.id,
        typeId: p.typeId,
        typeName: byId.get(p.typeId) ?? p.typeId,
        status: p.status,
        place: p.place,
        count: Array.isArray(p.result) ? p.result.length : 0,
        paidAt: p.paidAt,
      })),
    };
  }

  private async view(p: { id: string; typeId: string; status: string; place: string | null; amountPaise: number; paidAt: Date | null; createdAt: Date; nearLat: number; nearLng: number; result: unknown; refundReason: string | null }) {
    const snapshot = (Array.isArray(p.result) ? p.result : []) as Snapshot[];
    const typeName = await this.dbs.system((tx) => this.typeName(tx, p.typeId));
    let doctors: unknown[] = [];
    if (snapshot.length) {
      const cards = await this.dir.cards({ ids: snapshot.map((s) => s.doctorId), near: { lat: p.nearLat, lng: p.nearLng }, limit: MAX_PICKS });
      const byId = new Map(cards.items.map((c) => [c.id, c]));
      doctors = snapshot.map((s) => ({ doctor: byId.get(s.doctorId) ?? null, reasons: s.reasons, distanceM: s.distanceM })).filter((x) => x.doctor);
    }
    return {
      id: p.id,
      typeId: p.typeId,
      typeName,
      status: p.status,
      place: p.place,
      amount: money(p.amountPaise),
      paidAt: p.paidAt,
      createdAt: p.createdAt,
      refundReason: p.status === 'refunded' ? p.refundReason : null,
      doctors,
    };
  }

  // ── Visit feedback (private) ─────────────────────────────────────────────────────────────────────

  /** "How was your visit?" — once, only for the patient's own completed visit. Only OPflow reads it. */
  async feedback(userId: string, bookingId: string, rating: number, note?: string) {
    await this.dbs.as(asPatient(userId), async (tx) => {
      const b = await tx.selectFrom('bookings').select(['id', 'status', 'doctorId']).where('id', '=', bookingId).where('patientUserId', '=', userId).executeTakeFirst();
      if (!b) throw new AppError('BOOKING_NOT_FOUND', 'We could not find this booking.', HttpStatus.NOT_FOUND);
      if (b.status !== 'completed') throw new AppError('NOT_VISITED_YET', 'You can tell us about the visit after it is done.', HttpStatus.CONFLICT);
      try {
        await tx
          .insertInto('visitFeedback')
          .values({ bookingId, doctorId: b.doctorId, patientUserId: userId, rating, note: note?.trim() ? note.trim().slice(0, 300) : null })
          .execute();
      } catch (err) {
        if (isUniqueViolation(err)) throw new AppError('ALREADY_SENT', 'You already told us about this visit. Thank you!', HttpStatus.CONFLICT);
        throw err;
      }
    });
    return { ok: true, message: 'Thank you. Only OPflow sees this; it helps us suggest the right doctors.' };
  }

  /** Whether the patient already rated these bookings (for the "How was your visit?" card). */
  async ratedBookings(userId: string, bookingIds: string[]): Promise<Set<string>> {
    if (!bookingIds.length) return new Set();
    const rows = await this.dbs.as(asPatient(userId), (tx) => tx.selectFrom('visitFeedback').select('bookingId').where('bookingId', 'in', bookingIds).execute());
    return new Set(rows.map((r) => r.bookingId));
  }

  // ── Admin ────────────────────────────────────────────────────────────────────────────────────────

  /** Every pick, with each doctor's type, city and private rating. */
  async adminList(who: AdminPrincipal) {
    const rows = await this.dbs.as(asAdmin(who), (tx) =>
      sql<{
        doctorId: string;
        name: string;
        typeId: string;
        typeName: string;
        cities: string[] | null;
        rank: number;
        reasons: string[];
        active: boolean;
        avgRating: number | null;
        ratings: number;
        verification: string;
        status: string;
      }>`
        select p.doctor_id, d.name, d.type_id, t.simple_name as type_name, p.rank, p.reasons, p.active, d.verification, d.status,
               (select array_agg(distinct h.city order by h.city) from doctor_hospitals dh join hospitals h on h.id = dh.hospital_id
                 where dh.doctor_id = d.id and dh.status = 'active') as cities,
               (select avg(f.rating)::float8 from visit_feedback f where f.doctor_id = d.id) as avg_rating,
               (select count(*)::int from visit_feedback f where f.doctor_id = d.id) as ratings
          from doctor_picks p join doctors d on d.id = p.doctor_id join doctor_types t on t.id = d.type_id
         order by t.simple_name, p.active desc, p.rank, d.name`.execute(tx),
    );
    return { items: rows.rows };
  }

  /** One doctor's pick (or none) and their private feedback. */
  async adminDoctor(who: AdminPrincipal, doctorId: string) {
    return this.dbs.as(asAdmin(who), async (tx) => {
      const pick = await tx.selectFrom('doctorPicks').select(['rank', 'reasons', 'active', 'updatedAt']).where('doctorId', '=', doctorId).executeTakeFirst();
      const stats = await sql<{ avg: number | null; count: number }>`
        select avg(rating)::float8 as avg, count(*)::int as count from visit_feedback where doctor_id = ${doctorId}`.execute(tx);
      const recent = await tx
        .selectFrom('visitFeedback')
        .select(['bookingId', 'rating', 'note', 'createdAt'])
        .where('doctorId', '=', doctorId)
        .orderBy('createdAt', 'desc')
        .limit(10)
        .execute();
      return { pick: pick ?? null, feedback: { average: stats.rows[0]?.avg ?? null, count: stats.rows[0]?.count ?? 0, recent } };
    });
  }

  /** Make a doctor an OPflow pick (or change rank / reasons, or switch it off). Admin only; audited. */
  async adminSet(who: AdminPrincipal, doctorId: string, body: { active: boolean; rank: number; reasons: string[] }, meta: RequestMeta) {
    const reasons = body.reasons.map((r) => r.trim()).filter(Boolean).slice(0, 4);
    await this.dbs.as(asAdmin(who), async (tx) => {
      const d = await tx.selectFrom('doctors').select(['id', 'verification']).where('id', '=', doctorId).executeTakeFirst();
      if (!d) throw new AppError('DOCTOR_NOT_FOUND', 'We could not find this doctor.', HttpStatus.NOT_FOUND);
      if (body.active && d.verification !== 'verified') throw new AppError('NOT_VERIFIED', 'Only a verified doctor can be an OPflow pick.', HttpStatus.CONFLICT);
      if (body.active && reasons.length < 1) throw new AppError('INVALID_INPUT', 'Please write at least one reason patients will see.', HttpStatus.BAD_REQUEST);
      await tx
        .insertInto('doctorPicks')
        .values({ doctorId, rank: body.rank, reasons, active: body.active, createdBy: who.adminId, updatedBy: who.adminId })
        .onConflict((oc) => oc.column('doctorId').doUpdateSet({ rank: body.rank, reasons, active: body.active, updatedBy: who.adminId }))
        .execute();
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: body.active ? 'pick.set' : 'pick.off', entity: 'doctor', entityId: doctorId, meta, after: { rank: body.rank, reasons, active: body.active } });
    });
    return { ok: true, message: body.active ? 'Saved. This doctor is an OPflow pick.' : 'Saved. This doctor is not suggested any more.' };
  }

  /** Paid suggestions (newest first), with the patient's phone masked. */
  async adminPurchases(who: AdminPrincipal, q: { status?: string; offset: number; limit: number }) {
    const rows = await this.dbs.as(asAdmin(who), (tx) =>
      sql<{ id: string; status: string; typeName: string; place: string | null; amountPaise: number; paidAt: Date | null; createdAt: Date; phone: string | null; count: number; refundReason: string | null }>`
        select pp.id, pp.status, t.simple_name as type_name, pp.place, pp.amount_paise, pp.paid_at, pp.created_at, u.phone,
               coalesce(jsonb_array_length(pp.result), 0) as count, pp.refund_reason
          from pick_purchases pp join doctor_types t on t.id = pp.type_id join users u on u.id = pp.patient_user_id
         where pp.status in ('paid', 'refunded') and (${q.status ?? null}::text is null or pp.status = ${q.status ?? null})
         order by pp.created_at desc
         limit ${q.limit + 1} offset ${q.offset}`.execute(tx),
    );
    const items = rows.rows.slice(0, q.limit).map((r) => ({ ...r, phone: r.phone ? maskContact(r.phone) : null, amount: money(r.amountPaise) }));
    return { items, hasMore: rows.rows.length > q.limit };
  }

  /** Give the ₹99 back by hand (admin). */
  async adminRefund(who: AdminPrincipal, id: string, reason: string, meta: RequestMeta) {
    await this.refund(id, reason);
    await this.dbs.as(asAdmin(who), (tx) => audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'pick.refund', entity: 'pick_purchase', entityId: id, meta, after: { reason } }));
    return { ok: true, message: 'Money back started. It reaches the patient in 5–7 days.' };
  }
}
