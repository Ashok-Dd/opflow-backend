import { constants, createHmac, publicEncrypt, randomBytes } from 'node:crypto';

import { HttpStatus } from '@nestjs/common';

import { safeEqual } from '../../common/crypto';
import { AppError } from '../../common/errors/app-error';
import type { Env } from '../../config/env';
import { toPaise, toRupees, webhookSignature } from './gateway';

export interface BeneficiaryInput {
  /** Ours: letters, digits, _ (at most 50). A new id is used whenever the bank details change. */
  id: string;
  name: string;
  accountNumber: string;
  ifsc: string;
  phone: string | null;
  email: string | null;
}
export type BeneficiaryStatus = 'active' | 'pending' | 'invalid';
export type PayoutTransferStatus = 'pending' | 'success' | 'failed';
export interface PayoutTransfer {
  cfTransferId: string | null;
  status: PayoutTransferStatus;
  utr: string | null;
  reason: string | null;
}

/**
 * The doctor's 90% goes out through Cashfree Payouts: one bank transfer per doctor per run. Calls are signed
 * with Cashfree's public key ("2FA: public key"), so the server's IP address does not need to be whitelisted.
 */
export interface PayoutsProvider {
  readonly isFake: boolean;
  createBeneficiary(input: BeneficiaryInput): Promise<BeneficiaryStatus>;
  beneficiaryStatus(id: string): Promise<BeneficiaryStatus>;
  /** `transferId` is ours (the payout row), so a retry never pays twice. */
  transfer(transferId: string, beneficiaryId: string, amountPaise: number, remarks: string): Promise<PayoutTransfer>;
  transferStatus(transferId: string): Promise<PayoutTransfer>;
  verifyWebhookSignature(rawBody: Buffer, signature: string, timestamp: string): boolean;
  /** Payouts "V1" webhooks (and low-balance alerts): the signature is a field of the body itself. */
  verifyV1Signature(fields: Record<string, string>): boolean;
}

/** V1: base64(HMAC-SHA256(the other fields' values, sorted by field name, joined, secret)). */
export function v1Signature(secret: string, fields: Record<string, string>): string {
  const data = Object.keys(fields).filter((k) => k !== 'signature').sort().map((k) => fields[k]).join('');
  return createHmac('sha256', secret).update(data).digest('base64');
}

export const PAYOUTS = Symbol('PAYOUTS');

export class PayoutsError extends AppError {
  constructor(message: string, readonly providerStatus?: number, readonly providerCode?: string) {
    super('PAYOUTS_UNAVAILABLE', 'Bank payouts are not working right now. Please try again later.', HttpStatus.SERVICE_UNAVAILABLE, true);
    this.stack = `${message}\n${this.stack ?? ''}`;
  }
}

export function mapTransferStatus(s: unknown): PayoutTransferStatus {
  const v = String(s ?? '').toUpperCase();
  if (v === 'SUCCESS') return 'success';
  if (v === 'FAILED' || v === 'REJECTED' || v === 'REVERSED') return 'failed';
  return 'pending'; // RECEIVED, QUEUED, PENDING, APPROVAL_PENDING, VALIDATION_PENDING
}

function mapBeneficiaryStatus(s: unknown): BeneficiaryStatus {
  const v = String(s ?? '').toUpperCase();
  if (v === 'VERIFIED') return 'active';
  if (v === 'INVALID' || v === 'FAILED' || v === 'CANCELLED') return 'invalid';
  return 'pending'; // INITIATED
}

type Json = Record<string, unknown>;

export class CashfreePayouts implements PayoutsProvider {
  readonly isFake = false;
  private readonly base: string;
  private readonly publicKey: string;

  constructor(private readonly env: Env) {
    this.base = env.CASHFREE_ENV === 'production' ? 'https://api.cashfree.com/payout' : 'https://sandbox.cashfree.com/payout';
    this.publicKey = Buffer.from(env.CASHFREE_PAYOUT_PUBLIC_KEY_B64!, 'base64').toString('utf8');
  }

