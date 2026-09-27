import { createHmac, randomBytes } from 'node:crypto';

import { HttpStatus } from '@nestjs/common';

import { safeEqual } from '../../common/crypto';
import { AppError } from '../../common/errors/app-error';
import type { Env } from '../../config/env';

export interface GatewayOrder {
  id: string;
  amount: number;
  /** What the app's Cashfree checkout opens (`payment_session_id`). */
  sessionId: string;
}
/** Cashfree's payment states, mapped: SUCCESS → captured, PENDING → authorized, NOT_ATTEMPTED → created, the rest → failed. */
export type GatewayPaymentStatus = 'created' | 'authorized' | 'captured' | 'failed';
export interface GatewayPayment {
  id: string;
  orderId: string;
  amount: number;
  status: GatewayPaymentStatus;
  method: string | null;
  error: string | null;
}
export interface GatewayRefund {
  id: string;
  status: 'pending' | 'processed' | 'failed';
}
export interface OrderInput {
  /** Our own order id (letters, digits, - and _; at most 45). */
  orderId: string;
  amountPaise: number;
  customer: { id: string; phone: string };
  /** Web version only: where Cashfree sends the browser after the bank / UPI page. */
  returnUrl?: string;
  note: string;
  expiresAt: Date;
}

/**
 * Everything OPflow asks of the Cashfree Payment Gateway (orders, their payments, refunds, webhook signatures).
 * Two implementations: the real HTTP one, and a local fake that behaves like sandbox mode (only when
 * APP_ENV=local and no keys are set). Amounts are paise everywhere in OPflow; rupees only inside this file.
 */
export interface PaymentGateway {
  readonly environment: 'sandbox' | 'production';
  readonly isFake: boolean;
  createOrder(input: OrderInput): Promise<GatewayOrder>;
  fetchOrderPayments(orderId: string): Promise<GatewayPayment[]>;
  /** `refundId` is ours (the same id every retry, so Cashfree never refunds twice). */
  refund(orderId: string, refundId: string, amountPaise: number, note: string): Promise<GatewayRefund>;
  fetchRefund(orderId: string, refundId: string): Promise<GatewayRefund>;
  verifyWebhookSignature(rawBody: Buffer, signature: string, timestamp: string): boolean;
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

export class GatewayError extends AppError {
  constructor(message: string, readonly providerStatus?: number) {
    super('PAYMENTS_UNAVAILABLE', 'Payments are not working right now. No money was taken. Please try again.', HttpStatus.SERVICE_UNAVAILABLE, true);
    this.stack = `${message}\n${this.stack ?? ''}`;
  }
}

/** Paise ↔ rupees, only at the Cashfree boundary. */
export const toRupees = (paise: number): number => Math.round(paise) / 100;
export const toPaise = (rupees: unknown): number => Math.round(Number(rupees) * 100);

/** Cashfree's webhook signature: base64(HMAC-SHA256(timestamp + raw body, secret)). */
export function webhookSignature(secret: string, timestamp: string, rawBody: Buffer): string {
  return createHmac('sha256', secret).update(Buffer.concat([Buffer.from(timestamp, 'utf8'), rawBody])).digest('base64');
}

/** An id Cashfree accepts (letters, digits, _ and -): a UUID without dashes, with a short prefix. */
export const cashfreeId = (prefix: string, uuid: string): string => `${prefix}_${uuid.replace(/-/g, '')}`;

export function mapPaymentStatus(s: unknown): GatewayPaymentStatus {
  switch (String(s ?? '').toUpperCase()) {
    case 'SUCCESS':
      return 'captured';
    case 'PENDING':
      return 'authorized';
    case 'NOT_ATTEMPTED':
      return 'created';
    default:
      return 'failed'; // FAILED, USER_DROPPED, CANCELLED, VOID, FLAGGED
  }
}

export function mapRefundStatus(s: unknown): GatewayRefund['status'] {
  const v = String(s ?? '').toUpperCase();
  if (v === 'SUCCESS') return 'processed';
  if (v === 'CANCELLED' || v === 'REJECTED' || v === 'FAILED') return 'failed';
  return 'pending'; // PENDING, ONHOLD, PENDING_APPROVAL
}

// ── Real Cashfree ────────────────────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

export class CashfreeGateway implements PaymentGateway {
  readonly isFake = false;
  readonly environment: 'sandbox' | 'production';
  private readonly base: string;

  constructor(private readonly env: Env) {
    this.environment = env.CASHFREE_ENV;
    this.base = env.CASHFREE_ENV === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
  }

