import { HttpStatus } from '@nestjs/common';
import { sql } from 'kysely';

import { AppError } from '../../common/errors/app-error';
import type { SessionStatus } from '../../infra/db/schema';
import type { Tx } from '../../infra/db/db.service';

export interface LockedSession {
  id: string;
  doctorId: string;
  hospitalId: string;
  date: string;
  startsAt: Date;
  endsAt: Date;
  status: SessionStatus;
  version: number;
  lateMinutes: number;
  avgConsultSec: number;
  nowSeeingToken: number | null;
  nextEmergencyToken: number;
  closeMinutesBefore: number;
}

/**
 * Locks an OPD session row. Every flow that changes a line takes this lock FIRST (then booking, then slot,
 * then payment), so two taps, two devices, or a payment landing while the doctor presses "Next" are applied
 * one after another, and never deadlock.
 */
export async function lockSession(tx: Tx, sessionId: string): Promise<LockedSession> {
  const s = await tx
    .selectFrom('opdSessions')
    .select(['id', 'doctorId', 'hospitalId', 'date', 'startsAt', 'endsAt', 'status', 'version', 'lateMinutes', 'avgConsultSec', 'nowSeeingToken', 'nextEmergencyToken', 'closeMinutesBefore'])
    .where('id', '=', sessionId)
    .forUpdate()
    .executeTakeFirst();
  if (!s) throw new AppError('SESSION_NOT_FOUND', 'We could not find this OPD.', HttpStatus.NOT_FOUND);
  return s as LockedSession;
}

/** Locks several sessions in a fixed order (by id), for flows that touch two (reschedule). */
export async function lockSessions(tx: Tx, ids: string[]): Promise<Map<string, LockedSession>> {
  const out = new Map<string, LockedSession>();
  for (const id of [...new Set(ids)].sort()) out.set(id, await lockSession(tx, id));
  return out;
}

/**
 * Records one change to a line: version + 1 and a queue_events row with that version (unique per session),
 * so phones can detect a gap (v41 → v43) and replay what they missed. Call with the session already locked.
 */
export async function bumpSession(
  tx: Tx,
  sessionId: string,
  type: string,
  opts: { bookingId?: string | null; actorId?: string | null; data?: Record<string, unknown> } = {},
): Promise<number> {
  const r = await sql<{ version: number }>`
    update opd_sessions set version = version + 1 where id = ${sessionId} returning version`.execute(tx);
  const version = r.rows[0]!.version;
  await tx
    .insertInto('queueEvents')
    .values({ sessionId, version, type, bookingId: opts.bookingId ?? null, actorId: opts.actorId ?? null, data: JSON.stringify(opts.data ?? {}) })
    .execute();
  return version;
}

/** Order in the line: normal bookings by token; emergencies (E1, E2…) before everyone, in their own order. */
export const orderKeyFor = (source: 'online' | 'emergency' | 'direct', token: number): number =>
  source === 'emergency' ? -1000 + token : token;

export const tokenLabel = (source: string, token: number): string => (source === 'emergency' ? `E${token}` : String(token).padStart(2, '0'));
