import { HttpStatus, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AppError } from '../../common/errors/app-error';
import { enqueue, notify } from '../../common/outbox';
import { istClock, istRange } from '../../common/time';
import { LiveBus } from '../../infra/bus/live-bus';
import { DbService, Tx } from '../../infra/db/db.service';
import { RulesService } from '../../infra/rules/rules.service';
import { BookingsService } from '../bookings/bookings.service';
import { bumpSession, LockedSession, lockSession, tokenLabel } from './session-events';

export interface LineEntry {
  bookingId: string;
  token: number;
  source: string;
  state: string;
  orderKey: number;
  patientName: string;
  patientAge: number | null;
  patientGender: string | null;
  patientUserId: string | null;
  note: string;
  reachedAt: Date | null;
  calledAt: Date | null;
  doneAt: Date | null;
  windowStartsAt: Date | null;
  windowEndsAt: Date | null;
  rescheduled: boolean;
}

export interface SessionHead {
  id: string;
  doctorId: string;
  hospitalId: string;
  hospitalName: string;
  date: string;
  startsAt: Date;
  endsAt: Date;
  status: string;
  version: number;
  lateMinutes: number;
  avgConsultSec: number;
  nowSeeingToken: number | null;
}

export type Command =
  | 'start' | 'pause' | 'resume' | 'late' | 'end'
  | 'call-next' | 'done' | 'did-not-come' | 'skip' | 'call-now' | 'mark-reached' | 'put-back';

/** Commands that depend on who is where in the line: refused if the doctor's screen is out of date. */
const POSITION: Command[] = ['call-next', 'done', 'skip', 'call-now'];
const OPEN_STATES = ['not_come', 'waiting', 'with_doctor'];

/** Pure: "N people before you" and a time range, computed on the server (phones never get the whole list). */
export function patientBoard(head: SessionHead, entries: LineEntry[], bookingId: string, now = Date.now()) {
  const me = entries.find((e) => e.bookingId === bookingId);
  const current = entries.find((e) => e.state === 'with_doctor');
  const ahead = me && ['not_come', 'waiting'].includes(me.state)
    ? entries.filter((e) => ['waiting', 'not_come'].includes(e.state) && e.orderKey < me.orderKey).length + (current ? 1 : 0)
    : 0;
  const avgMin = head.avgConsultSec / 60;
  const running = head.status === 'running' || head.status === 'paused';
  let eta: { lowMinutes: number; highMinutes: number; label: string } | null = null;
  if (me && ['not_come', 'waiting'].includes(me.state)) {
    const untilStart = running ? 0 : Math.max(0, (new Date(head.startsAt).getTime() - now) / 60_000);
    const low = Math.round(untilStart + ahead * avgMin * 0.8 + head.lateMinutes);
    const high = Math.round(untilStart + ahead * avgMin * 1.2 + head.lateMinutes + 5);
    eta = { lowMinutes: low, highMinutes: high, label: high <= 5 ? 'Very soon' : `About ${low} – ${high} min` };
  }
  return {
    sessionId: head.id,
    version: head.version,
    status: head.status,
    onBreak: head.status === 'paused',
    lateMinutes: head.lateMinutes,
    nowSeeing: current ? tokenLabel(current.source, current.token) : null,
    myToken: me ? tokenLabel(me.source, me.token) : null,
    myState: me?.state ?? null,
    ahead,
    eta,
    message:
      !me ? null
      : me.state === 'with_doctor' ? 'Please go in now.'
      : me.state === 'done' ? 'Your visit is done.'
      : me.state === 'did_not_come' ? 'You were marked as not come. Please tell the hospital desk.'
      : head.status === 'paused' ? 'The doctor is on a short break.'
      : head.status === 'scheduled' ? `OPD starts at ${istClock(new Date(head.startsAt))}${head.lateMinutes ? `, running ${head.lateMinutes} min late` : ''}.`
      : ahead === 0 ? 'You are next.'
      : `${ahead} ${ahead === 1 ? 'person' : 'people'} before you.`,
  };
}

