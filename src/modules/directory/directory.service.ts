import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import { AppError } from '../../common/errors/app-error';
import { money } from '../../common/money';
import { addDays, hhmm, istDayLabel, istRange, istToday } from '../../common/time';
import { DbService } from '../../infra/db/db.service';
import { STORAGE, Storage } from '../../infra/storage/storage';

export interface DoctorFilter {
  ids?: string[];
  type?: string;
  problem?: string;
  who?: 'adult' | 'child';
  hospital?: string;
  q?: string;
  lang?: string;
  day?: 'today' | 'tomorrow';
  near?: { lat: number; lng: number };
  sort?: 'soonest' | 'fee' | 'distance' | 'name';
  offset?: number;
  limit?: number;
  /** Admin preview: include doctors not yet verified. */
  includeUnlisted?: boolean;
}

interface CardRow {
  id: string;
  name: string;
  gender: string;
  typeId: string;
  typeName: string;
  properName: string;
  degrees: string;
  yearsExperience: number;
  languages: string[];
  about: string;
  feePaise: number;
  photoKey: string | null;
  bookingsPaused: boolean;
  verification: string;
  emStatus: string | null;
  emUntil: Date | null;
  emHospitalId: string | null;
  emMode: string | null;
  emUpdatedAt: Date | null;
  hospitals: { id: string; name: string; area: string; city: string; isPrimary: boolean; feePaise: number | null; distanceM: number | null }[] | null;
  nfWindowId: string | null;
  nfSessionId: string | null;
  nfHospitalId: string | null;
  nfDate: string | null;
  nfStartsAt: Date | null;
  nfEndsAt: Date | null;
  nfFree: number | null;
  nfCapacity: number | null;
  distanceM: number | null;
}

export type PhotoUrls = { s: string; m: string; l: string } | null;

/**
 * Public doctor and hospital data for patients: cards, profiles, days and hours with free places. Only
 * verified, active doctors are ever shown (rule A2). The registration number is never included: it is only
 * for OPflow's own checks.
 */
@Injectable()
export class DirectoryService {
  constructor(
    private readonly dbs: DbService,
    @Inject(STORAGE) private readonly storage: Storage,
  ) {}

  photo(key: string | null): PhotoUrls {
    if (!key) return null;
    return { s: this.storage.publicUrl(`${key}-s.webp`), m: this.storage.publicUrl(`${key}-m.webp`), l: this.storage.publicUrl(`${key}-l.webp`) };
  }

