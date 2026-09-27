import { Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { Admin, AdminPrincipal, CurrentAdmin, Meta, PatientId, RequestMeta, Roles } from '../../common/auth/auth.decorators';
import { Idempotent } from '../../common/http/idempotency';
import { decodeCursor, IdParam, ZBody, zCursor, zLimit, ZQuery } from '../../common/http/zod';
import { RateLimit } from '../../infra/redis/rate-limit';
import { PicksService } from './picks.service';
import { zReturnTo } from '../payments/orders';

const zNear = z
  .string()
  .regex(/^-?\d{1,2}(\.\d+)?,-?\d{1,3}(\.\d+)?$/, 'must be "lat,lng"')
  .transform((v) => {
    const [lat, lng] = v.split(',').map(Number) as [number, number];
    return { lat, lng };
  });
const zType = z.string().regex(/^[a-z]{2,20}$/, 'must be a type of doctor');

const offerQuery = z.object({ type: zType, near: zNear });
const purchaseBody = z.object({
  type: zType,
  near: zNear,
  place: z.string().trim().max(80).optional(),
  // The patient ticked "I understand this is a recommendation, not a guarantee…" (kept with the purchase).
  consent: z.literal(true, { message: 'Please tick that you understand before paying' }),
  returnTo: zReturnTo,
});
const verifyBody = z.object({ orderId: z.string().regex(/^[A-Za-z0-9_-]{5,45}$/) });
const feedbackBody = z.object({ rating: z.number().int().min(1).max(5), note: z.string().trim().max(300).optional() });

/** Patients: "Find Your Right Doctor" (paid one-time suggestion) and private visit feedback. */
@ApiTags('picks')
@Controller('v1')
export class PicksController {
  constructor(private readonly picks: PicksService) {}

  /** The Home card: on or off, and the price. */
  @Get('picks/info')
  @Roles('patient')
  info() {
    return this.picks.info();
  }

  /** Before paying: price, "How we recommend", and how many doctors OPflow can suggest near the patient. */
  @Get('picks/offer')
  @Roles('patient')
  offer(@ZQuery(offerQuery) q: z.output<typeof offerQuery>) {
    return this.picks.offer(q.type, q.near);
  }

  @Post('picks/purchase')
  @Roles('patient')
  @Idempotent()
  @RateLimit('picks-purchase', 10, 3600, 'user')
  purchase(@PatientId() userId: string, @ZBody(purchaseBody) b: z.output<typeof purchaseBody>) {
    return this.picks.purchase(userId, { type: b.type, near: b.near, place: b.place, returnTo: b.returnTo });
  }

  @Post('picks/verify')
  @Roles('patient')
  @HttpCode(200)
  verify(@PatientId() userId: string, @ZBody(verifyBody) b: z.output<typeof verifyBody>) {
    return this.picks.verify(userId, { orderId: b.orderId });
  }

  /** "Was I charged?" (after the web version's bank page, or an unsure result). Never charges. */
  @Post('picks/:id/check')
  @Roles('patient')
  @HttpCode(200)
  @RateLimit('picks-check', 30, 60, 'user')
  check(@PatientId() userId: string, @IdParam() id: string) {
    return this.picks.check(userId, id);
  }

  @Get('picks/mine')
  @Roles('patient')
  mine(@PatientId() userId: string) {
    return this.picks.mine(userId);
  }

  @Get('picks/:id')
  @Roles('patient')
  one(@PatientId() userId: string, @IdParam() id: string) {
    return this.picks.get(userId, id);
  }

  /** "How was your visit?" (1–5 + note) — only OPflow reads it. */
  @Post('bookings/:id/feedback')
  @Roles('patient')
  @HttpCode(200)
  feedback(@PatientId() userId: string, @IdParam() id: string, @ZBody(feedbackBody) b: z.output<typeof feedbackBody>) {
    return this.picks.feedback(userId, id, b.rating, b.note);
  }
}

const setBody = z.object({
  active: z.boolean(),
  rank: z.number().int().min(1).max(9),
  reasons: z.array(z.string().trim().max(90)).max(4),
});
const purchasesQuery = z.object({ status: z.enum(['paid', 'refunded']).optional(), cursor: zCursor, limit: zLimit });
const refundBody = z.object({ reason: z.string().trim().min(5, 'Please write a reason (5+ letters)').max(240) });

/** The admin: who OPflow suggests (never paid for by doctors), private feedback, and the ₹99 purchases. */
@ApiTags('admin: picks')
@Controller('v1/admin')
export class AdminPicksController {
  constructor(private readonly picks: PicksService) {}

  @Get('picks')
  @Admin('super', 'ops')
  list(@CurrentAdmin() who: AdminPrincipal) {
    return this.picks.adminList(who);
  }

  @Get('doctors/:id/pick')
  @Admin('super', 'ops')
  doctor(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string) {
    return this.picks.adminDoctor(who, id);
  }

  @Put('doctors/:id/pick')
  @Admin('super', 'ops')
  set(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @ZBody(setBody) b: z.output<typeof setBody>, @Meta() meta: RequestMeta) {
    return this.picks.adminSet(who, id, b, meta);
  }

  @Get('picks/purchases')
  @Admin('super', 'ops', 'finance', 'support')
  purchases(@CurrentAdmin() who: AdminPrincipal, @ZQuery(purchasesQuery) q: z.output<typeof purchasesQuery>) {
    return this.picks.adminPurchases(who, { status: q.status, offset: decodeCursor(q.cursor), limit: q.limit });
  }

  @Post('picks/purchases/:id/refund')
  @Admin('super', 'finance')
  @HttpCode(200)
  refund(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @ZBody(refundBody) b: z.output<typeof refundBody>, @Meta() meta: RequestMeta) {
    return this.picks.adminRefund(who, id, b.reason, meta);
  }
}