/** Pure: the doctor's full line. */
export function doctorLine(head: SessionHead, entries: LineEntry[]) {
  const count = (s: string) => entries.filter((e) => e.state === s).length;
  const current = entries.find((e) => e.state === 'with_doctor');
  return {
    sessionId: head.id,
    version: head.version,
    status: head.status,
    onBreak: head.status === 'paused',
    date: head.date,
    hospital: { id: head.hospitalId, name: head.hospitalName },
    time: { startsAt: head.startsAt, endsAt: head.endsAt, label: istRange(new Date(head.startsAt), new Date(head.endsAt)) },
    lateMinutes: head.lateMinutes,
    avgConsultMinutes: Math.round(head.avgConsultSec / 6) / 10,
    nowSeeing: current ? { bookingId: current.bookingId, tokenLabel: tokenLabel(current.source, current.token), name: current.patientName } : null,
    counts: {
      total: entries.filter((e) => !['cancelled', 'moved'].includes(e.state)).length,
      waiting: count('waiting'),
      notCome: count('not_come'),
      withDoctor: count('with_doctor'),
      done: count('done'),
      didNotCome: count('did_not_come'),
      emergency: entries.filter((e) => e.source === 'emergency' && !['cancelled'].includes(e.state)).length,
    },
    line: entries.map((e) => ({
      bookingId: e.bookingId,
      token: e.token,
      tokenLabel: tokenLabel(e.source, e.token),
      emergency: e.source === 'emergency',
      state: e.state,
      name: e.patientName,
      age: e.patientAge,
      gender: e.patientGender,
      note: e.note,
      hour: e.windowStartsAt && e.windowEndsAt ? istRange(new Date(e.windowStartsAt), new Date(e.windowEndsAt)) : null,
      startsAt: e.windowStartsAt,
      reachedAt: e.reachedAt,
      calledAt: e.calledAt,
      doneAt: e.doneAt,
      changed: e.rescheduled,
    })),
  };
}

/**
 * The live line: the doctor's console commands and the boards phones see. Every command locks the session
 * row first, so two taps (or two devices) are applied strictly one after another.
 */
@Injectable()
export class LiveService {
  constructor(
    private readonly dbs: DbService,
    private readonly bus: LiveBus,
    private readonly rules: RulesService,
    private readonly bookings: BookingsService,
  ) {}

  async load(tx: Tx | undefined, sessionId: string): Promise<{ head: SessionHead; entries: LineEntry[] }> {
    const run = async (t: Tx) => {
      const head = await sql<SessionHead>`
        select s.id, s.doctor_id, s.hospital_id, h.name as hospital_name, s.date, s.starts_at, s.ends_at, s.status, s.version,
               s.late_minutes, s.avg_consult_sec, s.now_seeing_token
          from opd_sessions s join hospitals h on h.id = s.hospital_id where s.id = ${sessionId}`.execute(t);
      if (!head.rows[0]) throw new AppError('SESSION_NOT_FOUND', 'We could not find this OPD.', HttpStatus.NOT_FOUND);
      const entries = await sql<LineEntry>`
        select q.booking_id, b.token, b.source, q.state, q.order_key::float8 as order_key, b.patient_name, b.patient_age, b.patient_gender,
               b.patient_user_id, b.note, q.reached_at, q.called_at, q.done_at, w.starts_at as window_starts_at, w.ends_at as window_ends_at,
               b.reschedule_count > 0 as rescheduled
          from queue_entries q join bookings b on b.id = q.booking_id left join opd_windows w on w.id = b.window_id
         where q.session_id = ${sessionId}
         order by case q.state when 'with_doctor' then 0 when 'waiting' then 1 when 'not_come' then 1 when 'done' then 3 else 4 end, q.order_key`.execute(t);
      return { head: head.rows[0], entries: entries.rows };
    };
    return tx ? run(tx) : this.dbs.system(run);
  }

  /** Patient: their own board for a session they have a booking in. */
  async patientView(userId: string, sessionId: string, since?: number) {
    const mine = await this.dbs.as({ role: 'patient', userId }, (tx) =>
      tx.selectFrom('bookings').select(['id']).where('sessionId', '=', sessionId).where('patientUserId', '=', userId).where('status', 'in', ['confirmed', 'completed', 'no_show']).executeTakeFirst(),
    );
    if (!mine) throw new AppError('SESSION_NOT_FOUND', 'We could not find this OPD.', HttpStatus.NOT_FOUND);
    const { head, entries } = await this.load(undefined, sessionId);
    return { ...patientBoard(head, entries, mine.id), changedSince: since !== undefined ? head.version !== since : true };
  }