  /** Doctor cards with their next free time, in one query (no per-doctor round trips). */
  async cards(f: DoctorFilter): Promise<{ items: ReturnType<DirectoryService['toCard']>[]; hasMore: boolean }> {
    const limit = f.limit ?? 20;
    const offset = f.offset ?? 0;
    const today = istToday();
    const day = f.day === 'today' ? today : f.day === 'tomorrow' ? addDays(today, 1) : null;
    const lat = f.near?.lat ?? null;
    const lng = f.near?.lng ?? null;
    const q = f.q?.trim() ? f.q.trim() : null;
    const order =
      f.sort === 'fee'
        ? sql`d.fee_paise asc, d.name asc`
        : f.sort === 'distance' && f.near
          ? sql`distance_m asc nulls last, d.name asc`
          : f.sort === 'name'
            ? sql`d.name asc`
            : f.problem
              ? sql`problem_rank asc, nf.starts_at asc nulls last, d.name asc`
              : sql`nf.starts_at asc nulls last, d.name asc`;

    const rows = await sql<CardRow & { problemRank: number }>`
      select d.id, d.name, d.gender, d.type_id, t.simple_name as type_name, t.proper_name, d.degrees, d.years_experience,
             d.languages, d.about, d.fee_paise, d.photo_key, d.bookings_paused, d.verification,
             es.status as em_status, es.until_at as em_until, es.hospital_id as em_hospital_id, es.mode as em_mode,
             es.updated_at as em_updated_at,
             (select json_agg(json_build_object(
                       'id', h.id, 'name', h.name, 'area', h.area, 'city', h.city, 'isPrimary', dh.is_primary,
                       'feePaise', dh.fee_paise_override,
                       'distanceM', case when ${lat}::float8 is null then null
                                         else round(earth_distance(ll_to_earth(h.lat, h.lng), ll_to_earth(${lat}::float8, ${lng}::float8))) end)
                     order by dh.is_primary desc, h.name)
                from doctor_hospitals dh join hospitals h on h.id = dh.hospital_id
               where dh.doctor_id = d.id and dh.status = 'active' and h.status = 'active') as hospitals,
             nf.window_id as nf_window_id, nf.session_id as nf_session_id, nf.hospital_id as nf_hospital_id,
             nf.date as nf_date, nf.starts_at as nf_starts_at, nf.ends_at as nf_ends_at, nf.free as nf_free,
             nf.capacity as nf_capacity,
             (select min(earth_distance(ll_to_earth(h.lat, h.lng), ll_to_earth(${lat}::float8, ${lng}::float8)))
                from doctor_hospitals dh join hospitals h on h.id = dh.hospital_id
               where ${lat}::float8 is not null and dh.doctor_id = d.id and dh.status = 'active' and h.status = 'active') as distance_m,
             coalesce((select min(pm.rank) from problem_type_map pm
                        where pm.problem_id = ${f.problem ?? null}::text and pm.type_id = d.type_id
                          and pm.audience = coalesce(${f.who ?? null}::audience, 'adult')), 99) as problem_rank
        from doctors d
        join doctor_types t on t.id = d.type_id
        left join emergency_status es on es.doctor_id = d.id
        left join lateral (
          select w.id as window_id, s.id as session_id, s.hospital_id, s.date, w.starts_at, w.ends_at, w.capacity,
                 (select count(*)::int from window_slots ws where ws.window_id = w.id and ws.state = 'free') as free
            from opd_windows w
            join opd_sessions s on s.id = w.session_id
           where s.doctor_id = d.id
             and s.status in ('scheduled', 'running', 'paused')
             and w.status = 'open'
             and not d.bookings_paused
             and w.starts_at - make_interval(mins => s.close_minutes_before) > now()
             and (${f.hospital ?? null}::uuid is null or s.hospital_id = ${f.hospital ?? null}::uuid)
             and (${day}::date is null or s.date = ${day}::date)
             and exists (select 1 from window_slots ws where ws.window_id = w.id and ws.state = 'free')
             and exists (select 1 from doctor_hospitals dh where dh.doctor_id = d.id and dh.hospital_id = s.hospital_id and dh.status = 'active')
           order by w.starts_at
           limit 1
        ) nf on true
       where (${f.includeUnlisted ?? false}::boolean or (d.verification = 'verified' and d.status = 'active'))
         and (${f.ids ?? null}::uuid[] is null or d.id = any(${f.ids ?? null}::uuid[]))
         and (${f.type ?? null}::text is null or d.type_id = ${f.type ?? null}::text)
         and (${f.problem ?? null}::text is null or d.type_id in (
               select pm.type_id from problem_type_map pm
                where pm.problem_id = ${f.problem ?? null}::text and pm.audience = coalesce(${f.who ?? null}::audience, 'adult')))
         and (${f.lang ?? null}::text is null or ${f.lang ?? null}::text = any(d.languages))
         and (${f.hospital ?? null}::uuid is null or exists (
               select 1 from doctor_hospitals dh where dh.doctor_id = d.id and dh.hospital_id = ${f.hospital ?? null}::uuid and dh.status = 'active'))
         and (${q}::text is null or d.name ilike '%' || ${q}::text || '%' or d.search_vector @@ plainto_tsquery('simple', ${q}::text)
              or similarity(d.name, ${q}::text) > 0.3 or t.simple_name ilike '%' || ${q}::text || '%' or t.proper_name ilike '%' || ${q}::text || '%')
         and (${day}::date is null or nf.window_id is not null)
         and (${f.includeUnlisted ?? false}::boolean or exists (select 1 from doctor_hospitals dh where dh.doctor_id = d.id and dh.status = 'active'))
       order by ${order}
       limit ${limit + 1} offset ${offset}`.execute(this.dbs.db);

    const page = rows.rows.slice(0, limit);
    const week = await this.weekFor(page.map((r) => r.id));
    const items = page.map((r) => ({ ...this.toCard(r), week: week.get(r.id) ?? [] }));
    return { items, hasMore: rows.rows.length > limit };
  }

