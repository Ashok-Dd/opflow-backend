import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { sql } from 'kysely';

import type { AdminPrincipal, RequestMeta } from '../../common/auth/auth.decorators';
import { audit } from '../../common/audit';
import { oneTimePassword } from '../../common/crypto';
import { AppError } from '../../common/errors/app-error';
import { isUniqueViolation } from '../../common/errors/pg-errors';
import { money } from '../../common/money';
import { enqueue, uuidv7 } from '../../common/outbox';
import { maskContact } from '../../infra/messaging/messaging';
import { DbService, Tx } from '../../infra/db/db.service';
import type { DocumentKind } from '../../infra/db/schema';
import { PAYMENT_GATEWAY, PaymentGateway } from '../../infra/payments/gateway';
import { STORAGE, Storage } from '../../infra/storage/storage';
import { PasswordsService } from '../auth/passwords.service';
import { TokensService } from '../auth/tokens.service';
import { DirectoryService } from '../directory/directory.service';
import { ScheduleService } from '../schedule/schedule.service';
import { ChangesService } from './changes.service';

export interface CreateDoctorInput {
  name: string;
  gender: 'female' | 'male' | 'other';
  phone: string;
  email?: string;
  typeId: string;
  degrees: string;
  regCouncil: string;
  regNo: string;
  regYear?: number;
  yearsExperience?: number;
  languages?: string[];
  about?: string;
  feePaise: number;
  hospitals: { hospitalId: string; isPrimary?: boolean; feePaiseOverride?: number | null }[];
  documents?: { kind: DocumentKind; key: string }[];
  photoUploadKey?: string;
}

const as = (who: AdminPrincipal) => ({ role: 'admin' as const, adminId: who.adminId });
const titleCase = (s: string) => s.trim().replace(/\s+/g, ' ').replace(/\b([a-z])/g, (m) => m.toUpperCase());

/**
 * The only way a doctor enters OPflow (rule A1). Everything runs as `admin`, so the database's own
 * "only admins add doctors" rule is satisfied here and nowhere else.
 */