  /** Doctor: the full line of their own session. */
  async doctorView(doctorId: string, sessionId: string) {
    const { head, entries } = await this.load(undefined, sessionId);
    if (head.doctorId !== doctorId) throw new AppError('SESSION_NOT_FOUND', 'We could not find this OPD.', HttpStatus.NOT_FOUND);
    return doctorLine(head, entries);
  }

  async command(
    doctor: { userId: string; doctorId: string },
    sessionId: string,
    cmd: Command,
    input: { expectedVersion?: number; bookingId?: string; minutes?: number; leftovers?: 'move' | 'cancel'; reason?: string },
  ) {
    const publishes: { sessionId: string; version: number }[] = [];
    const result = await this.dbs.as({ role: 'doctor', userId: doctor.userId, doctorId: doctor.doctorId }, async (tx) => {
      const s = await lockSession(tx, sessionId);
      if (s.doctorId !== doctor.doctorId) throw new AppError('SESSION_NOT_FOUND', 'We could not find this OPD.', HttpStatus.NOT_FOUND);
      if (s.status === 'ended' || s.status === 'cancelled') {
        throw new AppError('OPD_ENDED', 'This OPD has ended.', HttpStatus.CONFLICT);
      }
      if (POSITION.includes(cmd) && input.expectedVersion !== undefined && input.expectedVersion !== s.version) {
        const fresh = await this.load(tx, sessionId);
        throw new AppError('STALE_BOARD', 'The line changed. Please check it again.', HttpStatus.CONFLICT, false, { board: doctorLine(fresh.head, fresh.entries) });
      }
      const actor = doctor.userId;
      const entry = async (bookingId?: string) => {
        if (!bookingId) throw new AppError('INVALID_INPUT', 'Please choose a patient.', HttpStatus.BAD_REQUEST);
        const e = await tx.selectFrom('queueEntries').select(['bookingId', 'state', 'calledAt']).where('bookingId', '=', bookingId).where('sessionId', '=', sessionId).forUpdate().executeTakeFirst();
        if (!e) throw new AppError('NOT_IN_LINE', 'This patient is not in this line.', HttpStatus.NOT_FOUND);
        return e;
      };
      const maxOrder = async () => {
        const r = await sql<{ m: number }>`select coalesce(max(order_key), 0)::float8 as m from queue_entries where session_id = ${sessionId}`.execute(tx);
        return Math.floor(r.rows[0]!.m) + 1;
      };
      const ensureRunning = async () => {
        if (s.status === 'scheduled') {
          await tx.updateTable('opdSessions').set({ status: 'running', startedAt: new Date() }).where('id', '=', sessionId).execute();
          s.status = 'running';
          // However the OPD starts ("Start" or straight to "Call next"), everyone waiting hears it once.
          await this.lineNotice(tx, sessionId, 'Doctor has started the OPD', 'The doctor has started seeing patients. Watch your place in the line in the app.', `start:${sessionId}`);
        } else if (s.status === 'paused') {
          await tx.updateTable('opdSessions').set({ status: 'running' }).where('id', '=', sessionId).execute();
          s.status = 'running';
        }
      };
      const finishCurrent = async () => {
        const cur = await tx.selectFrom('queueEntries').select(['bookingId', 'calledAt']).where('sessionId', '=', sessionId).where('state', '=', 'with_doctor').forUpdate().executeTakeFirst();
        if (!cur) return null;
        await tx.updateTable('queueEntries').set({ state: 'done', doneAt: new Date() }).where('bookingId', '=', cur.bookingId).execute();
        if (cur.calledAt) {
          const secs = Math.min(3600, Math.max(60, (Date.now() - new Date(cur.calledAt).getTime()) / 1000));
          await tx.updateTable('opdSessions').set({ avgConsultSec: Math.round(0.3 * secs + 0.7 * s.avgConsultSec) }).where('id', '=', sessionId).execute();
        }
        return cur.bookingId;
      };
      const callIn = async (bookingId: string) => {
        await tx.updateTable('queueEntries').set({ state: 'with_doctor', calledAt: new Date() }).where('bookingId', '=', bookingId).execute();
        const b = await tx.selectFrom('bookings').select(['token', 'source']).where('id', '=', bookingId).executeTakeFirstOrThrow();
        await tx.updateTable('opdSessions').set({ nowSeeingToken: b.source === 'emergency' ? null : b.token }).where('id', '=', sessionId).execute();
      };

      let called: string | null = null;
      switch (cmd) {
        case 'start':
          if (s.status !== 'scheduled') throw new AppError('ALREADY_STARTED', 'OPD has already started.', HttpStatus.CONFLICT);
          await ensureRunning();
          break;
        case 'pause':
          if (s.status !== 'running') throw new AppError('NOT_RUNNING', 'OPD is not running.', HttpStatus.CONFLICT);
          await tx.updateTable('opdSessions').set({ status: 'paused' }).where('id', '=', sessionId).execute();
          await this.lineNotice(tx, sessionId, 'Doctor is on a short break', 'The doctor is on a short break. Your place in line is safe.', `pause:${sessionId}:${s.version}`);
          break;
        case 'resume':
          if (s.status !== 'paused') throw new AppError('NOT_PAUSED', 'OPD is not on a break.', HttpStatus.CONFLICT);
          await ensureRunning();
          await this.lineNotice(tx, sessionId, 'Doctor is back', 'The doctor is seeing patients again.', `resume:${sessionId}:${s.version}`);
          break;
        case 'late': {
          const minutes = Math.max(0, Math.min(600, Math.round(input.minutes ?? 0)));
          await tx.updateTable('opdSessions').set({ lateMinutes: minutes }).where('id', '=', sessionId).execute();
          await this.lateNotices(tx, s, minutes);
          break;
        }
        case 'call-next': {
          await ensureRunning();
          const seen = await finishCurrent();
          if (seen) await this.patientNotice(tx, seen, 'system', 'Visit done', 'Your visit is done. Your receipt is in the app under My bookings. Take care!', `done:${seen}`);
          // The next person who has reached; if nobody is marked as reached (there is no check-in desk), the next
          // token in order — the doctor calls it out, and "Skip" / "Did not come" handle someone who isn't there.
          const next =
            (await tx.selectFrom('queueEntries').select('bookingId').where('sessionId', '=', sessionId).where('state', '=', 'waiting').orderBy('orderKey').limit(1).forUpdate().executeTakeFirst()) ??
            (await tx.selectFrom('queueEntries').select('bookingId').where('sessionId', '=', sessionId).where('state', '=', 'not_come').orderBy('orderKey').limit(1).forUpdate().executeTakeFirst());
          if (next) {
            await callIn(next.bookingId);
            called = next.bookingId;
          }
          break;
        }
        case 'done': {
          const seen = await finishCurrent();
          if (!seen) throw new AppError('NOBODY_IN', 'Nobody is with the doctor right now.', HttpStatus.CONFLICT);
          await this.patientNotice(tx, seen, 'system', 'Visit done', 'Your visit is done. Your receipt is in the app under My bookings. Take care!', `done:${seen}`);
          break;
        }
        case 'did-not-come': {
          const e = await entry(input.bookingId);
          if (!OPEN_STATES.includes(e.state)) throw new AppError('NOT_ALLOWED', 'This patient is not in line now.', HttpStatus.CONFLICT);
          await tx.updateTable('queueEntries').set({ state: 'did_not_come' }).where('bookingId', '=', e.bookingId).execute();
          await this.patientNotice(tx, e.bookingId, 'turn', 'Marked as did not come', 'The doctor marked you as not here. If you are at the hospital, please tell the reception so you are put back in line.', `dnc:${e.bookingId}:${s.version}`);
          break;
        }
        case 'skip': {
          const e = await entry(input.bookingId);
          if (!['with_doctor', 'waiting'].includes(e.state)) throw new AppError('NOT_ALLOWED', 'Only a waiting patient can be skipped.', HttpStatus.CONFLICT);
          await tx.updateTable('queueEntries').set({ state: 'waiting', orderKey: await maxOrder() }).where('bookingId', '=', e.bookingId).execute();
          await this.patientNotice(tx, e.bookingId, 'turn', 'Moved to the end of the line', 'You were not there when called, so you are now at the end of the line. Please stay near the doctor\'s room.', `skip:${e.bookingId}:${s.version}`);
          break;
        }
        case 'call-now': {
          await ensureRunning();
          const e = await entry(input.bookingId);
          if (!['not_come', 'waiting'].includes(e.state)) throw new AppError('NOT_ALLOWED', 'This patient cannot be called now.', HttpStatus.CONFLICT);
          await tx.updateTable('queueEntries').set({ state: 'waiting' }).where('sessionId', '=', sessionId).where('state', '=', 'with_doctor').execute();
          await callIn(e.bookingId);
          called = e.bookingId;
          break;
        }
        case 'mark-reached': {
          const e = await entry(input.bookingId);
          if (e.state !== 'not_come') throw new AppError('NOT_ALLOWED', 'This patient is already marked.', HttpStatus.CONFLICT);
          await tx.updateTable('queueEntries').set({ state: 'waiting', reachedAt: new Date() }).where('bookingId', '=', e.bookingId).execute();
          break;
        }
        case 'put-back': {
          const e = await entry(input.bookingId);
          if (!['did_not_come', 'done'].includes(e.state)) throw new AppError('NOT_ALLOWED', 'This patient is already in line.', HttpStatus.CONFLICT);
          await tx.updateTable('queueEntries').set({ state: 'waiting', orderKey: await maxOrder(), reachedAt: new Date() }).where('bookingId', '=', e.bookingId).execute();
          if (e.state === 'did_not_come') {
            await this.patientNotice(tx, e.bookingId, 'turn', 'You are back in line', 'The doctor put you back in the line. Please stay near the doctor\'s room.', `putback:${e.bookingId}:${s.version}`);
          }
          break;
        }
        case 'end':
          await this.endSession(tx, s, input.leftovers ?? 'move', { type: 'doctor', id: actor }, input.reason ?? 'The doctor ended the OPD', publishes);
          break;
      }
      const version = await bumpSession(tx, sessionId, cmd.replace(/-/g, '_'), { bookingId: input.bookingId ?? called, actorId: actor, data: input.minutes !== undefined ? { minutes: input.minutes } : {} });
      publishes.push({ sessionId, version });
      if (called) await this.calledNotice(tx, called);
      await enqueue(tx, { topic: 'turn.check', payload: { sessionId } });
      const fresh = await this.load(tx, sessionId);
      return doctorLine(fresh.head, fresh.entries);
    }, 3000);
    for (const p of publishes) this.bus.publish(p);
    return result;
  }

