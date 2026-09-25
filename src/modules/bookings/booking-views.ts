import { sql } from 'kysely';

import { money } from '../../common/money';
import { istDayLabel, istRange } from '../../common/time';
import type { Tx } from '../../infra/db/db.service';
import type { DirectoryService } from '../directory/directory.service';
import { tokenLabel } from '../live/session-events';

export interface BookingRow {
  id: string;
  code: string;
  status: string;
  source: string;
  token: number;
  sessionId: string;
  sessionDate: string;
  windowId: string | null;
  doctorId: string;
  hospitalId: string;
  patientUserId: string | null;
  patientName: string;
  patientAge: number | null;
  patientGender: string | null;
  note: string;
  feePaise: number;
  platformFeePaise: number;
  emergencyChargePaise: number;
  rescheduleCount: number;
  needsNewTimeSince: Date | null;
  holdExpiresAt: Date | null;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
  cancelledReason: string | null;
  createdAt: Date;
  doctorName: string;
  doctorPhotoKey: string | null;
  typeName: string;
  hospitalName: string;
  hospitalArea: string;
  hospitalAddress: string;
  hospitalPhone: string;
  hospitalLat: number;
  hospitalLng: number;
  startsAt: Date;
  endsAt: Date;
  sessionStatus: string;
  sessionEndsAt: Date;
  queueState: string | null;
  payment: { status: string; amountPaise: number; method: string | null; orderId: string; paymentId: string | null } | null;
  refunds: { id: string; status: string; amountPaise: number; reason: string; createdAt: string }[] | null;
}

/** Loads bookings with everything a ticket shows. Runs in the caller's transaction (row-level security applies). */
export async function loadBookings(tx: Tx, where: { ids?: string[]; patientUserId?: string; tab?: 'upcoming' | 'past'; limit?: number; offset?: number }): Promise<BookingRow[]> {
  const r = await sql<BookingRow>`
    select b.id, b.code, b.status, b.source, b.token, b.session_id, b.session_date, b.window_id, b.doctor_id, b.hospital_id,
           b.patient_user_id, b.patient_name, b.patient_age, b.patient_gender, b.note, b.fee_paise, b.platform_fee_paise,
           b.emergency_charge_paise, b.reschedule_count, b.needs_new_time_since, b.hold_expires_at, b.confirmed_at,
           b.cancelled_at, b.cancelled_reason, b.created_at,
           d.name as doctor_name, d.photo_key as doctor_photo_key, t.simple_name as type_name,
           h.name as hospital_name, h.area as hospital_area, h.address as hospital_address, h.phone as hospital_phone,
           h.lat as hospital_lat, h.lng as hospital_lng,
           coalesce(w.starts_at, s.starts_at) as starts_at, coalesce(w.ends_at, s.ends_at) as ends_at,
           s.status as session_status, s.ends_at as session_ends_at,
           q.state as queue_state,
           (select json_build_object('status', p.status, 'amountPaise', p.amount_paise, 'method', p.method,
                                     'orderId', p.razorpay_order_id, 'paymentId', p.razorpay_payment_id)
              from payments p where p.booking_id = b.id
             order by (p.status = 'captured') desc, p.abandoned asc, p.created_at desc limit 1) as payment,
           (select json_agg(json_build_object('id', rf.id, 'status', rf.status, 'amountPaise', rf.amount_paise,
                                              'reason', rf.reason, 'createdAt', rf.created_at) order by rf.created_at)
              from refunds rf join payments p on p.id = rf.payment_id where p.booking_id = b.id) as refunds
      from bookings b
      join doctors d on d.id = b.doctor_id
      join doctor_types t on t.id = d.type_id
      join hospitals h on h.id = b.hospital_id
      join opd_sessions s on s.id = b.session_id
      left join opd_windows w on w.id = b.window_id
      left join queue_entries q on q.booking_id = b.id
     where (${where.ids ?? null}::uuid[] is null or b.id = any(${where.ids ?? null}::uuid[]))
       and (${where.patientUserId ?? null}::uuid is null or b.patient_user_id = ${where.patientUserId ?? null}::uuid)
       and (${where.tab ?? null}::text is null
            or (${where.tab ?? null}::text = 'upcoming' and (
                  (b.status = 'pending_payment' and b.hold_expires_at > now())
                  or (b.status = 'confirmed' and coalesce(q.state::text, 'not_come') not in ('done', 'did_not_come', 'cancelled')
                      and s.status not in ('ended', 'cancelled') and s.ends_at > now() - interval '3 hours')
                  or (b.status = 'confirmed' and b.needs_new_time_since is not null)))
            or (${where.tab ?? null}::text = 'past' and not (
                  (b.status = 'pending_payment' and b.hold_expires_at > now())
                  or (b.status = 'confirmed' and coalesce(q.state::text, 'not_come') not in ('done', 'did_not_come', 'cancelled')
                      and s.status not in ('ended', 'cancelled') and s.ends_at > now() - interval '3 hours')
                  or (b.status = 'confirmed' and b.needs_new_time_since is not null))))
     order by case when ${where.tab ?? null}::text = 'past' then extract(epoch from coalesce(w.starts_at, s.starts_at)) * -1
                   else extract(epoch from coalesce(w.starts_at, s.starts_at)) end, b.created_at desc
     limit ${where.limit ?? 50} offset ${where.offset ?? 0}`.execute(tx);
  return r.rows;
}