  private async call<T = Json>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          'x-client-id': this.env.CASHFREE_CLIENT_ID!,
          'x-client-secret': this.env.CASHFREE_CLIENT_SECRET!,
          'x-api-version': this.env.CASHFREE_API_VERSION,
          'content-type': 'application/json',
          ...(idempotencyKey ? { 'x-idempotency-key': idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.env.CASHFREE_TIMEOUT_MS),
      });
    } catch (err) {
      throw new GatewayError(`Cashfree ${method} ${path} failed: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) throw new GatewayError(`Cashfree ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`, res.status);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async createOrder(input: OrderInput): Promise<GatewayOrder> {
    const o = await this.call<Json>('POST', '/orders', {
      order_id: input.orderId,
      order_amount: toRupees(input.amountPaise),
      order_currency: 'INR',
      order_note: input.note.slice(0, 200),
      order_expiry_time: input.expiresAt.toISOString(),
      customer_details: { customer_id: input.customer.id, customer_phone: input.customer.phone },
      order_meta: input.returnUrl ? { return_url: input.returnUrl } : undefined,
    });
    return { id: String(o.order_id), amount: toPaise(o.order_amount), sessionId: String(o.payment_session_id) };
  }

  async fetchOrderPayments(orderId: string): Promise<GatewayPayment[]> {
    const list = await this.call<Json[]>('GET', `/orders/${encodeURIComponent(orderId)}/payments`);
    return (Array.isArray(list) ? list : []).map((p) => ({
      id: String(p.cf_payment_id),
      orderId: String(p.order_id ?? orderId),
      amount: toPaise(p.payment_amount),
      status: mapPaymentStatus(p.payment_status),
      method: p.payment_group ? String(p.payment_group).slice(0, 20) : null,
      error: p.payment_message && mapPaymentStatus(p.payment_status) === 'failed' ? String(p.payment_message) : null,
    }));
  }

  async refund(orderId: string, refundId: string, amountPaise: number, note: string): Promise<GatewayRefund> {
    const r = await this.call<Json>(
      'POST',
      `/orders/${encodeURIComponent(orderId)}/refunds`,
      { refund_amount: toRupees(amountPaise), refund_id: refundId, refund_note: note.slice(0, 100), refund_speed: 'STANDARD' },
      refundId,
    );
    return { id: String(r.refund_id ?? refundId), status: mapRefundStatus(r.refund_status) };
  }

  async fetchRefund(orderId: string, refundId: string): Promise<GatewayRefund> {
    const r = await this.call<Json>('GET', `/orders/${encodeURIComponent(orderId)}/refunds/${encodeURIComponent(refundId)}`);
    return { id: refundId, status: mapRefundStatus(r.refund_status) };
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string, timestamp: string): boolean {
    return safeEqual(webhookSignature(this.env.CASHFREE_CLIENT_SECRET!, timestamp, rawBody), signature);
  }
}

// ── Local fake (APP_ENV=local, no keys) ───────────────────────────────────────────────────────────────

export const FAKE_WEBHOOK_SECRET = 'opflow-local-fake-cashfree-secret';

/**
 * Behaves like Cashfree sandbox, in memory. Payments are "made" through POST /v1/dev/cashfree/pay (the
 * stand-in for the checkout page); the app then asks the server, exactly as with the real checkout.
 */
export class FakeCashfreeGateway implements PaymentGateway {
  readonly isFake = true;
  readonly environment = 'sandbox' as const;
  private readonly orders = new Map<string, { id: string; amount: number; payments: string[] }>();
  private readonly payments = new Map<string, GatewayPayment>();
  private readonly refunds = new Map<string, GatewayRefund & { orderId: string; amount: number }>();
  /** Test hook: make the next createOrder call fail (to test "payments are down"). */
  failNextOrder = false;

  async createOrder(input: OrderInput): Promise<GatewayOrder> {
    if (this.failNextOrder) {
      this.failNextOrder = false;
      throw new GatewayError('Fake gateway: order creation failed on purpose');
    }
    if (this.orders.has(input.orderId)) throw new GatewayError(`Fake gateway: order ${input.orderId} already exists`, 409);
    this.orders.set(input.orderId, { id: input.orderId, amount: input.amountPaise, payments: [] });
    return { id: input.orderId, amount: input.amountPaise, sessionId: `session_fake_${randomBytes(8).toString('hex')}` };
  }

  /** What the checkout page does: one attempt at paying the order (success, or a failure). */
  pay(orderId: string, opts: { fail?: boolean; method?: string } = {}): { orderId: string; paymentId: string; status: GatewayPaymentStatus } {
    const order = this.orders.get(orderId);
    if (!order) throw new AppError('NOT_FOUND', 'No such order (fake gateway).', HttpStatus.NOT_FOUND);
    const payment: GatewayPayment = {
      id: String(5_000_000_000 + this.payments.size + 1),
      orderId,
      amount: order.amount,
      status: opts.fail ? 'failed' : 'captured',
      method: opts.method ?? 'upi',
      error: opts.fail ? 'Payment failed (fake)' : null,
    };
    this.payments.set(payment.id, payment);
    order.payments.push(payment.id);
    return { orderId, paymentId: payment.id, status: payment.status };
  }

  async fetchOrderPayments(orderId: string): Promise<GatewayPayment[]> {
    return (this.orders.get(orderId)?.payments ?? []).map((id) => ({ ...this.payments.get(id)! }));
  }

  async refund(orderId: string, refundId: string, amountPaise: number): Promise<GatewayRefund> {
    const prior = this.refunds.get(refundId);
    if (prior) return { id: prior.id, status: prior.status };
    const paid = (this.orders.get(orderId)?.payments ?? []).some((id) => this.payments.get(id)?.status === 'captured');
    if (!paid) throw new GatewayError(`Fake gateway: order ${orderId} has no successful payment to refund`, 400);
    const r = { id: refundId, status: 'processed' as const, orderId, amount: amountPaise };
    this.refunds.set(refundId, r);
    return { id: r.id, status: r.status };
  }

  async fetchRefund(_orderId: string, refundId: string): Promise<GatewayRefund> {
    return { id: refundId, status: this.refunds.get(refundId)?.status ?? 'pending' };
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string, timestamp: string): boolean {
    return safeEqual(webhookSignature(FAKE_WEBHOOK_SECRET, timestamp, rawBody), signature);
  }
}