  /**
   * END OPD: whoever is with the doctor is done; people still waiting are moved to another day or cancelled
   * with full money back; bookings are closed as completed / no-show. Also used by the auto-end job.
   */
  async endSession(
    tx: Tx,
    s: LockedSession,
    leftovers: 'move' | 'cancel',
    actor: { type: 'doctor' | 'system' | 'admin'; id: string | null },
    reason: string,
    publishes: { sessionId: string; version: number }[],
  ): Promise<void> {
    await tx.updateTable('queueEntries').set({ state: 'done', doneAt: new Date() }).where('sessionId', '=', s.id).where('state', '=', 'with_doctor').execute();
    const left = await tx.selectFrom('queueEntries').select(['bookingId', 'state']).where('sessionId', '=', s.id).where('state', 'in', ['waiting', 'not_come']).execute();
    for (const e of left) {
      const r = leftovers === 'move'
        ? await this.bookings.moveByProvider(tx, e.bookingId, actor, reason)
        : await this.bookings.cancelByProvider(tx, e.bookingId, actor, reason);
      if (r) publishes.push(r);
    }
    await sql`update bookings b set status = 'completed', completed_at = now()
                from queue_entries q where q.booking_id = b.id and q.session_id = ${s.id} and q.state = 'done' and b.status = 'confirmed'`.execute(tx);
    await sql`update bookings b set status = 'no_show'
                from queue_entries q where q.booking_id = b.id and q.session_id = ${s.id} and q.state = 'did_not_come' and b.status = 'confirmed'`.execute(tx);
    if (s.status === 'scheduled') {
      await tx.updateTable('opdSessions').set({ status: 'running', startedAt: new Date() }).where('id', '=', s.id).execute();
    }
    await tx.updateTable('opdSessions').set({ status: 'ended', endedAt: new Date(), nowSeeingToken: null }).where('id', '=', s.id).execute();
    await tx.updateTable('opdWindows').set({ status: 'closed' }).where('sessionId', '=', s.id).execute();
  }

