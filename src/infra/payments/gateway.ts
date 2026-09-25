import { randomBytes } from 'node:crypto';

import { HttpStatus } from '@nestjs/common';

import { hmacHex, safeEqual } from '../../common/crypto';
import { AppError } from '../../common/errors/app-error';
import type { Env } from '../../config/env';

export interface GatewayOrder {
  id: string;
  amount: number;
  status: string;
}
export type GatewayPaymentStatus = 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
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
export interface LinkedAccountInput {
  referenceId: string;
  name: string;
  email: string;
  phone: string;
  pan: string;
  accountNumber: string;
  ifsc: string;
  address: { street: string; city: string; state: string; pin: string };
}

/**
 * Everything OPflow asks of Razorpay (Orders, Payments, Refunds, Route). Two implementations: the real
 * HTTP one, and a local fake that behaves like test mode (only when APP_ENV=local and no keys are set).
 */
export interface PaymentGateway {
  readonly keyId: string;
  readonly isFake: boolean;
  createOrder(input: { amountPaise: number; receipt: string; notes: Record<string, string> }): Promise<GatewayOrder>;
  fetchPayment(paymentId: string): Promise<GatewayPayment>;
  fetchOrderPayments(orderId: string): Promise<GatewayPayment[]>;
  refund(paymentId: string, amountPaise: number, notes: Record<string, string>): Promise<GatewayRefund>;
  fetchRefund(paymentId: string, refundId: string): Promise<GatewayRefund>;
  transfer(paymentId: string, accountId: string, amountPaise: number, notes: Record<string, string>): Promise<{ id: string }>;
  reverseTransfer(transferId: string, amountPaise: number): Promise<{ id: string }>;
  createLinkedAccount(input: LinkedAccountInput): Promise<{ accountId: string; active: boolean }>;
  fetchLinkedAccountActive(accountId: string): Promise<boolean>;
  verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean;
  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean;
}

export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

export class GatewayError extends AppError {
  constructor(message: string, readonly providerStatus?: number) {
    super('PAYMENTS_UNAVAILABLE', 'Payments are not working right now. No money was taken. Please try again.', HttpStatus.SERVICE_UNAVAILABLE, true);
    this.stack = `${message}\n${this.stack ?? ''}`;
  }
}

// ── Real Razorpay ────────────────────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

export class RazorpayGateway implements PaymentGateway {
  readonly isFake = false;
  private readonly auth: string;

  constructor(private readonly env: Env) {
    this.auth = `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`;
  }

  get keyId(): string {
    return this.env.RAZORPAY_KEY_ID!;
  }

