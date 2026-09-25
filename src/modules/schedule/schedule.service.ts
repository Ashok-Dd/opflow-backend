import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';

import { AppError } from '../../common/errors/app-error';
import { pgError } from '../../common/errors/pg-errors';
import { addDays, istAt, istDayLabel, istRange, istToday, isoWeekday, minutesOf, timeOf } from '../../common/time';
import { DbService, Tx } from '../../infra/db/db.service';

export interface TemplateRow {
  id: string;
  hospitalId: string;
  weekday: number;
  startTime: string;
  endTime: string;
  windowMinutes: number;
  onlinePerWindow: number;
  avgConsultMinutes: number;
  openDaysAhead: number;
  closeMinutesBefore: number;
  validFrom: string;
  validTo: string | null;
}

export interface LeaveRow {
  date: string;
  hospitalId: string | null;
}

export interface PlannedSession {
  hospitalId: string;
  templateId: string;
  date: string;
  startsAt: Date;
  endsAt: Date;
  windowMinutes: number;
  perWindow: number;
  closeMinutesBefore: number;
  avgConsultSec: number;
}

export interface SyncReport {
  created: number;
  updated: number;
  removed: number;
  /** Sessions that no longer match the timings but still have paid bookings: the doctor must decide. */
  keptWithBookings: { sessionId: string; date: string; dayLabel: string; label: string; hospitalId: string; bookings: number }[];
}

export interface WeekInput {
  hospitalId: string;
  days: { weekday: number; blocks: { start: string; end: string; perHour: number; takeEmergency?: boolean; avgMinutes?: number }[] }[];
  openDaysAhead?: number;
  closeMinutesBefore?: number;
  windowMinutes?: 30 | 60;
}

/**
 * Turns a doctor's weekly timings (schedule_templates) into real sessions, hours (windows) and places
 * (window_slots) for the next N days. Safe to run any number of times: it only adds what's missing,
 * adjusts places per hour, and removes sessions nobody booked. A session with paid bookings is never
 * removed here: it is reported so the doctor can cancel or move those people on purpose.
 */
@Injectable()
export class ScheduleService {
  private readonly log = new Logger(ScheduleService.name);

  constructor(private readonly dbs: DbService) {}

