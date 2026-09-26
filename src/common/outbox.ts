import { randomBytes } from 'node:crypto';

import type { NotificationKind } from '../infra/db/schema';
import type { Tx } from '../infra/db/db.service';

/**
 * Side effects (push, email, SMS, refunds at Razorpay, live updates, photo processing) are never done inside
 * a request. The request writes an `outbox` row in the SAME transaction as the data change; the worker
 * delivers it and retries on failure. So "money taken but booking not saved" or "patient told but nothing
 * changed" cannot happen.
 */
export type OutboxMessage =
  | { topic: 'notify'; payload: NotifyPayload }
  | { topic: 'refund.start'; payload: { refundId: string } }
  | { topic: 'transfer.reverse'; payload: { transferId: string } }
  | { topic: 'live.publish'; payload: { sessionId: string } }
  | { topic: 'photo.process'; payload: { doctorId: string; uploadKey: string } }
  | { topic: 'bulk.cancel'; payload: { bulkId: string; bookingId: string; reason: string; actorId: string | null } }
  | { topic: 'reminder'; payload: { bookingId: string; windowId: string | null; which: 'day' | 'hour' } }
  | { topic: 'email'; payload: { to: string; subject: string; text: string } }
  | { topic: 'sms'; payload: { to: string; variables: Record<string, string>; text: string } }
  | { topic: 'turn.check'; payload: { sessionId: string } };

export interface NotifyPayload {
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string;
  bookingId?: string | null;
  data?: Record<string, string>;
  /** The setting that can turn this push off (the message still shows in the app). */
  pref?: 'newBookings' | 'bookingChanges' | 'eveningSummary' | 'reminders';
  /** The same key never notifies the same person twice. */
  dedupeKey?: string;
  /** Also send a phone push (respecting the person's settings). Default true. */
  push?: boolean;
}

export type OutboxTopic = OutboxMessage['topic'];

export async function enqueue<M extends OutboxMessage>(
  tx: Tx,
  message: M,
  opts: { dedupeKey?: string; availableAt?: Date } = {},
): Promise<void> {
  await tx
    .insertInto('outbox')
    .values({
      topic: message.topic,
      payload: JSON.stringify(message.payload),
      dedupeKey: opts.dedupeKey ?? null,
      availableAt: opts.availableAt ?? new Date(),
    })
    .onConflict((oc) => oc.column('dedupeKey').doNothing())
    .execute();
}

/** Shorthand for an in-app message + push. */
export const notify = (tx: Tx, payload: NotifyPayload, availableAt?: Date) =>
  enqueue(tx, { topic: 'notify', payload }, { dedupeKey: payload.dedupeKey ? `notify:${payload.userId}:${payload.dedupeKey}` : undefined, availableAt });

/** UUID v7 (time-ordered): made in the app when a row must be referenced before it is inserted. */
export function uuidv7(): string {
  const b = randomBytes(16);
  const ms = BigInt(Date.now());
  b.writeUIntBE(Number(ms >> 16n), 0, 4);
  b.writeUInt16BE(Number(ms & 0xffffn), 4);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
