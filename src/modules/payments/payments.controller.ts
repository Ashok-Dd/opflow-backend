import { Controller, Headers, HttpCode, HttpStatus, Inject, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AuthedRequest, PatientId, Public, Roles } from '../../common/auth/auth.decorators';
import { sha256 } from '../../common/crypto';
import { AppError } from '../../common/errors/app-error';
import { Idempotent } from '../../common/http/idempotency';
import { IdParam, ZBody } from '../../common/http/zod';
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
  ) {}

  /** After Razorpay Checkout succeeds: confirms the booking and returns it (with the token). */
  @Post('payments/verify')
  @Roles('patient')
  @HttpCode(200)
  async verify(@PatientId() userId: string, @ZBody(verifyBody) body: z.output<typeof verifyBody>) {
    const r = await this.payments.verify(userId, { orderId: body.razorpay_order_id, paymentId: body.razorpay_payment_id, signature: body.razorpay_signature });
    return { outcome: r.outcome, booking: await this.bookings.get(userId, r.bookingId) };
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