  private async call<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`https://api.razorpay.com${path}`, {
        method,
        headers: { authorization: this.auth, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.env.RAZORPAY_TIMEOUT_MS),
      });
    } catch (err) {
      throw new GatewayError(`Razorpay ${method} ${path} failed: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) throw new GatewayError(`Razorpay ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`, res.status);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async createOrder(input: { amountPaise: number; receipt: string; notes: Record<string, string> }): Promise<GatewayOrder> {
    const o = await this.call<Json>('POST', '/v1/orders', {
      amount: input.amountPaise,
      currency: 'INR',
      receipt: input.receipt,
      notes: input.notes,
      payment_capture: 1,
    });
    return { id: String(o.id), amount: Number(o.amount), status: String(o.status) };
  }

  private toPayment(p: Json): GatewayPayment {
    return {
      id: String(p.id),
      orderId: String(p.order_id ?? ''),
      amount: Number(p.amount),
      status: String(p.status) as GatewayPaymentStatus,
      method: p.method ? String(p.method) : null,
      error: p.error_description ? String(p.error_description) : null,
    };
  }

  async fetchPayment(paymentId: string): Promise<GatewayPayment> {
    return this.toPayment(await this.call('GET', `/v1/payments/${encodeURIComponent(paymentId)}`));
  }

  async fetchOrderPayments(orderId: string): Promise<GatewayPayment[]> {
    const r = await this.call<{ items?: Json[] }>('GET', `/v1/orders/${encodeURIComponent(orderId)}/payments`);
    return (r.items ?? []).map((p) => this.toPayment(p));
  }

  async refund(paymentId: string, amountPaise: number, notes: Record<string, string>): Promise<GatewayRefund> {
    const r = await this.call<Json>('POST', `/v1/payments/${encodeURIComponent(paymentId)}/refund`, {
      amount: amountPaise,
      speed: 'normal',
      notes,
      receipt: notes.refundId,
    });
    return { id: String(r.id), status: String(r.status) as GatewayRefund['status'] };
  }

  async fetchRefund(paymentId: string, refundId: string): Promise<GatewayRefund> {
    const r = await this.call<Json>('GET', `/v1/payments/${encodeURIComponent(paymentId)}/refunds/${encodeURIComponent(refundId)}`);
    return { id: String(r.id), status: String(r.status) as GatewayRefund['status'] };
  }

  async transfer(paymentId: string, accountId: string, amountPaise: number, notes: Record<string, string>): Promise<{ id: string }> {
    const r = await this.call<{ items?: Json[] }>('POST', `/v1/payments/${encodeURIComponent(paymentId)}/transfers`, {
      transfers: [{ account: accountId, amount: amountPaise, currency: 'INR', notes, on_hold: false }],
    });
    const first = r.items?.[0];
    if (!first) throw new GatewayError('Razorpay transfer returned no items');
    return { id: String(first.id) };
  }

  async reverseTransfer(transferId: string, amountPaise: number): Promise<{ id: string }> {
    const r = await this.call<Json>('POST', `/v1/transfers/${encodeURIComponent(transferId)}/reversals`, { amount: amountPaise });
    return { id: String(r.id) };
  }

  async createLinkedAccount(input: LinkedAccountInput): Promise<{ accountId: string; active: boolean }> {
    const account = await this.call<Json>('POST', '/v2/accounts', {
      email: input.email,
      phone: input.phone.replace(/^\+91/, ''),
      type: 'route',
      reference_id: input.referenceId,
      legal_business_name: input.name,
      business_type: 'individual',
      contact_name: input.name,
      profile: {
        category: 'healthcare',
        subcategory: 'doctors',
        addresses: {
          registered: { street1: input.address.street, street2: input.address.city, city: input.address.city, state: input.address.state, postal_code: input.address.pin, country: 'IN' },
        },
      },
      legal_info: { pan: input.pan },
    });
    const id = String(account.id);
    await this.call('POST', `/v2/accounts/${id}/stakeholders`, { name: input.name, email: input.email });
    const product = await this.call<Json>('POST', `/v2/accounts/${id}/products`, { product_name: 'route', tnc_accepted: true });
    const configured = await this.call<Json>('PATCH', `/v2/accounts/${id}/products/${String(product.id)}`, {
      settlements: { account_number: input.accountNumber, ifsc_code: input.ifsc, beneficiary_name: input.name },
      tnc_accepted: true,
    });
    return { accountId: id, active: configured.activation_status === 'activated' };
  }

  async fetchLinkedAccountActive(accountId: string): Promise<boolean> {
    const a = await this.call<Json>('GET', `/v2/accounts/${encodeURIComponent(accountId)}`);
    return a.status === 'activated';
  }

  verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
    return safeEqual(hmacHex(this.env.RAZORPAY_KEY_SECRET!, `${orderId}|${paymentId}`), signature);
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    return safeEqual(hmacHex(this.env.RAZORPAY_WEBHOOK_SECRET!, rawBody), signature);
  }
}

// ── Local fake (APP_ENV=local, no keys) ───────────────────────────────────────────────────────────────

export const FAKE_SECRET = 'opflow-local-fake-razorpay-secret';
export const FAKE_WEBHOOK_SECRET = 'opflow-local-fake-webhook-secret';

/**
 * Behaves like Razorpay test mode, in memory. Payments are "made" through POST /v1/dev/razorpay/pay
 * (the stand-in for Checkout), which returns the same fields Checkout gives the app.
 */
export class FakeRazorpayGateway implements PaymentGateway {
  readonly isFake = true;
  readonly keyId = 'rzp_test_local_fake';
  private readonly orders = new Map<string, GatewayOrder & { payments: string[] }>();
  private readonly payments = new Map<string, GatewayPayment>();
  private readonly refunds = new Map<string, GatewayRefund & { paymentId: string; amount: number }>();
  /** Test hook: make the next createOrder call fail (to test "payments are down"). */
  failNextOrder = false;

  private id(prefix: string): string {
    return `${prefix}_${randomBytes(7).toString('hex')}`;
  }

  async createOrder(input: { amountPaise: number }): Promise<GatewayOrder> {
    if (this.failNextOrder) {
      this.failNextOrder = false;
      throw new GatewayError('Fake gateway: order creation failed on purpose');
    }
    const order = { id: this.id('order'), amount: input.amountPaise, status: 'created', payments: [] as string[] };
    this.orders.set(order.id, order);
    return { id: order.id, amount: order.amount, status: order.status };
  }

  /** What Checkout would return to the app after a successful (or failed) payment. */
  pay(orderId: string, opts: { fail?: boolean; method?: string } = {}): { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string } {
    const order = this.orders.get(orderId);
    if (!order) throw new AppError('NOT_FOUND', 'No such order (fake gateway).', HttpStatus.NOT_FOUND);
    const payment: GatewayPayment = {
      id: this.id('pay'),
      orderId,
      amount: order.amount,
      status: opts.fail ? 'failed' : 'captured',
      method: opts.method ?? 'upi',
      error: opts.fail ? 'Payment failed (fake)' : null,
    };
    this.payments.set(payment.id, payment);
    order.payments.push(payment.id);
    if (!opts.fail) order.status = 'paid';
    return {
      razorpay_order_id: orderId,
      razorpay_payment_id: payment.id,
      razorpay_signature: hmacHex(FAKE_SECRET, `${orderId}|${payment.id}`),
    };
  }

  async fetchPayment(paymentId: string): Promise<GatewayPayment> {
    const p = this.payments.get(paymentId);
    if (!p) throw new GatewayError(`Fake gateway: unknown payment ${paymentId}`, 404);
    return { ...p };
  }

  async fetchOrderPayments(orderId: string): Promise<GatewayPayment[]> {
    return (this.orders.get(orderId)?.payments ?? []).map((id) => ({ ...this.payments.get(id)! }));
  }

  async refund(paymentId: string, amountPaise: number): Promise<GatewayRefund> {
    const p = this.payments.get(paymentId);
    if (!p || p.status !== 'captured') throw new GatewayError(`Fake gateway: cannot refund ${paymentId}`, 400);
    const r = { id: this.id('rfnd'), status: 'processed' as const, paymentId, amount: amountPaise };
    this.refunds.set(r.id, r);
    return { id: r.id, status: r.status };
  }

  async fetchRefund(_paymentId: string, refundId: string): Promise<GatewayRefund> {
    const r = this.refunds.get(refundId);
    return { id: refundId, status: r?.status ?? 'pending' };
  }

  async transfer(): Promise<{ id: string }> {
    return { id: this.id('trf') };
  }

  async reverseTransfer(): Promise<{ id: string }> {
    return { id: this.id('rvrsl') };
  }

  async createLinkedAccount(): Promise<{ accountId: string; active: boolean }> {
    return { accountId: this.id('acc'), active: true };
  }

  async fetchLinkedAccountActive(): Promise<boolean> {
    return true;
  }

  verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
    return safeEqual(hmacHex(FAKE_SECRET, `${orderId}|${paymentId}`), signature);
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
    return safeEqual(hmacHex(FAKE_WEBHOOK_SECRET, rawBody), signature);
  }
}
