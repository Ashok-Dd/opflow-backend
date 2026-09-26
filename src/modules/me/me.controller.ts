import { Controller, Delete, Get, HttpCode, HttpStatus, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';
import { z } from 'zod';

import { AppPrincipal, CurrentApp, Meta, PatientId, RequestMeta, Roles } from '../../common/auth/auth.decorators';
import { AppError } from '../../common/errors/app-error';
import { decodeCursor, encodeCursor, ZBody, zCursor, zLimit, ZQuery } from '../../common/http/zod';
import { DbService } from '../../infra/db/db.service';
import { RateLimit } from '../../infra/redis/rate-limit';
import { AuthService } from '../auth/auth.service';
import { zDevice } from '../auth/auth.controller';
import { TokensService } from '../auth/tokens.service';

const thisYear = () => new Date().getFullYear();
const profileBody = z
  .object({
    name: z.string().trim().min(2, 'Please write your name').max(80),
    age: z.number().int().min(0).max(120).optional(),
    birthYear: z.number().int().min(1900).max(2100).optional(),
    gender: z.enum(['female', 'male', 'other']),
    place: z.string().trim().max(60).optional(),
  })
  .refine((v) => v.age !== undefined || v.birthYear !== undefined, { message: 'Please give your age', path: ['age'] });
const prefsBody = z.object({
  reminders: z.boolean().optional(),
  lateAlerts: z.boolean().optional(),
  turnAlerts: z.boolean().optional(),
  emailReceipts: z.boolean().optional(),
  // Doctors
  newBookings: z.boolean().optional(),
  bookingChanges: z.boolean().optional(),
  eveningSummary: z.boolean().optional(),
});
const prefColumns = ['reminders', 'lateAlerts', 'turnAlerts', 'emailReceipts', 'newBookings', 'bookingChanges', 'eveningSummary'] as const;
const prefDefaults = { reminders: true, lateAlerts: true, turnAlerts: true, emailReceipts: true, newBookings: true, bookingChanges: true, eveningSummary: true };
const readBody = z.union([z.object({ ids: z.array(z.uuid()).min(1).max(100) }), z.object({ all: z.literal(true) })]);
const ticketBody = z.object({ message: z.string().trim().min(5, 'Please write a little more').max(2000) });

/** The patient's own account: profile, notification settings, devices, messages, deletion. */
@ApiTags('me')
@Controller('v1')
export class MeController {
  constructor(
    private readonly dbs: DbService,
    private readonly auth: AuthService,
    private readonly tokens: TokensService,
  ) {}

  @Get('me')
  @Roles('patient')
  async me(@PatientId() userId: string) {
    return this.dbs.as({ role: 'patient', userId }, async (tx) => {
      const user = await tx.selectFrom('users').select(['id', 'phone', 'email', 'createdAt']).where('id', '=', userId).executeTakeFirstOrThrow();
      const profile = await tx.selectFrom('patientProfiles').select(['name', 'birthYear', 'gender', 'place']).where('userId', '=', userId).executeTakeFirst();
      return {
        ...user,
        needsProfile: !profile,
        profile: profile ? { ...profile, age: thisYear() - profile.birthYear } : null,
      };
    });
  }

  /** Create or update the profile (name, age, gender, place). Bookings copy it at booking time. */
  @Patch('me')
  @Roles('patient')
  async update(@PatientId() userId: string, @ZBody(profileBody) body: z.output<typeof profileBody>) {
    const birthYear = body.birthYear ?? thisYear() - body.age!;
    await this.dbs.as({ role: 'patient', userId }, (tx) =>
      tx
        .insertInto('patientProfiles')
        .values({ userId, name: body.name, birthYear, gender: body.gender, place: body.place ?? null })
        .onConflict((oc) => oc.column('userId').doUpdateSet({ name: body.name, birthYear, gender: body.gender, place: body.place ?? null }))
        .execute(),
    );
    return this.me(userId);
  }

  /** Which messages reach the phone. Patients and doctors (each sees their own switches). */
  @Get('me/notification-prefs')
  async prefs(@CurrentApp() who: AppPrincipal) {
    return this.prefsOf(who.userId);
  }

  @Patch('me/notification-prefs')
  async setPrefs(@CurrentApp() who: AppPrincipal, @ZBody(prefsBody) body: z.output<typeof prefsBody>) {
    const userId = who.userId;
    await this.dbs.system((tx) =>
      tx.insertInto('notificationPrefs').values({ userId, ...body }).onConflict((oc) => oc.column('userId').doUpdateSet({ ...body, updatedAt: new Date() })).execute(),
    );
    return this.prefsOf(userId);
  }

  private async prefsOf(userId: string) {
    const p = await this.dbs.db.selectFrom('notificationPrefs').select([...prefColumns]).where('userId', '=', userId).executeTakeFirst();
    return p ?? prefDefaults;
  }

  /** Register this phone for pushes (patients and doctors). */
  @Post('me/devices')
  @HttpCode(200)
  async device(@CurrentApp() who: AppPrincipal, @ZBody(zDevice.unwrap()) body: NonNullable<z.output<typeof zDevice>>) {
    const id = await this.dbs.system(async (tx) => {
      const current = await tx
        .selectFrom('refreshTokens')
        .select('deviceId')
        .where('familyId', '=', who.sid)
        .where('revokedAt', 'is', null)
        .where('deviceId', 'is not', null)
        .executeTakeFirst();
      const deviceId = await this.auth.saveDevice(tx, who.userId, body);
      // A new token replaces this phone's old one (Firebase changed it).
      if (current?.deviceId && current.deviceId !== deviceId) {
        await tx.updateTable('devices').set({ fcmToken: null }).where('id', '=', current.deviceId).execute();
      }
      // Tie the phone to this login, so logging out stops its pushes.
      await tx.updateTable('refreshTokens').set({ deviceId }).where('familyId', '=', who.sid).where('revokedAt', 'is', null).execute();
      return deviceId;
    });
    return { deviceId: id };
  }

  /** Account deletion (DPDP). Past bookings stay for the law's record-keeping, without the name and phone. */
  @Delete('me')
  @Roles('patient')
  async remove(@PatientId() userId: string) {
    await this.dbs.system(async (tx) => {
      const live = await tx
        .selectFrom('bookings')
        .select('id')
        .where('patientUserId', '=', userId)
        .where('status', 'in', ['pending_payment', 'confirmed'])
        .executeTakeFirst();
      if (live) throw new AppError('HAS_BOOKINGS', 'You have an upcoming booking. Please delete your account after that visit.', HttpStatus.CONFLICT);
      await tx.updateTable('users').set({ status: 'deleted', deletedAt: new Date(), phone: null, email: null }).where('id', '=', userId).execute();
      await tx.deleteFrom('patientProfiles').where('userId', '=', userId).execute();
      await tx.deleteFrom('devices').where('userId', '=', userId).execute();
      await sql`update bookings set patient_name = 'Deleted user', note = '' where patient_user_id = ${userId}`.execute(tx);
      await this.tokens.revokeAllForUser(tx, userId);
    });
    return { ok: true };
  }

  // ── Messages ─────────────────────────────────────────────────────────────────────────────────────

  @Get('notifications')
  async notifications(
    @CurrentApp() who: AppPrincipal,
    @ZQuery(z.object({ cursor: zCursor, limit: zLimit, after: z.iso.datetime({ offset: true }).optional() })) q: { cursor?: string; limit: number; after?: string },
  ) {
    // `after`: only messages newer than the phone's newest one (the regular check), instead of the whole page.
    const offset = q.after ? 0 : decodeCursor(q.cursor);
    const identity = who.role === 'doctor' ? { role: 'doctor' as const, userId: who.userId, doctorId: who.doctorId! } : { role: 'patient' as const, userId: who.userId };
    return this.dbs.as(identity, async (tx) => {
      const rows = await tx
        .selectFrom('notifications')
        .select(['id', 'kind', 'title', 'body', 'bookingId', 'data', 'readAt', 'createdAt'])
        .where('userId', '=', who.userId)
        // Millisecond precision on both sides: the phone gets times to the millisecond, the database keeps microseconds.
        .$if(!!q.after, (qb) => qb.where(sql<Date>`date_trunc('milliseconds', created_at)`, '>', new Date(q.after!)))
        .orderBy('createdAt', 'desc')
        .limit(q.limit + 1)
        .offset(offset)
        .execute();
      const unread = await tx.selectFrom('notifications').select((eb) => eb.fn.countAll<string>().as('n')).where('userId', '=', who.userId).where('readAt', 'is', null).executeTakeFirstOrThrow();
      return { items: rows.slice(0, q.limit), nextCursor: rows.length > q.limit ? encodeCursor(offset + q.limit) : null, unread: Number(unread.n) };
    });
  }

  @Post('notifications/read')
  @HttpCode(200)
  async read(@CurrentApp() who: AppPrincipal, @ZBody(readBody) body: z.output<typeof readBody>) {
    const identity = who.role === 'doctor' ? { role: 'doctor' as const, userId: who.userId, doctorId: who.doctorId! } : { role: 'patient' as const, userId: who.userId };
    await this.dbs.as(identity, (tx) => {
      let q = tx.updateTable('notifications').set({ readAt: new Date() }).where('userId', '=', who.userId).where('readAt', 'is', null);
      if ('ids' in body) q = q.where('id', 'in', body.ids);
      return q.execute();
    });
    return { ok: true };
  }

  // ── Support ──────────────────────────────────────────────────────────────────────────────────────

  @Post('support/tickets')
  @RateLimit('support', 5, 3600)
  async ticket(@CurrentApp() who: AppPrincipal, @ZBody(ticketBody) body: z.output<typeof ticketBody>, @Meta() meta: RequestMeta) {
    const row = await this.dbs.system((tx) =>
      tx.insertInto('supportTickets').values({ userId: who.userId, message: body.message, requestId: meta.requestId }).returning(['id', 'createdAt']).executeTakeFirstOrThrow(),
    );
    return { ...row, message: 'Thank you. The OPflow team will reply within a day.' };
  }
}
