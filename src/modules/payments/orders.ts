import { randomUUID } from 'node:crypto';

import { HttpStatus } from '@nestjs/common';
import { z } from 'zod';

import { AppError } from '../../common/errors/app-error';
import { money } from '../../common/money';
import type { Env } from '../../config/env';
import type { DbService } from '../../infra/db/db.service';
import { cashfreeId, GatewayOrder, PaymentGateway } from '../../infra/payments/gateway';

/** The web app's own address (for Cashfree's return link); ignored unless it is one of OPflow's (CORS_ORIGINS). */
export const zReturnTo = z.string().url().max(200).optional();

/** Cashfree keeps an order open at least 15 minutes; OPflow's own hold (10 min) still decides the place. */
const ORDER_MINUTES = 20;

/**
 * Opens a Cashfree order for a patient (a booking or a ₹99 suggestion). The phone number is required by
 * Cashfree; `returnTo` (the web app's own address) makes the web version come back after the bank page.
 */
export async function openGatewayOrder(
  deps: { gateway: PaymentGateway; dbs: DbService; env: Env },
  input: { userId: string; amountPaise: number; note: string; returnTo?: string; back: { key: 'b' | 'p'; id: string } },
): Promise<GatewayOrder> {
  const user = await deps.dbs.system((tx) => tx.selectFrom('users').select(['phone']).where('id', '=', input.userId).executeTakeFirst());
  const phone = (user?.phone ?? '').replace(/^\+91/, '');
  if (!/^[6-9][0-9]{9}$/.test(phone)) {
    throw new AppError('PHONE_NEEDED', 'Please add your mobile number in Me → My details before paying.', HttpStatus.CONFLICT);
  }
  return deps.gateway.createOrder({
    orderId: cashfreeId('op', randomUUID()),
    amountPaise: input.amountPaise,
    customer: { id: cashfreeId('u', input.userId), phone },
    returnUrl: returnUrl(deps.env, input.returnTo, input.back),
    note: input.note,
    expiresAt: new Date(Date.now() + ORDER_MINUTES * 60_000),
  });
}

/** Only OPflow's own web addresses (CORS_ORIGINS); anything else means "no redirect" (the phone app). */
function returnUrl(env: Env, to: string | undefined, back: { key: 'b' | 'p'; id: string }): string | undefined {
  const origin = to?.replace(/\/$/, '');
  if (!origin || !env.CORS_ORIGINS.includes(origin)) return undefined;
  const api = env.API_PUBLIC_URL.replace(/\/$/, '');
  // {order_id} is filled in by Cashfree.
  return `${api}/v1/payments/return?${back.key}=${back.id}&to=${encodeURIComponent(origin)}&order_id={order_id}`;
}

/** What the app needs to open Cashfree's checkout. */
export function checkoutFor(gateway: PaymentGateway, order: GatewayOrder, amountPaise: number) {
  return {
    orderId: order.id,
    paymentSessionId: order.sessionId,
    environment: gateway.environment,
    amount: money(amountPaise),
    currency: 'INR',
    fake: gateway.isFake,
  };
}
