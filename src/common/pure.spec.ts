import { patientBoard, SessionHead, LineEntry } from '../modules/live/live.service';
import { ScheduleService, TemplateRow } from '../modules/schedule/schedule.service';
import { base32Decode, base32Encode, bookingCode, oneTimePassword, totpAt, verifyTotp } from './crypto';
import { emergencyCharge, money, platformFee } from './money';
import { addDays, istAt, istClock, istDateOf, istRange, isoWeekday } from './time';

describe('India time', () => {
  it('uses the Indian date, not the server date', () => {
    expect(istDateOf(new Date('2026-09-25T19:00:00Z'))).toBe('2026-09-26'); // 00:30 IST next day
    expect(istAt('2026-09-25', '09:30').toISOString()).toBe('2026-09-25T04:00:00.000Z');
    expect(isoWeekday('2026-09-27')).toBe(7); // Sunday
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('writes times the way the app does', () => {
    expect(istClock(istAt('2026-09-25', '12:00'))).toBe('12 PM');
    expect(istRange(istAt('2026-09-25', '09:00'), istAt('2026-09-25', '10:00'))).toBe('9 – 10 AM');
    expect(istRange(istAt('2026-09-25', '11:00'), istAt('2026-09-25', '12:00'))).toBe('11 AM – 12 PM');
  });
});

describe('money', () => {
  it('₹500 fee: doctor ₹450, OPflow ₹50 + ₹100 emergency charge', () => {
    expect(platformFee(50000)).toBe(5000);
    expect(emergencyCharge(50000, 20)).toBe(10000);
    expect(emergencyCharge(35000, 20)).toBe(7000);
    expect(money(123456).display).toBe('₹1,234.56');
    expect(money(30000).display).toBe('₹300');
  });
});

describe('crypto', () => {
  it('TOTP matches RFC 6238 (SHA-1 test vector)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(totpAt(secret, Math.floor(59 / 30))).toBe('287082');
    expect(totpAt(secret, Math.floor(1111111109 / 30))).toBe('081804');
    expect(verifyTotp(secret, '081804', 1111111109 * 1000)).toBe(Math.floor(1111111109 / 30));
    expect(verifyTotp(secret, '000000', 1111111109 * 1000)).toBeNull();
  });

  it('booking codes and one-time passwords have the right shape', () => {
    expect(bookingCode()).toMatch(/^OPF[0-9A-Z]{6}$/);
    const p = oneTimePassword();
    expect(p).toHaveLength(12);
    expect(p).toMatch(/[A-Za-z]/);
    expect(p).toMatch(/\d/);
  });
});

describe('patient board', () => {
  const head: SessionHead = {
    id: 's', doctorId: 'd', hospitalId: 'h', hospitalName: 'H', date: '2026-09-25', startsAt: new Date(0), endsAt: new Date(0),
    status: 'running', version: 7, lateMinutes: 10, avgConsultSec: 600, nowSeeingToken: 1,
  };
  const e = (bookingId: string, orderKey: number, state: string, source = 'online'): LineEntry => ({
    bookingId, token: orderKey < 0 ? orderKey + 1000 : orderKey, source, state, orderKey, patientName: bookingId, patientAge: 30, patientGender: 'male',
    patientUserId: 'u', note: '', reachedAt: null, calledAt: null, doneAt: null, windowStartsAt: null, windowEndsAt: null, rescheduled: false,
  });

  it('counts only people before me who are still to be seen, with a time range', () => {
    const line = [e('a', 1, 'done'), e('b', 2, 'with_doctor'), e('c', 3, 'waiting'), e('x', 4, 'did_not_come'), e('me', 5, 'not_come'), e('z', 6, 'waiting')];
    const b = patientBoard(head, line, 'me');
    expect(b.ahead).toBe(2); // c waiting + b with the doctor
    expect(b.eta).toEqual({ lowMinutes: 26, highMinutes: 39, label: 'About 26 – 39 min' });
    expect(b.nowSeeing).toBe('02');
    expect(b.message).toBe('2 people before you.');
  });

  it('emergency patients go before everyone', () => {
    const line = [e('me', 3, 'waiting'), e('em', -999, 'waiting', 'emergency')];
    expect(patientBoard(head, line, 'me').ahead).toBe(1);
    expect(patientBoard(head, line, 'em').ahead).toBe(0);
  });
});

describe('schedule planner', () => {
  const t: TemplateRow = {
    id: 't', hospitalId: 'h', weekday: 1, startTime: '09:00:00', endTime: '13:00:00', windowMinutes: 60, onlinePerWindow: 6,
    avgConsultMinutes: 7, openDaysAhead: 14, closeMinutesBefore: 30, validFrom: '2026-01-01', validTo: null,
  };
  const now = new Date('2026-09-21T00:00:00Z'); // Monday 05:30 IST

  it('makes one session per matching weekday, skipping leave days and the past', () => {
    const plan = ScheduleService.plan([t], [{ date: '2026-09-28', hospitalId: null }], '2026-09-21', '2026-10-04', now);
    expect(plan.map((p) => p.date)).toEqual(['2026-09-21']); // 28th is leave; 5 Oct is past the horizon
    expect(plan[0]!.startsAt.toISOString()).toBe('2026-09-21T03:30:00.000Z');
  });

  it('does not make sessions that have already ended today', () => {
    const late = new Date('2026-09-21T08:00:00Z'); // 13:30 IST
    expect(ScheduleService.plan([t], [], '2026-09-21', '2026-09-21', late)).toEqual([]);
  });
});