  private async lateNotices(tx: Tx, s: LockedSession, minutes: number): Promise<void> {
    if (minutes < 10) return;
    const bucket = Math.floor(minutes / 10);
    const people = await tx
      .selectFrom('queueEntries as q')
      .innerJoin('bookings as b', 'b.id', 'q.bookingId')
      .innerJoin('doctors as d', 'd.id', 'b.doctorId')
      .leftJoin('opdWindows as w', 'w.id', 'b.windowId')
      .select(['b.id', 'b.patientUserId', 'd.name as doctorName', 'w.startsAt'])
      .where('q.sessionId', '=', s.id)
      .where('q.state', 'in', ['not_come', 'waiting'])
      .execute();
    for (const p of people) {
      if (!p.patientUserId) continue;
      // "Your new time is about 9:15 AM": the booked hour moved by the delay (the line order does not change).
      const newTime = p.startsAt ? istClock(new Date(new Date(p.startsAt).getTime() + minutes * 60_000)) : null;
      await notify(tx, {
        userId: p.patientUserId,
        kind: 'late',
        title: `${p.doctorName} is ${minutes} min late`,
        body: `${p.doctorName} is running about ${minutes} minutes late today.${newTime ? ` Please come by about ${newTime}.` : ''} Your place in line is safe.`,
        bookingId: p.id,
        dedupeKey: `late:${s.id}:${bucket}`,
      });
    }
  }