  /** Weekly timings of several doctors in one query: [{ hospitalId, weekday, start, end, perHour }]. */
  private async weekFor(ids: string[]) {
    const out = new Map<string, { hospitalId: string; weekday: number; start: string; end: string; perHour: number }[]>();
    if (ids.length === 0) return out;
    const today = istToday();
    const rows = await this.dbs.db
      .selectFrom('scheduleTemplates')
      .select(['doctorId', 'hospitalId', 'weekday', 'startTime', 'endTime', 'onlinePerWindow', 'windowMinutes'])
      .where('doctorId', 'in', ids)
      .where('validFrom', '<=', today)
      .where((eb) => eb.or([eb('validTo', 'is', null), eb('validTo', '>=', today)]))
      .orderBy('weekday')
      .orderBy('startTime')
      .execute();
    for (const r of rows) {
      const list = out.get(r.doctorId) ?? [];
      list.push({ hospitalId: r.hospitalId, weekday: r.weekday, start: hhmm(r.startTime), end: hhmm(r.endTime), perHour: Math.round((r.onlinePerWindow * 60) / r.windowMinutes) });
      out.set(r.doctorId, list);
    }
    return out;
  }

  toCard(r: CardRow) {
    const now = Date.now();
    const emergencyOn =
      r.emStatus === 'available_now' || (r.emStatus === 'available_till' && r.emUntil !== null && new Date(r.emUntil).getTime() > now);
    return {
      id: r.id,
      name: r.name,
      gender: r.gender,
      type: { id: r.typeId, name: r.typeName, properName: r.properName },
      degrees: r.degrees,
      yearsExperience: r.yearsExperience,
      languages: r.languages,
      about: r.about,
      fee: money(r.feePaise),
      photo: this.photo(r.photoKey),
      verified: r.verification === 'verified',
      bookingsPaused: r.bookingsPaused,
      emergency: emergencyOn
        ? {
            status: r.emStatus as 'available_now' | 'available_till',
            until: r.emUntil,
            hospitalId: r.emHospitalId,
            mode: r.emMode,
            updatedAt: r.emUpdatedAt,
          }
        : null,
      hospitals: (r.hospitals ?? []).map((h) => ({
        id: h.id,
        name: h.name,
        area: h.area,
        city: h.city,
        isPrimary: h.isPrimary,
        fee: money(h.feePaise ?? r.feePaise),
        distanceKm: h.distanceM === null ? null : Math.round(h.distanceM / 100) / 10,
      })),
      distanceKm: r.distanceM === null ? null : Math.round(Number(r.distanceM) / 100) / 10,
      nextFree:
        r.nfWindowId && r.nfStartsAt && r.nfEndsAt && r.nfDate
          ? {
              windowId: r.nfWindowId,
              sessionId: r.nfSessionId,
              hospitalId: r.nfHospitalId,
              date: r.nfDate,
              dayLabel: istDayLabel(r.nfDate),
              startsAt: r.nfStartsAt,
              endsAt: r.nfEndsAt,
              label: istRange(new Date(r.nfStartsAt), new Date(r.nfEndsAt)),
              free: r.nfFree ?? 0,
              capacity: r.nfCapacity ?? 0,
            }
          : null,
    };
  }

  /** A doctor's full public page: card + weekly timings per hospital. */
  async doctor(id: string, opts: { includeUnlisted?: boolean } = {}) {
    const { items } = await this.cards({ ids: [id], limit: 1, includeUnlisted: opts.includeUnlisted });
    const card = items[0];
    if (!card) throw new AppError('DOCTOR_NOT_FOUND', 'This doctor is not on OPflow right now.', HttpStatus.NOT_FOUND);
    return { ...card, timings: await this.weeklyTimings(id) };
  }