  /** Pure: which sessions the timings ask for between two dates (inclusive). */
  static plan(templates: TemplateRow[], leaves: LeaveRow[], from: string, to: string, now = new Date()): PlannedSession[] {
    const out: PlannedSession[] = [];
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const weekday = isoWeekday(date);
      for (const t of templates) {
        if (t.weekday !== weekday || t.validFrom > date || (t.validTo !== null && t.validTo < date)) continue;
        if (date > addDays(istToday(now), t.openDaysAhead - 1)) continue;
        if (leaves.some((l) => l.date === date && (l.hospitalId === null || l.hospitalId === t.hospitalId))) continue;
        const startsAt = istAt(date, t.startTime);
        const endsAt = istAt(date, t.endTime);
        if (endsAt.getTime() <= now.getTime()) continue;
        out.push({
          hospitalId: t.hospitalId,
          templateId: t.id,
          date,
          startsAt,
          endsAt,
          windowMinutes: t.windowMinutes,
          perWindow: t.onlinePerWindow,
          closeMinutesBefore: t.closeMinutesBefore,
          avgConsultSec: t.avgConsultMinutes * 60,
        });
      }
    }
    return out;
  }

  /** Brings one doctor's upcoming sessions in line with their timings and leave days. */
  async syncDoctor(tx: Tx, doctorId: string, now = new Date()): Promise<SyncReport> {
    // One sync per doctor at a time (the doctor saving timings while the nightly job runs).
    await sql`select pg_advisory_xact_lock(hashtext(${`schedule:${doctorId}`}))`.execute(tx);
    const today = istToday(now);
    const templates = (await tx
      .selectFrom('scheduleTemplates')
      .select(['id', 'hospitalId', 'weekday', 'startTime', 'endTime', 'windowMinutes', 'onlinePerWindow', 'avgConsultMinutes', 'openDaysAhead', 'closeMinutesBefore', 'validFrom', 'validTo'])
      .where('doctorId', '=', doctorId)
      .execute()) as TemplateRow[];
    const activeHospitals = new Set(
      (await tx.selectFrom('doctorHospitals').select('hospitalId').where('doctorId', '=', doctorId).where('status', '=', 'active').execute()).map((r) => r.hospitalId),
    );
    const horizon = Math.max(14, ...templates.map((t) => t.openDaysAhead));
    const to = addDays(today, horizon - 1);
    const leaves = await tx.selectFrom('doctorLeaves').select(['date', 'hospitalId']).where('doctorId', '=', doctorId).where('date', '>=', today).execute();
    const planned = ScheduleService.plan(templates.filter((t) => activeHospitals.has(t.hospitalId)), leaves, today, to, now);

    const existing = await sql<{
      id: string; hospitalId: string; date: string; startsAt: Date; endsAt: Date; status: string; windowMinutes: number | null;
      live: number; total: number; bulk: number;
    }>`
      select s.id, s.hospital_id, s.date, s.starts_at, s.ends_at, s.status,
             (select extract(epoch from (w.ends_at - w.starts_at))::int / 60 from opd_windows w where w.session_id = s.id order by w.starts_at limit 1) as window_minutes,
             (select count(*)::int from bookings b where b.session_id = s.id and b.status in ('pending_payment', 'confirmed')) as live,
             (select count(*)::int from bookings b where b.session_id = s.id) as total,
             (select count(*)::int from bulk_operations o where o.session_id = s.id) as bulk
        from opd_sessions s
       where s.doctor_id = ${doctorId} and s.date between ${today}::date and ${to}::date`.execute(tx);

    const keyOf = (h: string, a: Date, b: Date) => `${h}|${new Date(a).toISOString()}|${new Date(b).toISOString()}`;
    const wanted = new Map(planned.map((p) => [keyOf(p.hospitalId, p.startsAt, p.endsAt), p]));
    const report: SyncReport = { created: 0, updated: 0, removed: 0, keptWithBookings: [] };
    const covered = new Set<string>();

    for (const s of existing.rows) {
      const key = keyOf(s.hospitalId, s.startsAt, s.endsAt);
      const plan = wanted.get(key);
      if (s.status !== 'scheduled') {
        if (s.status !== 'cancelled') covered.add(key); // running/paused/ended stay as they are
        continue;
      }
      if (plan && (s.windowMinutes === null || s.windowMinutes === plan.windowMinutes)) {
        covered.add(key);
        await tx
          .updateTable('opdSessions')
          .set({ templateId: plan.templateId, closeMinutesBefore: plan.closeMinutesBefore, avgConsultSec: plan.avgConsultSec })
          .where('id', '=', s.id)
          .execute();
        await this.setCapacity(tx, s.id, plan.perWindow);
        await tx.updateTable('opdWindows').set({ status: 'open' }).where('sessionId', '=', s.id).where('status', '=', 'closed').execute();
        report.updated++;
        continue;
      }
      if (s.total === 0 && s.bulk === 0) {
        await tx.deleteFrom('opdSessions').where('id', '=', s.id).execute();
        report.removed++;
      } else if (s.live === 0) {
        await tx.updateTable('opdSessions').set({ status: 'cancelled' }).where('id', '=', s.id).execute();
        await tx.updateTable('opdWindows').set({ status: 'closed' }).where('sessionId', '=', s.id).execute();
        report.removed++;
      } else {
        // Paid bookings: keep the session, but take no new bookings in it.
        await tx.updateTable('opdWindows').set({ status: 'closed' }).where('sessionId', '=', s.id).execute();
        report.keptWithBookings.push({
          sessionId: s.id,
          date: s.date,
          dayLabel: istDayLabel(s.date, now),
          label: istRange(new Date(s.startsAt), new Date(s.endsAt)),
          hospitalId: s.hospitalId,
          bookings: s.live,
        });
      }
    }

    for (const [key, p] of wanted) {
      if (covered.has(key)) continue;
      // A cancelled session at the same start blocks re-creating it (unique key). Remove it if nobody ever booked it.
      const blocking = existing.rows.find(
        (s) => s.status === 'cancelled' && s.hospitalId === p.hospitalId && new Date(s.startsAt).getTime() === p.startsAt.getTime(),
      );
      if (blocking) {
        if (blocking.total > 0 || blocking.bulk > 0) continue;
        await tx.deleteFrom('opdSessions').where('id', '=', blocking.id).execute();
      }
      const overlap = await sql<{ n: number }>`
        select count(*)::int as n from opd_sessions
         where doctor_id = ${doctorId} and status <> 'cancelled'
           and tstzrange(starts_at, ends_at) && tstzrange(${p.startsAt}::timestamptz, ${p.endsAt}::timestamptz)`.execute(tx);
      if ((overlap.rows[0]?.n ?? 0) > 0) continue;
      await this.createSession(tx, doctorId, p);
      report.created++;
    }
    return report;
  }

  /** One session, its hours and its numbered places (window i gets tokens 20·i+1 …). */
  async createSession(tx: Tx, doctorId: string, p: PlannedSession): Promise<string> {
    const session = await tx
      .insertInto('opdSessions')
      .values({
        doctorId,
        hospitalId: p.hospitalId,
        templateId: p.templateId,
        date: p.date,
        startsAt: p.startsAt,
        endsAt: p.endsAt,
        closeMinutesBefore: p.closeMinutesBefore,
        avgConsultSec: p.avgConsultSec,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const windows = [];
    let i = 0;
    for (let t = p.startsAt.getTime(); t < p.endsAt.getTime(); t += p.windowMinutes * 60_000, i++) {
      windows.push({
        sessionId: session.id,
        startsAt: new Date(t),
        endsAt: new Date(Math.min(t + p.windowMinutes * 60_000, p.endsAt.getTime())),
        capacity: p.perWindow,
        tokenStart: 1 + 20 * i,
      });
    }
    if (windows.length > 0) {
      await tx.insertInto('opdWindows').values(windows).execute();
      await sql`
        insert into window_slots (window_id, token)
        select w.id, gs from opd_windows w, generate_series(w.token_start, w.token_start + w.capacity - 1) gs
         where w.session_id = ${session.id}`.execute(tx);
    }
    return session.id;
  }

  /** Places per hour changed: add free places, or block free ones above the new number. Booked places stay. */
  async setCapacity(tx: Tx, sessionId: string, perWindow: number): Promise<void> {
    await sql`
      insert into window_slots (window_id, token)
      select w.id, gs from opd_windows w, generate_series(w.token_start, w.token_start + ${perWindow}::int - 1) gs
       where w.session_id = ${sessionId}
      on conflict do nothing`.execute(tx);
    await sql`
      update window_slots ws set state = 'free', version = ws.version + 1
        from opd_windows w
       where ws.window_id = w.id and w.session_id = ${sessionId} and ws.state = 'blocked' and ws.token < w.token_start + ${perWindow}::int`.execute(tx);
    await sql`
      update window_slots ws set state = 'blocked', version = ws.version + 1
        from opd_windows w
       where ws.window_id = w.id and w.session_id = ${sessionId} and ws.state = 'free' and ws.token >= w.token_start + ${perWindow}::int`.execute(tx);
    await tx.updateTable('opdWindows').set({ capacity: perWindow }).where('sessionId', '=', sessionId).where('capacity', '<>', perWindow).execute();
  }

  /** The doctor's weekly timings at one hospital, as the app's Timings screen shows them. */
  async week(doctorId: string, hospitalId: string) {
    const today = istToday();
    const rows = await this.dbs.db
      .selectFrom('scheduleTemplates')
      .selectAll()
      .where('doctorId', '=', doctorId)
      .where('hospitalId', '=', hospitalId)
      .where((eb) => eb.or([eb('validTo', 'is', null), eb('validTo', '>=', today)]))
      .orderBy('weekday')
      .orderBy('startTime')
      .execute();
    const first = rows[0];
    return {
      hospitalId,
      openDaysAhead: first?.openDaysAhead ?? 14,
      closeMinutesBefore: first?.closeMinutesBefore ?? 30,
      windowMinutes: first?.windowMinutes ?? 60,
      days: Array.from({ length: 7 }, (_, i) => ({
        weekday: i + 1,
        blocks: rows
          .filter((r) => r.weekday === i + 1)
          .map((r) => ({
            start: r.startTime.slice(0, 5),
            end: r.endTime.slice(0, 5),
            perHour: Math.round((r.onlinePerWindow * 60) / r.windowMinutes),
            takeEmergency: r.takeEmergency,
            avgMinutes: r.avgConsultMinutes,
          })),
      })),
    };
  }

  /** Replaces the weekly timings at one hospital and re-syncs the coming days. */
  async saveWeek(tx: Tx, doctorId: string, input: WeekInput, now = new Date()): Promise<SyncReport> {
    const link = await tx
      .selectFrom('doctorHospitals')
      .select('status')
      .where('doctorId', '=', doctorId)
      .where('hospitalId', '=', input.hospitalId)
      .executeTakeFirst();
    if (!link || link.status !== 'active') {
      throw new AppError('HOSPITAL_NOT_LINKED', 'This hospital is not on your profile. Please ask the OPflow team to add it.', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const windowMinutes = input.windowMinutes ?? 60;
    for (const d of input.days) {
      const blocks = [...d.blocks].sort((a, b) => minutesOf(a.start) - minutesOf(b.start));
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i]!;
        const len = minutesOf(b.end) - minutesOf(b.start);
        if (len <= 0) throw new AppError('BAD_TIMINGS', 'The end time must be after the start time.', HttpStatus.UNPROCESSABLE_ENTITY);
        if (len % windowMinutes !== 0 || minutesOf(b.start) % 30 !== 0) {
          throw new AppError('BAD_TIMINGS', 'Please use whole hours, like 9 AM to 1 PM.', HttpStatus.UNPROCESSABLE_ENTITY);
        }
        if (i > 0 && minutesOf(b.start) < minutesOf(blocks[i - 1]!.end)) {
          throw new AppError('BAD_TIMINGS', 'Two time blocks on the same day overlap. Please fix them.', HttpStatus.UNPROCESSABLE_ENTITY);
        }
      }
    }
    const today = istToday(now);
    await tx.deleteFrom('scheduleTemplates').where('doctorId', '=', doctorId).where('hospitalId', '=', input.hospitalId).execute();
    const rows = input.days.flatMap((d) =>
      d.blocks.map((b) => ({
        doctorId,
        hospitalId: input.hospitalId,
        weekday: d.weekday,
        startTime: `${timeOf(minutesOf(b.start))}:00`,
        endTime: `${timeOf(minutesOf(b.end))}:00`,
        windowMinutes,
        onlinePerWindow: Math.max(1, Math.min(20, Math.round((b.perHour * windowMinutes) / 60))),
        takeEmergency: b.takeEmergency ?? true,
        avgConsultMinutes: b.avgMinutes ?? 7,
        openDaysAhead: input.openDaysAhead ?? 14,
        closeMinutesBefore: input.closeMinutesBefore ?? 30,
        validFrom: today,
      })),
    );
    try {
      if (rows.length > 0) await tx.insertInto('scheduleTemplates').values(rows).execute();
    } catch (err) {
      if (pgError(err)?.code === '23P01') {
        throw new AppError('TIMINGS_OVERLAP', 'These timings overlap with your timings at another hospital. Please change one of them.', HttpStatus.UNPROCESSABLE_ENTITY);
      }
      throw err;
    }
    return this.syncDoctor(tx, doctorId, now);
  }

  /** Nightly: every active doctor's next days. Each doctor in their own transaction, so one problem can't stop the rest. */
  async syncAll(): Promise<{ doctors: number; created: number; failed: number }> {
    const doctors = await this.dbs.db.selectFrom('doctors').select('id').where('status', '=', 'active').execute();
    let created = 0;
    let failed = 0;
    for (const d of doctors) {
      try {
        const r = await this.dbs.system((tx) => this.syncDoctor(tx, d.id), 60_000);
        created += r.created;
      } catch (err) {
        failed++;
        this.log.error(`Session sync failed for doctor ${d.id}: ${(err as Error).message}`);
      }
    }
    return { doctors: doctors.length, created, failed };
  }
}