  /** base64(RSA-OAEP(public key, "<client id>.<unix seconds>")), sent as x-cf-signature. */
  private signature(): string {
    const plain = `${this.env.CASHFREE_PAYOUT_CLIENT_ID}.${Math.floor(Date.now() / 1000)}`;
    return publicEncrypt({ key: this.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(plain)).toString('base64');
  }

  private async call<T = Json>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          'x-client-id': this.env.CASHFREE_PAYOUT_CLIENT_ID!,
          'x-client-secret': this.env.CASHFREE_PAYOUT_CLIENT_SECRET!,
          'x-api-version': this.env.CASHFREE_PAYOUT_API_VERSION,
          'x-cf-signature': this.signature(),
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.env.CASHFREE_TIMEOUT_MS),
      });
    } catch (err) {
      throw new PayoutsError(`Cashfree Payouts ${method} ${path} failed: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) {
      let code: string | undefined;
      try {
        code = String((JSON.parse(text) as Json).code ?? '');
      } catch {
        code = undefined;
      }
      throw new PayoutsError(`Cashfree Payouts ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`, res.status, code);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async createBeneficiary(b: BeneficiaryInput): Promise<BeneficiaryStatus> {
    const r = await this.call<Json>('POST', '/beneficiary', {
      beneficiary_id: b.id,
      beneficiary_name: b.name.slice(0, 100),
      beneficiary_instrument_details: { bank_account_number: b.accountNumber, bank_ifsc: b.ifsc },
      beneficiary_contact_details: {
        ...(b.email ? { beneficiary_email: b.email } : {}),
        ...(b.phone ? { beneficiary_phone: b.phone.replace(/^\+91/, ''), beneficiary_country_code: '+91' } : {}),
      },
    });
    return mapBeneficiaryStatus(r.beneficiary_status);
  }

  async beneficiaryStatus(id: string): Promise<BeneficiaryStatus> {
    const r = await this.call<Json>('GET', `/beneficiary?beneficiary_id=${encodeURIComponent(id)}`);
    return mapBeneficiaryStatus(r.beneficiary_status);
  }

  private toTransfer(r: Json): PayoutTransfer {
    const status = mapTransferStatus(r.status);
    return {
      cfTransferId: r.cf_transfer_id ? String(r.cf_transfer_id) : null,
      status,
      utr: r.transfer_utr ? String(r.transfer_utr) : null,
      reason: status === 'failed' ? String(r.status_description ?? r.status_code ?? 'Refused by the bank') : null,
    };
  }

  async transfer(transferId: string, beneficiaryId: string, amountPaise: number, remarks: string): Promise<PayoutTransfer> {
    try {
      return this.toTransfer(
        await this.call<Json>('POST', '/transfers', {
          transfer_id: transferId,
          transfer_amount: toRupees(amountPaise),
          transfer_currency: 'INR',
          transfer_mode: 'banktransfer',
          beneficiary_details: { beneficiary_id: beneficiaryId },
          transfer_remarks: remarks.replace(/[^A-Za-z0-9 ]/g, ' ').slice(0, 70),
        }),
      );
    } catch (err) {
      // Sent before (a retry after a timeout): read its status instead of paying again.
      if (err instanceof PayoutsError && err.providerStatus === 409) return this.transferStatus(transferId);
      throw err;
    }
  }

  async transferStatus(transferId: string): Promise<PayoutTransfer> {
    return this.toTransfer(await this.call<Json>('GET', `/transfers?transfer_id=${encodeURIComponent(transferId)}`));
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string, timestamp: string): boolean {
    return safeEqual(webhookSignature(this.env.CASHFREE_PAYOUT_CLIENT_SECRET!, timestamp, rawBody), signature);
  }

  verifyV1Signature(fields: Record<string, string>): boolean {
    return !!fields.signature && safeEqual(v1Signature(this.env.CASHFREE_PAYOUT_CLIENT_SECRET!, fields), fields.signature);
  }
}

// ── Local fake ─────────────────────────────────────────────────────────────────────────────────────

export const FAKE_PAYOUT_WEBHOOK_SECRET = 'opflow-local-fake-payout-secret';

/** In memory, like Payouts sandbox. Transfers succeed at once unless `failNext` is set (test hook). */
export class FakePayouts implements PayoutsProvider {
  readonly isFake = true;
  private readonly beneficiaries = new Map<string, BeneficiaryInput>();
  private readonly transfers = new Map<string, PayoutTransfer & { amount: number; beneficiaryId: string }>();
  failNext = false;
  /** Test hook: transfers stay "pending" until a webhook or a status check settles them. */
  holdTransfers = false;

  async createBeneficiary(b: BeneficiaryInput): Promise<BeneficiaryStatus> {
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(b.ifsc)) return 'invalid';
    this.beneficiaries.set(b.id, b);
    return 'active';
  }

  async beneficiaryStatus(id: string): Promise<BeneficiaryStatus> {
    return this.beneficiaries.has(id) ? 'active' : 'invalid';
  }

  async transfer(transferId: string, beneficiaryId: string, amountPaise: number): Promise<PayoutTransfer> {
    const prior = this.transfers.get(transferId);
    if (prior) return { cfTransferId: prior.cfTransferId, status: prior.status, utr: prior.utr, reason: prior.reason };
    if (!this.beneficiaries.has(beneficiaryId)) throw new PayoutsError(`Fake payouts: unknown beneficiary ${beneficiaryId}`, 404, 'beneficiary_not_found');
    const fail = this.failNext;
    this.failNext = false;
    const t = {
      cfTransferId: String(7_000_000 + this.transfers.size + 1),
      status: (fail ? 'failed' : this.holdTransfers ? 'pending' : 'success') as PayoutTransferStatus,
      utr: fail || this.holdTransfers ? null : `FAKEUTR${randomBytes(5).toString('hex').toUpperCase()}`,
      reason: fail ? 'Beneficiary bank offline (fake)' : null,
      amount: toPaise(toRupees(amountPaise)),
      beneficiaryId,
    };
    this.transfers.set(transferId, t);
    return { cfTransferId: t.cfTransferId, status: t.status, utr: t.utr, reason: t.reason };
  }

  async transferStatus(transferId: string): Promise<PayoutTransfer> {
    const t = this.transfers.get(transferId);
    if (!t) throw new PayoutsError(`Fake payouts: unknown transfer ${transferId}`, 404, 'transfer_not_found');
    return { cfTransferId: t.cfTransferId, status: t.status, utr: t.utr, reason: t.reason };
  }

  verifyWebhookSignature(rawBody: Buffer, signature: string, timestamp: string): boolean {
    return safeEqual(webhookSignature(FAKE_PAYOUT_WEBHOOK_SECRET, timestamp, rawBody), signature);
  }

  verifyV1Signature(fields: Record<string, string>): boolean {
    return !!fields.signature && safeEqual(v1Signature(FAKE_PAYOUT_WEBHOOK_SECRET, fields), fields.signature);
  }
}