  /** "Mon – Sat · 9 AM – 1 PM" data: per hospital, per weekday, the blocks the doctor sits. */
  async weeklyTimings(doctorId: string) {
    const today = istToday();
    const rows = await this.dbs.db
      .selectFrom('scheduleTemplates')
      .select(['hospitalId', 'weekday', 'startTime', 'endTime', 'onlinePerWindow', 'windowMinutes'])
      .where('doctorId', '=', doctorId)
      .where('validFrom', '<=', today)
      .where((eb) => eb.or([eb('validTo', 'is', null), eb('validTo', '>=', today)]))
      .orderBy('hospitalId')
      .orderBy('weekday')
      .orderBy('startTime')
      .execute();
    const byHospital = new Map<string, { weekday: number; blocks: { start: string; end: string; perHour: number }[] }[]>();
    for (const r of rows) {
      const days = byHospital.get(r.hospitalId) ?? Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, blocks: [] as { start: string; end: string; perHour: number }[] }));
      days[r.weekday - 1]!.blocks.push({ start: hhmm(r.startTime), end: hhmm(r.endTime), perHour: Math.round((r.onlinePerWindow * 60) / r.windowMinutes) });
      byHospital.set(r.hospitalId, days);
    }
    return [...byHospital.entries()].map(([hospitalId, days]) => ({ hospitalId, days }));
  }

  /** The 14-day strip: free places per day. */
  async days(doctorId: string, hospitalId?: string) {
    await this.requireListed(doctorId);
    const today = istToday();
    const rows = await sql<{ date: string; sessions: number; free: number; capacity: number }>`
      select s.date, count(distinct s.id)::int as sessions,
             count(ws.*) filter (where ws.state = 'free' and w.status = 'open'
                                   and w.starts_at - make_interval(mins => s.close_minutes_before) > now())::int as free,
             count(ws.*) filter (where ws.state <> 'blocked')::int as capacity
        from opd_sessions s
        join opd_windows w on w.session_id = s.id
        left join window_slots ws on ws.window_id = w.id
       where s.doctor_id = ${doctorId} and s.status in ('scheduled', 'running', 'paused')
         and s.date between ${today}::date and ${addDays(today, 13)}::date
         and (${hospitalId ?? null}::uuid is null or s.hospital_id = ${hospitalId ?? null}::uuid)
       group by s.date order by s.date`.execute(this.dbs.db);
    const byDate = new Map(rows.rows.map((r) => [r.date, r]));
    return Array.from({ length: 14 }, (_, i) => {
      const date = addDays(today, i);
      const r = byDate.get(date);
      return { date, dayLabel: istDayLabel(date), works: !!r, free: r?.free ?? 0, capacity: r?.capacity ?? 0 };
    });
  }

  /** Hours on one day with places: capacity, booked, held, free and whether it can still be booked. */
  async windows(doctorId: string, date: string, hospitalId?: string) {
    const doctor = await this.requireListed(doctorId);
    const rows = await sql<{
      id: string; sessionId: string; hospitalId: string; startsAt: Date; endsAt: Date; status: string; sessionStatus: string;
      closeMinutesBefore: number; capacity: number; free: number; held: number; booked: number;
    }>`
      select w.id, s.id as session_id, s.hospital_id, w.starts_at, w.ends_at, w.status, s.status as session_status,
             s.close_minutes_before, w.capacity,
             count(ws.*) filter (where ws.state = 'free')::int as free,
             count(ws.*) filter (where ws.state = 'held')::int as held,
             count(ws.*) filter (where ws.state = 'booked')::int as booked
        from opd_sessions s
        join opd_windows w on w.session_id = s.id
        left join window_slots ws on ws.window_id = w.id
       where s.doctor_id = ${doctorId} and s.date = ${date}::date and s.status in ('scheduled', 'running', 'paused')
         and (${hospitalId ?? null}::uuid is null or s.hospital_id = ${hospitalId ?? null}::uuid)
       group by w.id, s.id
       order by w.starts_at`.execute(this.dbs.db);
    const now = Date.now();
    return rows.rows.map((w) => {
      const closesAt = new Date(new Date(w.startsAt).getTime() - w.closeMinutesBefore * 60_000);
      const bookable = !doctor.bookingsPaused && w.status === 'open' && closesAt.getTime() > now && w.free > 0;
      return {
        id: w.id,
        sessionId: w.sessionId,
        hospitalId: w.hospitalId,
        startsAt: w.startsAt,
        endsAt: w.endsAt,
        label: istRange(new Date(w.startsAt), new Date(w.endsAt)),
        capacity: w.capacity,
        booked: w.booked,
        held: w.held,
        free: w.free,
        bookable,
        closesAt,
        why: bookable ? null : doctor.bookingsPaused ? 'The doctor is not taking new bookings right now.' : closesAt.getTime() <= now ? 'Booking for this time has closed.' : w.free === 0 ? 'Full' : 'Closed',
      };
    });
  }

  async requireListed(doctorId: string) {
    const d = await this.dbs.db
      .selectFrom('doctors')
      .select(['id', 'bookingsPaused', 'feePaise'])
      .where('id', '=', doctorId)
      .where('verification', '=', 'verified')
      .where('status', '=', 'active')
      .executeTakeFirst();
    if (!d) throw new AppError('DOCTOR_NOT_FOUND', 'This doctor is not on OPflow right now.', HttpStatus.NOT_FOUND);
    return d;
  }

  // ── Hospitals ──────────────────────────────────────────────────────────────────────────────────────

  async hospitals(f: { q?: string; near?: { lat: number; lng: number }; type?: string; emergency?: boolean; offset: number; limit: number; includeHidden?: boolean }) {
    const lat = f.near?.lat ?? null;
    const lng = f.near?.lng ?? null;
    const q = f.q?.trim() ? f.q.trim() : null;
    const rows = await sql<{
      id: string; slug: string; name: string; address: string; area: string; city: string; pin: string; lat: number; lng: number;
      phone: string; opdTimingsText: string | null; hasEmergency: boolean; facadeSeed: number; status: string;
      departments: string[] | null; doctorCount: number; distanceM: number | null;
    }>`
      select h.id, h.slug, h.name, h.address, h.area, h.city, h.pin, h.lat, h.lng, h.phone, h.opd_timings_text, h.has_emergency,
             h.facade_seed, h.status,
             (select array_agg(hd.type_id order by hd.type_id) from hospital_departments hd where hd.hospital_id = h.id) as departments,
             (select count(*)::int from doctor_hospitals dh join doctors d on d.id = dh.doctor_id
               where dh.hospital_id = h.id and dh.status = 'active' and d.verification = 'verified' and d.status = 'active') as doctor_count,
             case when ${lat}::float8 is null then null
                  else earth_distance(ll_to_earth(h.lat, h.lng), ll_to_earth(${lat}::float8, ${lng}::float8)) end as distance_m
        from hospitals h
       where (${f.includeHidden ?? false}::boolean or h.status = 'active')
         and (${q}::text is null or h.search @@ plainto_tsquery('simple', ${q}::text) or h.name ilike '%' || ${q}::text || '%'
              or similarity(h.name, ${q}::text) > 0.3 or h.area ilike '%' || ${q}::text || '%')
         and (${f.type ?? null}::text is null or exists (select 1 from hospital_departments hd where hd.hospital_id = h.id and hd.type_id = ${f.type ?? null}::text))
         and (${f.emergency ?? null}::boolean is null or h.has_emergency = ${f.emergency ?? null}::boolean)
       order by distance_m asc nulls last, h.name asc
       limit ${f.limit + 1} offset ${f.offset}`.execute(this.dbs.db);
    const items = rows.rows.slice(0, f.limit).map((h) => ({
      id: h.id,
      slug: h.slug,
      name: h.name,
      address: h.address,
      area: h.area,
      city: h.city,
      pin: h.pin,
      location: { lat: h.lat, lng: h.lng },
      phone: h.phone,
      opdTimings: h.opdTimingsText,
      hasEmergency: h.hasEmergency,
      facadeSeed: h.facadeSeed,
      departments: h.departments ?? [],
      doctorCount: h.doctorCount,
      distanceKm: h.distanceM === null ? null : Math.round(Number(h.distanceM) / 100) / 10,
      ...(f.includeHidden ? { status: h.status } : {}),
    }));
    return { items, hasMore: rows.rows.length > f.limit };
  }

  async hospital(id: string) {
    const h = await this.dbs.db.selectFrom('hospitals').select('id').where('id', '=', id).where('status', '=', 'active').executeTakeFirst();
    if (!h) throw new AppError('HOSPITAL_NOT_FOUND', 'We could not find this hospital.', HttpStatus.NOT_FOUND);
    const base = await this.dbs.db.selectFrom('hospitals').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    const departments = await this.dbs.db.selectFrom('hospitalDepartments').select('typeId').where('hospitalId', '=', id).execute();
    const doctors = await this.cards({ hospital: id, limit: 50 });
    return {
      id: base.id,
      slug: base.slug,
      name: base.name,
      address: base.address,
      area: base.area,
      city: base.city,
      pin: base.pin,
      location: { lat: base.lat, lng: base.lng },
      phone: base.phone,
      opdTimings: base.opdTimingsText,
      hasEmergency: base.hasEmergency,
      facadeSeed: base.facadeSeed,
      departments: departments.map((d) => d.typeId),
      doctors: doctors.items,
    };
  }
}
