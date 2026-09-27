import { Controller, Get, Headers, HttpCode, HttpStatus, Inject, Post, Query, Req, Res } from '@nestjs/common';
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
import { PAYOUTS, PayoutsProvider } from '../../infra/payments/payouts';
import { BookingsService } from '../bookings/bookings.service';
import { zReturnTo } from './orders';
import { PaymentsService } from './payments.service';

const verifyBody = z.object({ orderId: z.string().regex(/^[A-Za-z0-9_-]{5,45}$/) });
const retryBody = z.object({ returnTo: zReturnTo }).default({});

@ApiTags('payments')
@Controller('v1')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly bookings: BookingsService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(PAYOUTS) private readonly payouts: PayoutsProvider,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** After the Cashfree checkout closes: asks Cashfree about the order, confirms the booking and returns it. */
  @Post('payments/verify')
  @Roles('patient')
  @HttpCode(200)
  async verify(@PatientId() userId: string, @ZBody(verifyBody) body: z.output<typeof verifyBody>) {
    const r = await this.payments.verify(userId, { orderId: body.orderId });
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
  retry(@PatientId() userId: string, @IdParam() bookingId: string, @ZBody(retryBody) b: z.output<typeof retryBody>) {
    return this.payments.retry(userId, bookingId, b.returnTo);
  }

  /**
   * The web version (iPhone users in Safari) pays on Cashfree's page in the same tab; afterwards Cashfree sends
   * the person here (the order's return_url), and we send them straight back to the web app, which asks the
   * server "was I charged?" (payments/:id/check). Nothing in this request is trusted, and `to` must be one of
   * OPflow's own web addresses (CORS_ORIGINS), so this can never send anyone to another site.
   */
  @Get('payments/return')
  @Public()
  paidReturn(@Query('b') b: string, @Query('p') p: string, @Query('to') to: string, @Res() res: Response) {
    this.sendBack(res, b ?? p, to, p ? 'pick-return' : 'pay-return');
  }

  /** `b` = a booking (/pay-return), `p` = a ₹99 doctor suggestion (/pick-return). */
  private sendBack(res: Response, bookingId: string, to: string, screen: 'pay-return' | 'pick-return') {
    const ownSite = typeof to === 'string' && this.env.CORS_ORIGINS.includes(to.replace(/\/$/, ''));
    if (!ownSite || typeof bookingId !== 'string' || !/^[0-9a-f-]{36}$/i.test(bookingId)) {
      throw new AppError('BAD_RETURN', 'This payment link is not valid. Please open OPflow and check My bookings.', HttpStatus.BAD_REQUEST);
    }
    const key = screen === 'pick-return' ? 'p' : 'b';
    // ok=1: "maybe paid" — the app keeps asking the server a little longer before it says "not paid".
    res.redirect(303, `${to.replace(/\/$/, '')}/#/${screen}?${key}=${bookingId}&ok=1`);
  }

  /**
   * Cashfree webhooks. Payment Gateway (Developers → Webhooks → {API_PUBLIC_URL}/v1/webhooks/cashfree) and Payouts
   * (V2 webhooks → {API_PUBLIC_URL}/v1/webhooks/cashfree-payouts). The signature (timestamp + exact bytes) is
   * checked with each product's secret. Each event is applied once, even if Cashfree sends it again.
   */
  @Post('webhooks/cashfree')
  @Public()
  @HttpCode(200)
  async webhook(@Req() req: AuthedRequest, @Headers('x-webhook-signature') signature?: string, @Headers('x-webhook-timestamp') timestamp?: string) {
    return this.receive(req, 'payments', signature, timestamp);
  }

  @Post('webhooks/cashfree-payouts')
  @Public()
  @HttpCode(200)
  async payoutWebhook(@Req() req: AuthedRequest, @Headers('x-webhook-signature') signature?: string, @Headers('x-webhook-timestamp') timestamp?: string) {
    return this.receive(req, 'payouts', signature, timestamp);
  }

  private async receive(req: AuthedRequest, source: 'payments' | 'payouts', signature?: string, timestamp?: string) {
    const raw = req.rawBody;
    // Payouts V1 (and low-balance alerts): no signature headers; the signature is a field of the body.
    if (source === 'payouts' && !signature && raw) {
      const fields = v1Fields(raw);
      if (fields && this.payouts.verifyV1Signature(fields)) {
        await this.payments.handleWebhook(`cf:${sha256(raw).toString('hex').slice(0, 60)}`, 'payouts', v1ToV2(fields));
        return { ok: true };
      }
    }
    const ok = !!raw && !!signature && !!timestamp &&
      (source === 'payments' ? this.gateway.verifyWebhookSignature(raw, signature, timestamp) : this.payouts.verifyWebhookSignature(raw, signature, timestamp));
    if (!ok) {
      // Never acted on. Answered 200 so Cashfree's "Test & Add" can save the address; kept (briefly) so a wrong
      // key or dashboard mode can be found. The payment itself is still confirmed by the app's check and the sweeper.
      await this.payments.recordRejectedWebhook(source, raw, signature, timestamp);
      return { ok: false, ignored: 'signature' };
    }
    const event = JSON.parse(raw.toString('utf8')) as { type?: string; data?: Record<string, unknown> };
    await this.payments.handleWebhook(`cf:${sha256(raw).toString('hex').slice(0, 60)}`, source, event);
    return { ok: true };
  }
}

/** A Payouts V1 body (JSON or form fields) as plain strings, or null. */
function v1Fields(raw: Buffer): Record<string, string> | null {
  const text = raw.toString('utf8');
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)]));
  } catch {
    const f = Object.fromEntries(new URLSearchParams(text));
    return Object.keys(f).length ? f : null;
  }
}

/** V1 names → the V2 shape the service reads (event → type; transferId → transfer_id; …). */
function v1ToV2(f: Record<string, string>): { type: string; data: Record<string, unknown> } {
  const event = f.event ?? 'unknown';
  const status = event === 'TRANSFER_SUCCESS' ? 'SUCCESS' : event === 'TRANSFER_FAILED' ? 'FAILED' : event === 'TRANSFER_REVERSED' ? 'REVERSED' : event === 'TRANSFER_REJECTED' ? 'REJECTED' : event;
  return {
    type: event,
    data: {
      transfer_id: f.transferId,
      cf_transfer_id: f.referenceId,
      status,
      transfer_utr: f.utr,
      status_description: f.reason,
      current_balance: f.currentBalance,
    },
  };
}