export interface ChangeRules {
  cutoffMinutes: number;
  maxChanges: number;
}

/** Why the patient can't change date/time (null = they can). The same words as the app. */
export function whyNoChange(b: BookingRow, rules: ChangeRules, now = Date.now()): string | null {
  if (b.status !== 'confirmed') return 'This booking is closed.';
  if (b.source === 'emergency') return 'Emergency consultations cannot be changed. Please go to the hospital now.';
  if (b.needsNewTimeSince) return null; // the doctor moved them: they may pick any time
  if (b.queueState && !['not_come', 'waiting'].includes(b.queueState)) return 'This booking is closed.';
  if (b.rescheduleCount >= rules.maxChanges) return 'You already changed this booking once.';
  const hours = rules.cutoffMinutes / 60;
  if (now > new Date(b.startsAt).getTime() - rules.cutoffMinutes * 60_000) {
    return `Changes are allowed only up to ${Number.isInteger(hours) ? `${hours} hour${hours === 1 ? '' : 's'}` : `${rules.cutoffMinutes} minutes`} before your time.`;
  }
  return null;
}

const statusLabels: Record<string, string> = {
  pending_payment: 'Waiting for payment',
  confirmed: 'Booked',
  completed: 'Done',
  no_show: 'Missed',
  expired: 'Not paid',
  cancelled_by_provider: 'Cancelled by doctor',
};

const refundLabels: Record<string, string> = {
  pending: 'Money back started',
  processed: 'Money back sent',
  failed: 'Money back delayed: we are fixing it',
};

/** What the patient app shows for one booking. */
export function patientView(b: BookingRow, dir: DirectoryService, rules: ChangeRules) {
  const why = whyNoChange(b, rules);
  const total = b.feePaise + b.emergencyChargePaise;
  return {
    id: b.id,
    code: b.code,
    status: b.status,
    statusLabel: b.needsNewTimeSince && b.status === 'confirmed' ? 'Please pick a new time' : (statusLabels[b.status] ?? b.status),
    source: b.source,
    emergency: b.source === 'emergency',
    token: b.token,
    tokenLabel: tokenLabel(b.source, b.token),
    date: b.sessionDate,
    dayLabel: istDayLabel(b.sessionDate),
    time: { startsAt: b.startsAt, endsAt: b.endsAt, label: istRange(new Date(b.startsAt), new Date(b.endsAt)) },
    sessionId: b.sessionId,
    windowId: b.windowId,
    doctor: { id: b.doctorId, name: b.doctorName, type: b.typeName, photo: dir.photo(b.doctorPhotoKey) },
    hospital: {
      id: b.hospitalId,
      name: b.hospitalName,
      area: b.hospitalArea,
      address: b.hospitalAddress,
      phone: b.hospitalPhone,
      location: { lat: b.hospitalLat, lng: b.hospitalLng },
    },
    patient: { name: b.patientName, age: b.patientAge, gender: b.patientGender },
    note: b.note,
    fee: money(b.feePaise),
    emergencyCharge: money(b.emergencyChargePaise),
    total: money(total),
    payment: b.payment ? { status: b.payment.status, method: b.payment.method, orderId: b.payment.orderId } : null,
    refunds: (b.refunds ?? []).map((r) => ({ id: r.id, status: r.status, label: refundLabels[r.status] ?? r.status, amount: money(r.amountPaise), createdAt: r.createdAt })),
    holdExpiresAt: b.status === 'pending_payment' ? b.holdExpiresAt : null,
    queueState: b.queueState,
    needsNewTime: b.status === 'confirmed' && b.needsNewTimeSince !== null,
    changedOnce: b.rescheduleCount > 0,
    canChange: why === null,
    whyNoChange: why,
    cancelledReason: b.cancelledReason,
    createdAt: b.createdAt,
    confirmedAt: b.confirmedAt,
  };
}

export type PatientBookingView = ReturnType<typeof patientView>;