  /** One patient's message about their place in the line (skipped when the booking has no app user). */
  private async patientNotice(tx: Tx, bookingId: string, kind: 'turn' | 'system', title: string, body: string, dedupeKey: string): Promise<void> {
    const b = await tx.selectFrom('bookings').select('patientUserId').where('id', '=', bookingId).executeTakeFirst();
    if (!b?.patientUserId) return;
    await notify(tx, { userId: b.patientUserId, kind, title, body, bookingId, dedupeKey });
  }

  /** Everyone still waiting in this OPD (not yet seen) gets the same message: started, break, back. */
  private async lineNotice(tx: Tx, sessionId: string, title: string, body: string, dedupeKey: string): Promise<void> {
    const people = await tx
      .selectFrom('queueEntries as q')
      .innerJoin('bookings as b', 'b.id', 'q.bookingId')
      .select(['b.id', 'b.patientUserId'])
      .where('q.sessionId', '=', sessionId)
      .where('q.state', 'in', ['not_come', 'waiting'])
      .execute();
    for (const p of people) {
      if (p.patientUserId) await notify(tx, { userId: p.patientUserId, kind: 'turn', title, body, bookingId: p.id, dedupeKey });
    }
  }

  private async calledNotice(tx: Tx, bookingId: string): Promise<void> {
    const b = await tx.selectFrom('bookings').select(['patientUserId', 'token', 'source']).where('id', '=', bookingId).executeTakeFirst();
    if (!b?.patientUserId || !(await this.rules.turnAlertsEnabled())) return;
    await notify(tx, {
      userId: b.patientUserId,
      kind: 'turn',
      title: 'Your turn now',
      body: `Token ${tokenLabel(b.source, b.token)}: please go in to the doctor now.`,
      bookingId,
      dedupeKey: `called:${bookingId}`,
    });
  }

  /** Worker: after a line change, tell people who are now 2 away ("Your turn is coming"). */
  async turnCheck(sessionId: string): Promise<void> {
    if (!(await this.rules.turnAlertsEnabled())) return;
    const { head, entries } = await this.load(undefined, sessionId);
    if (head.status !== 'running') return;
    await this.dbs.system(async (tx) => {
      for (const e of entries) {
        if (!e.patientUserId || !['waiting', 'not_come'].includes(e.state)) continue;
        const board = patientBoard(head, entries, e.bookingId);
        if (board.ahead === 2) {
          await notify(tx, {
            userId: e.patientUserId,
            kind: 'turn',
            title: 'Your turn is coming',
            body: `2 people before you. Token ${tokenLabel(e.source, e.token)}. Please be near the doctor's room.`,
            bookingId: e.bookingId,
            dedupeKey: `turn2:${e.bookingId}`,
          });
        }
      }
    });
  }
}