@Injectable()
export class AdminDoctorsService {
  constructor(
    private readonly dbs: DbService,
    private readonly passwords: PasswordsService,
    private readonly tokens: TokensService,
    private readonly changes: ChangesService,
    private readonly dir: DirectoryService,
    private readonly schedule: ScheduleService,
    @Inject(STORAGE) private readonly storage: Storage,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  async list(f: { q?: string; verification?: string; type?: string; hospital?: string; status?: string; limit: number; offset: number }) {
    const q = f.q?.trim() || null;
    const rows = await this.dbs.sys(sql<Record<string, unknown>>`
      select d.id, d.name, d.type_id, t.simple_name as type_name, d.verification, d.status, d.fee_paise, d.photo_key, d.created_at,
             d.listed_at, c.login_id, u.phone,
             (select json_agg(h.name order by dh.is_primary desc) from doctor_hospitals dh join hospitals h on h.id = dh.hospital_id
               where dh.doctor_id = d.id and dh.status = 'active') as hospitals,
             (select max(s.date) from opd_sessions s where s.doctor_id = d.id and s.status = 'ended') as last_opd,
             pa.status as payout_status
        from doctors d join doctor_types t on t.id = d.type_id join users u on u.id = d.user_id
        left join doctor_credentials c on c.user_id = d.user_id left join payout_accounts pa on pa.doctor_id = d.id
       where (${q}::text is null or d.name ilike '%' || ${q}::text || '%' or c.login_id = upper(${q}::text)
              or u.phone = ${q}::text or d.reg_no = ${q}::text)
         and (${f.verification ?? null}::text is null or d.verification::text = ${f.verification ?? null}::text)
         and (${f.status ?? null}::text is null or d.status::text = ${f.status ?? null}::text)
         and (${f.type ?? null}::text is null or d.type_id = ${f.type ?? null}::text)
         and (${f.hospital ?? null}::uuid is null or exists (select 1 from doctor_hospitals dh where dh.doctor_id = d.id and dh.hospital_id = ${f.hospital ?? null}::uuid))
       order by d.created_at desc limit ${f.limit + 1} offset ${f.offset}`);
    return rows.rows.map((r) => ({ ...r, phone: r.phone ? maskContact(String(r.phone)) : null, photo: this.dir.photo(r.photoKey as string | null) }));
  }

  /** Doctor page (overview tab): the card patients see, the checklist, login and payout state. */
  async get(id: string) {
    const d = await this.dbs.db
      .selectFrom('doctors as d')
      .innerJoin('users as u', 'u.id', 'd.userId')
      .leftJoin('doctorCredentials as c', 'c.userId', 'd.userId')
      .select([
        'd.id', 'd.userId', 'd.name', 'd.gender', 'd.typeId', 'd.degrees', 'd.regCouncil', 'd.regNo', 'd.yearsExperience', 'd.languages', 'd.about',
        'd.feePaise', 'd.photoKey', 'd.verification', 'd.verificationNote', 'd.verifiedAt', 'd.status', 'd.bookingsPaused', 'd.listedAt', 'd.createdAt',
        'u.phone', 'u.email', 'u.lastLoginAt', 'c.loginId', 'c.mustChange', 'c.lockedUntil', 'c.failedAttempts',
      ])
      .where('d.id', '=', id)
      .executeTakeFirst();
    if (!d) throw new AppError('DOCTOR_NOT_FOUND', 'We could not find this doctor.', HttpStatus.NOT_FOUND);
    const [documents, hospitals, payout] = await Promise.all([
      this.dbs.db.selectFrom('doctorDocuments').select(['id', 'kind', 'status', 'note', 'reviewedAt', 'createdAt']).where('doctorId', '=', id).orderBy('createdAt').execute(),
      this.dbs.db
        .selectFrom('doctorHospitals as dh')
        .innerJoin('hospitals as h', 'h.id', 'dh.hospitalId')
        .select(['h.id', 'h.name', 'h.area', 'dh.isPrimary', 'dh.feePaiseOverride', 'dh.status'])
        .where('dh.doctorId', '=', id)
        .execute(),
      this.dbs.db.selectFrom('payoutAccounts').select(['status', 'bankLast4', 'ifsc', 'razorpayAccountId']).where('doctorId', '=', id).executeTakeFirst(),
    ]);
    const devices = await this.dbs.system((tx) => this.tokens.liveSessions(tx, d.userId, 'doctor'));
    const approved = (k: DocumentKind) => documents.some((x) => x.kind === k && x.status === 'approved');
    const preview = await this.dir.doctor(id, { includeUnlisted: true }).catch(() => null);
    return {
      ...d,
      phone: d.phone ? maskContact(d.phone) : null,
      fee: money(d.feePaise),
      photo: this.dir.photo(d.photoKey),
      documents,
      hospitals,
      devices: devices.reverse().map((x) => ({ id: x.familyId, device: x.deviceLabel.replace(/^an? /, ''), appVersion: x.appVersion, signedInAt: x.startedAt, lastUsedAt: x.lastUsedAt, ip: x.ip })),
      payout: payout ?? null,
      checklist: {
        degreeApproved: approved('degree'),
        registrationApproved: approved('registration'),
        idApproved: approved('id_proof'),
        hospitalLinked: hospitals.some((h) => h.status === 'active'),
        payoutActive: payout?.status === 'active',
      },
      preview,
      timings: await this.dir.weeklyTimings(id),
    };
  }

  /** The wizard's final "Create doctor": one transaction, then the login is sent by SMS + email separately. */
  async create(who: AdminPrincipal, input: CreateDoctorInput, meta: RequestMeta) {
    if (!input.hospitals.length) throw new AppError('HOSPITAL_NEEDED', 'Please link at least one hospital.', HttpStatus.UNPROCESSABLE_ENTITY);
    const password = oneTimePassword(12);
    const hash = await this.passwords.hash(password);
    try {
      return await this.dbs.as(as(who), async (tx) => {
        const existing = await tx.selectFrom('users').select(['id']).where('phone', '=', input.phone).executeTakeFirst();
        if (existing) {
          const isDoctor = await tx.selectFrom('doctors').select('id').where('userId', '=', existing.id).executeTakeFirst();
          if (isDoctor) throw new AppError('ALREADY_DOCTOR', 'A doctor with this mobile number is already on OPflow.', HttpStatus.CONFLICT);
        }
        const userId =
          existing?.id ??
          (await tx.insertInto('users').values({ phone: input.phone, email: input.email?.toLowerCase() ?? null }).returning('id').executeTakeFirstOrThrow()).id;
        await tx.insertInto('userRoles').values({ userId, role: 'doctor' }).onConflict((oc) => oc.doNothing()).execute();
        const doctorId = uuidv7();
        await tx
          .insertInto('doctors')
          .values({
            id: doctorId,
            userId,
            name: titleCase(input.name),
            typeId: input.typeId,
            degrees: input.degrees.trim(),
            regCouncil: input.regCouncil.trim().toUpperCase(),
            regNo: input.regNo.trim(),
            gender: input.gender,
            yearsExperience: input.yearsExperience ?? 0,
            languages: input.languages ?? [],
            about: input.about?.trim() ?? '',
            feePaise: input.feePaise,
            createdByAdmin: who.adminId,
          })
          .execute();
        const primary = input.hospitals.find((h) => h.isPrimary)?.hospitalId ?? input.hospitals[0]!.hospitalId;
        await tx
          .insertInto('doctorHospitals')
          .values(input.hospitals.map((h) => ({ doctorId, hospitalId: h.hospitalId, isPrimary: h.hospitalId === primary, feePaiseOverride: h.feePaiseOverride ?? null })))
          .execute();
        for (const doc of input.documents ?? []) {
          if (!doc.key.startsWith('pending/')) throw new AppError('BAD_UPLOAD', 'Please upload the documents again.', HttpStatus.BAD_REQUEST);
          await tx.insertInto('doctorDocuments').values({ doctorId, kind: doc.kind, fileKey: doc.key }).execute();
        }
        await tx.insertInto('payoutAccounts').values({ doctorId }).execute();
        await tx.insertInto('emergencyStatus').values({ doctorId }).execute();
        const login = await sql<{ id: string }>`select next_doctor_login_id() as id`.execute(tx);
        const loginId = login.rows[0]!.id;
        await tx.insertInto('doctorCredentials').values({ userId, loginId, passwordHash: hash, mustChange: true }).execute();
        if (input.photoUploadKey) await enqueue(tx, { topic: 'photo.process', payload: { doctorId, uploadKey: input.photoUploadKey } });
        // Two separate messages: the ID by email, the password by SMS. One alone is not enough to log in.
        await enqueue(tx, {
          topic: 'sms',
          payload: { to: input.phone, variables: { password }, text: `Your OPflow one-time password is ${password}. You will set your own password at first login.` },
        });
        if (input.email) {
          await enqueue(tx, {
            topic: 'email',
            payload: {
              to: input.email,
              subject: 'Welcome to OPflow: your login ID',
              text: `Hello ${titleCase(input.name)},\n\nYour OPflow login ID is ${loginId}. Your one-time password comes by SMS.\nOpen the OPflow app, choose "I am a doctor" and log in. You will choose your own password.\n\nThe OPflow team`,
            },
          });
        }
        await audit(tx, {
          actorType: 'admin',
          actorId: who.adminId,
          action: 'doctor.create',
          entity: 'doctor',
          entityId: doctorId,
          after: { name: input.name, typeId: input.typeId, regCouncil: input.regCouncil, regNo: input.regNo, loginId, hospitals: input.hospitals.map((h) => h.hospitalId) },
          meta,
        });
        // The one-time password is shown ONCE, to read out on the phone if the SMS doesn't arrive.
        return { doctorId, loginId, oneTimePassword: password, verification: 'pending', message: 'Doctor created. Not visible to patients until verified by a second admin.' };
      });
    } catch (err) {
      if (isUniqueViolation(err, 'doctors_registration_unique')) {
        throw new AppError('DUPLICATE_REGISTRATION', 'A doctor with this council and registration number is already on OPflow.', HttpStatus.CONFLICT);
      }
      if (isUniqueViolation(err, 'users_email_key')) throw new AppError('EMAIL_USED', 'This email is already used by another account.', HttpStatus.CONFLICT);
      throw err;
    }
  }

  /** Everything applies at once. Locked fields (name, type, degrees, registration) need a written reason. */
  async update(
    who: AdminPrincipal,
    id: string,
    body: { gender?: 'female' | 'male' | 'other'; yearsExperience?: number; languages?: string[]; about?: string; feePaise?: number; locked?: { name?: string; typeId?: string; degrees?: string; regCouncil?: string; regNo?: string }; reason?: string },
    meta: RequestMeta,
  ) {
    return this.dbs.as(as(who), async (tx) => {
      const before = await tx.selectFrom('doctors').selectAll().where('id', '=', id).executeTakeFirst();
      if (!before) throw new AppError('DOCTOR_NOT_FOUND', 'We could not find this doctor.', HttpStatus.NOT_FOUND);
      const { locked, reason, ...plain } = body;
      const set = Object.fromEntries(Object.entries(plain).filter(([, v]) => v !== undefined));
      if (Object.keys(set).length) {
        await tx.updateTable('doctors').set(set).where('id', '=', id).execute();
        await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'doctor.update', entity: 'doctor', entityId: id, before: Object.fromEntries(Object.keys(set).map((k) => [k, (before as Record<string, unknown>)[k]])), after: set, meta });
      }
      let lockedChanged = false;
      if (locked && Object.values(locked).some((v) => v !== undefined && v !== '')) {
        if (!reason || reason.trim().length < 5) throw new AppError('REASON_NEEDED', 'Please write why these details must change.', HttpStatus.BAD_REQUEST);
        // Registered details are sensitive: they need a fresh authenticator code (plain edits don't).
        if (Date.now() / 1000 - who.stepUpAt > 300) {
          throw new AppError('STEP_UP_REQUIRED', 'Please enter your authenticator code again.', HttpStatus.FORBIDDEN);
        }
        await this.changes.apply(tx, who, { type: 'doctor', id }, { kind: 'edit_doctor_locked', doctorId: id, changes: locked }, reason, meta);
        lockedChanged = true;
      }
      return { ok: true, lockedChanged };
    });
  }

  /** Makes the doctor visible to patients (the admin has gone through the checklist). */
  async verify(who: AdminPrincipal, id: string, reason: string, meta: RequestMeta) {
    return this.dbs.as(as(who), async (tx) => {
      const d = await tx.selectFrom('doctors').select(['verification', 'status']).where('id', '=', id).executeTakeFirst();
      if (!d) throw new AppError('DOCTOR_NOT_FOUND', 'We could not find this doctor.', HttpStatus.NOT_FOUND);
      if (d.verification === 'verified') throw new AppError('ALREADY_VERIFIED', 'This doctor is already verified.', HttpStatus.CONFLICT);
      const link = await tx.selectFrom('doctorHospitals').select('doctorId').where('doctorId', '=', id).where('status', '=', 'active').executeTakeFirst();
      if (!link) throw new AppError('HOSPITAL_NEEDED', 'Please link at least one hospital first.', HttpStatus.UNPROCESSABLE_ENTITY);
      await this.changes.apply(tx, who, { type: 'doctor', id }, { kind: 'verify_doctor', doctorId: id }, reason, meta);
      return { verified: true, message: 'Verified. Patients can find this doctor now.' };
    });
  }

  async needsCorrection(who: AdminPrincipal, id: string, note: string, meta: RequestMeta) {
    await this.dbs.as(as(who), async (tx) => {
      await tx.updateTable('doctors').set({ verification: 'needs_correction', verificationNote: note }).where('id', '=', id).where('verification', '<>', 'verified').execute();
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'doctor.needs_correction', entity: 'doctor', entityId: id, after: { note }, meta });
    });
    return { ok: true };
  }

  /** Hides the doctor at once; every future booking gets all its money back (background jobs). */
  async suspend(who: AdminPrincipal, id: string, reason: string, meta: RequestMeta) {
    return this.dbs.as(as(who), async (tx) => {
      const future = await tx.selectFrom('bookings').select((eb) => [eb.fn.countAll<string>().as('n'), eb.fn.coalesce(eb.fn.sum<number>(sql`fee_paise + emergency_charge_paise`), eb.lit(0)).as('paise')]).where('doctorId', '=', id).where('status', '=', 'confirmed').executeTakeFirstOrThrow();
      await this.changes.apply(tx, who, { type: 'doctor', id }, { kind: 'suspend_doctor', doctorId: id }, reason, meta);
      return { suspended: true, futureBookings: Number(future.n), refundTotal: money(Number(future.paise)) };
    });
  }

  /** Makes a suspended doctor active again (they must be verified to be listed). */
  async reactivate(who: AdminPrincipal, id: string, meta: RequestMeta) {
    await this.dbs.as(as(who), async (tx) => {
      await tx.updateTable('doctors').set({ status: 'active' }).where('id', '=', id).execute();
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'doctor.reactivate', entity: 'doctor', entityId: id, meta });
    });
    return { ok: true };
  }

  // ── Documents (private bucket, 5-minute links) ────────────────────────────────────────────────────

  /** Before the doctor exists (wizard step 3): an upload link under pending/. */
  async wizardUploadUrl(contentType: string) {
    const ext = contentType === 'application/pdf' ? 'pdf' : contentType === 'image/png' ? 'png' : 'jpg';
    const key = `pending/${uuidv7()}.${ext}`;
    const put = await this.storage.presignPut('private', key, contentType, 600);
    return { key, url: put.url, headers: put.headers, method: 'PUT', expiresInSeconds: 600 };
  }

  async documentUploadUrl(who: AdminPrincipal, doctorId: string, kind: DocumentKind, contentType: string, meta: RequestMeta) {
    const ext = contentType === 'application/pdf' ? 'pdf' : contentType === 'image/png' ? 'png' : 'jpg';
    const key = `doctors/${doctorId}/documents/${uuidv7()}.${ext}`;
    const doc = await this.dbs.as(as(who), async (tx) => {
      const row = await tx.insertInto('doctorDocuments').values({ doctorId, kind, fileKey: key }).returning('id').executeTakeFirstOrThrow();
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'doctor.document_add', entity: 'doctor', entityId: doctorId, after: { kind, documentId: row.id }, meta });
      return row;
    });
    const put = await this.storage.presignPut('private', key, contentType, 600);
    return { documentId: doc.id, url: put.url, headers: put.headers, method: 'PUT', expiresInSeconds: 600 };
  }

  async documentUrl(who: AdminPrincipal, doctorId: string, docId: string, meta: RequestMeta) {
    const doc = await this.dbs.db.selectFrom('doctorDocuments').select(['fileKey', 'kind']).where('id', '=', docId).where('doctorId', '=', doctorId).executeTakeFirst();
    if (!doc) throw new AppError('NOT_FOUND', 'We could not find this document.', HttpStatus.NOT_FOUND);
    await this.dbs.as(as(who), (tx) => audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'doctor.document_view', entity: 'doctor', entityId: doctorId, after: { docId }, meta }));
    return { url: await this.storage.presignGet('private', doc.fileKey, 300), expiresInSeconds: 300 };
  }

  async reviewDocument(who: AdminPrincipal, doctorId: string, docId: string, status: 'approved' | 'rejected', note: string | undefined, meta: RequestMeta) {
    await this.dbs.as(as(who), async (tx) => {
      const r = await tx
        .updateTable('doctorDocuments')
        .set({ status, note: note ?? null, reviewedBy: who.adminId, reviewedAt: new Date() })
        .where('id', '=', docId)
        .where('doctorId', '=', doctorId)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) !== 1) throw new AppError('NOT_FOUND', 'We could not find this document.', HttpStatus.NOT_FOUND);
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: `doctor.document_${status}`, entity: 'doctor', entityId: doctorId, after: { docId, note }, meta });
    });
    return { ok: true };
  }

  // ── Hospitals, payout ─────────────────────────────────────────────────────────────────────────────

  async addHospital(who: AdminPrincipal, doctorId: string, h: { hospitalId: string; isPrimary?: boolean; feePaiseOverride?: number | null }, meta: RequestMeta) {
    await this.dbs.as(as(who), async (tx) => {
      if (h.isPrimary) await tx.updateTable('doctorHospitals').set({ isPrimary: false }).where('doctorId', '=', doctorId).execute();
      await tx
        .insertInto('doctorHospitals')
        .values({ doctorId, hospitalId: h.hospitalId, isPrimary: h.isPrimary ?? false, feePaiseOverride: h.feePaiseOverride ?? null })
        .onConflict((oc) => oc.columns(['doctorId', 'hospitalId']).doUpdateSet({ status: 'active', isPrimary: h.isPrimary ?? false, feePaiseOverride: h.feePaiseOverride ?? null }))
        .execute();
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'doctor.hospital_add', entity: 'doctor', entityId: doctorId, after: h, meta });
    });
    return { ok: true };
  }

  /** Unlinking hides the hospital; future OPDs there with bookings are reported (cancel them via the doctor flow). */
  async removeHospital(who: AdminPrincipal, doctorId: string, hospitalId: string, meta: RequestMeta) {
    return this.dbs.as(as(who), async (tx) => {
      await tx.updateTable('doctorHospitals').set({ status: 'hidden', isPrimary: false }).where('doctorId', '=', doctorId).where('hospitalId', '=', hospitalId).execute();
      const report = await this.schedule.syncDoctor(tx, doctorId);
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'doctor.hospital_remove', entity: 'doctor', entityId: doctorId, after: { hospitalId, keptWithBookings: report.keptWithBookings.length }, meta });
      return { ok: true, sessionsWithBookings: report.keptWithBookings };
    });
  }

  /** Razorpay Route linked account (the doctor's bank). Only the last 4 digits are stored. */
  async payoutAccount(
    who: AdminPrincipal,
    doctorId: string,
    b: { holderName: string; accountNumber: string; ifsc: string; pan: string; email: string; address: { street: string; city: string; state: string; pin: string } },
    meta: RequestMeta,
  ) {
    const d = await this.dbs.db
      .selectFrom('doctors as d')
      .innerJoin('users as u', 'u.id', 'd.userId')
      .select(['d.id', 'u.phone'])
      .where('d.id', '=', doctorId)
      .executeTakeFirst();
    if (!d) throw new AppError('DOCTOR_NOT_FOUND', 'We could not find this doctor.', HttpStatus.NOT_FOUND);
    const acc = await this.gateway.createLinkedAccount({
      referenceId: doctorId.replace(/-/g, '').slice(0, 20),
      name: b.holderName,
      email: b.email,
      phone: d.phone ?? '',
      pan: b.pan,
      accountNumber: b.accountNumber,
      ifsc: b.ifsc,
      address: b.address,
    });
    await this.dbs.as(as(who), async (tx) => {
      await tx
        .insertInto('payoutAccounts')
        .values({ doctorId, razorpayAccountId: acc.accountId, status: acc.active ? 'active' : 'pending', bankLast4: b.accountNumber.slice(-4), ifsc: b.ifsc })
        .onConflict((oc) => oc.column('doctorId').doUpdateSet({ razorpayAccountId: acc.accountId, status: acc.active ? 'active' : 'pending', bankLast4: b.accountNumber.slice(-4), ifsc: b.ifsc }))
        .execute();
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'doctor.payout_account', entity: 'doctor', entityId: doctorId, after: { last4: b.accountNumber.slice(-4), ifsc: b.ifsc, active: acc.active }, meta });
    });
    return { status: acc.active ? 'active' : 'pending', bankLast4: b.accountNumber.slice(-4) };
  }

  // ── Login help ────────────────────────────────────────────────────────────────────────────────────

  async resetPassword(who: AdminPrincipal, doctorId: string, reason: string, meta: RequestMeta) {
    const password = oneTimePassword(12);
    const hash = await this.passwords.hash(password);
    return this.dbs.as(as(who), async (tx) => {
      const d = await tx
        .selectFrom('doctors as d')
        .innerJoin('users as u', 'u.id', 'd.userId')
        .innerJoin('doctorCredentials as c', 'c.userId', 'd.userId')
        .select(['d.userId', 'u.phone', 'c.loginId'])
        .where('d.id', '=', doctorId)
        .executeTakeFirst();
      if (!d) throw new AppError('DOCTOR_NOT_FOUND', 'We could not find this doctor.', HttpStatus.NOT_FOUND);
      await tx.updateTable('doctorCredentials').set({ passwordHash: hash, mustChange: true, failedAttempts: 0, lockedUntil: null }).where('userId', '=', d.userId).execute();
      await this.tokens.revokeAllForUser(tx, d.userId, 'doctor');
      if (d.phone) await enqueue(tx, { topic: 'sms', payload: { to: d.phone, variables: { password }, text: `Your new OPflow one-time password is ${password}. Log in with ${d.loginId} and set your own password.` } });
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'doctor.reset_password', entity: 'doctor', entityId: doctorId, after: { reason }, meta });
      return { loginId: d.loginId, oneTimePassword: password };
    });
  }

  async unlock(who: AdminPrincipal, doctorId: string, meta: RequestMeta) {
    await this.dbs.as(as(who), async (tx) => {
      await sql`update doctor_credentials c set failed_attempts = 0, locked_until = null from doctors d where d.user_id = c.user_id and d.id = ${doctorId}`.execute(tx);
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'doctor.unlock', entity: 'doctor', entityId: doctorId, meta });
    });
    return { ok: true };
  }

  async signOutEverywhere(who: AdminPrincipal, doctorId: string, meta: RequestMeta) {
    await this.dbs.as(as(who), async (tx) => {
      const d = await tx.selectFrom('doctors').select('userId').where('id', '=', doctorId).executeTakeFirstOrThrow();
      await this.tokens.revokeAllForUser(tx, d.userId, 'doctor');
      await audit(tx, { actorType: 'admin', actorId: who.adminId, action: 'doctor.sign_out_everywhere', entity: 'doctor', entityId: doctorId, meta });
    });
    return { ok: true };
  }

  history(doctorId: string, limit: number, offset: number) {
    return this.dbs.db
      .selectFrom('auditLog as l')
      .leftJoin('adminUsers as a', 'a.id', 'l.actorId')
      .select(['l.id', 'l.at', 'l.actorType', 'l.actorId', 'a.name as actorName', 'l.action', 'l.before', 'l.after'])
      .where('l.entity', '=', 'doctor')
      .where('l.entityId', '=', doctorId)
      .orderBy('l.at', 'desc')
      .limit(limit)
      .offset(offset)
      .execute();
  }

  sessions(doctorId: string, from: string, to: string) {
    return this.dbs.sys(sql`
      select s.id, s.date, s.status, s.starts_at, s.ends_at, h.name as hospital,
             count(b.*) filter (where b.status in ('confirmed', 'completed', 'no_show'))::int as booked,
             count(b.*) filter (where b.status = 'completed')::int as seen,
             count(b.*) filter (where b.status = 'no_show')::int as no_show
        from opd_sessions s join hospitals h on h.id = s.hospital_id left join bookings b on b.session_id = s.id
       where s.doctor_id = ${doctorId} and s.date between ${from}::date and ${to}::date
       group by s.id, h.name order by s.starts_at`).then((r) => r.rows);
  }
}
