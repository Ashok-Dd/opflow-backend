import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';

import { AuthedRequest, PatientId, Public, Roles } from '../../common/auth/auth.decorators';
import { sha256 } from '../../common/crypto';
import { ENV, type Env } from '../../config/env';
import { AppError } from '../../common/errors/app-error';
import { Idempotent } from '../../common/http/idempotency';
import { IdParam, ZBody } from '../../common/http/zod';
import { RateLimit } from '../../infra/redis/rate-limit';
import { PAYMENT_GATEWAY, PaymentGateway } from '../../infra/payments/gateway';
import { BookingsService } from '../bookings/bookings.service';
import { PaymentsService } from './payments.service';

const verifyBody = z.object({
  razorpay_order_id: z.string().min(5).max(40),
  razorpay_payment_id: z.string().min(5).max(40),
  razorpay_signature: z.string().min(10).max(200),
});

@ApiTags('payments')
@Controller('v1')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly bookings: BookingsService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** After Razorpay Checkout succeeds: confirms the booking and returns it (with the token). */
  @Post('payments/verify')
  @Roles('patient')
  @HttpCode(200)
  async verify(@PatientId() userId: string, @ZBody(verifyBody) body: z.output<typeof verifyBody>) {
    const r = await this.payments.verify(userId, { orderId: body.razorpay_order_id, paymentId: body.razorpay_payment_id, signature: body.razorpay_signature });
    return { outcome: r.outcome, booking: await this.bookings.get(userId, r.bookingId) };
  }

  /** "Was I charged?": the phone asks after any doubtful result; confirms a captured payment (never charges). */
  @Post('payments/:id/check')
  @Roles('patient')
  @HttpCode(200)
  @RateLimit('payment-check', 30, 60, 'user')
  async check(@PatientId() userId: string, @IdParam() bookingId: string) {
    const r = await this.payments.checkStatus(userId, bookingId);
    return { ...r, booking: await this.bookings.get(userId, bookingId) };
  }

  /** "Try again" after a failed payment, while the place is still kept. */
  @Post('payments/:id/retry')
  @Roles('patient')
  @HttpCode(200)
  @Idempotent()
  retry(@PatientId() userId: string, @IdParam() bookingId: string) {
    return this.payments.retry(userId, bookingId);
  }

  /**
   * Razorpay "redirect" mode, used by the web version (iPhone users in Safari): no pop-up windows, which phones
   * block. After the bank / UPI page Razorpay sends the person here, and we send them straight back to the web app,
   * which asks the server "was I charged?" (payments/:id/check) — nothing in this request is trusted, and `to` must
   * be one of OPflow's own web addresses (CORS_ORIGINS), so this can never send anyone to another site.
   */
  @Post('payments/return')
  @Public()
  paidReturn(@Query('b') b: string, @Query('to') to: string, @Body() body: Record<string, unknown> | undefined, @Res() res: Response) {
    this.sendBack(res, b, to, typeof body?.razorpay_payment_id === 'string');
  }

  @Get('payments/return')
  @Public()
  paidReturnGet(@Query('b') b: string, @Query('to') to: string, @Query('razorpay_payment_id') paymentId: string | undefined, @Res() res: Response) {
    this.sendBack(res, b, to, typeof paymentId === 'string');
  }

  private sendBack(res: Response, bookingId: string, to: string, paid: boolean) {
    const ownSite = typeof to === 'string' && this.env.CORS_ORIGINS.includes(to.replace(/\/$/, ''));
    if (!ownSite || typeof bookingId !== 'string' || !/^[0-9a-f-]{36}$/i.test(bookingId)) {
      throw new AppError('BAD_RETURN', 'This payment link is not valid. Please open OPflow and check My bookings.', HttpStatus.BAD_REQUEST);
    }
    res.redirect(303, `${to.replace(/\/$/, '')}/#/pay-return?b=${bookingId}&ok=${paid ? 1 : 0}`);
  }

  /**
   * Razorpay webhooks (Dashboard → Webhooks → {API_PUBLIC_URL}/v1/webhooks/razorpay). The signature is
   * checked on the exact bytes received. Each event is applied once, even if Razorpay sends it again.
   */
  @Post('webhooks/razorpay')
  @Public()
  @HttpCode(200)
  async webhook(@Req() req: AuthedRequest, @Headers('x-razorpay-signature') signature?: string, @Headers('x-razorpay-event-id') eventId?: string) {
    const raw = req.rawBody;
    if (!raw || !signature || !this.gateway.verifyWebhookSignature(raw, signature)) {
      throw new AppError('BAD_SIGNATURE', 'Signature check failed.', HttpStatus.BAD_REQUEST);
    }
    const event = JSON.parse(raw.toString('utf8')) as { event?: string; created_at?: number; payload?: Record<string, { entity?: Record<string, unknown> }> };
    const id = eventId ?? `sha256:${sha256(raw).toString('hex').slice(0, 56)}`;
    await this.payments.handleWebhook(id.slice(0, 64), event);
    return { ok: true };
  }
}
