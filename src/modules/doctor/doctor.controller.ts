import { Controller, Get, HttpCode, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { AuthedRequest, CurrentDoctor, Roles } from '../../common/auth/auth.decorators';
import { Idempotent } from '../../common/http/idempotency';
import { IdParam, ZBody, zDate, ZQuery, zTime } from '../../common/http/zod';
import { DoctorIdentity, DoctorService } from './doctor.service';

const profileBody = z.object({
  gender: z.enum(['female', 'male', 'other']).optional(),
  yearsExperience: z.number().int().min(0).max(70).optional(),
  languages: z.array(z.string().trim().min(2).max(20)).max(8).optional(),
  about: z.string().max(240).optional(),
  feePaise: z.number().int().min(5000, 'Fee must be at least ₹50').max(300000, 'Fee can be at most ₹3,000').optional(),
  photoUploadKey: z.string().max(200).nullable().optional(),
});
const photoBody = z.object({ contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']) });
const pauseBody = z.object({ paused: z.boolean() });
const reasonBody = z.object({ reason: z.string().trim().min(3, 'Please give a short reason').max(120) });
const cancelDayBody = reasonBody.extend({ hospitalId: z.uuid().optional() });
const weekBody = z.object({
  hospitalId: z.uuid(),
  openDaysAhead: z.number().int().min(1).max(60).optional(),
  closeMinutesBefore: z.number().int().min(0).max(240).optional(),
  windowMinutes: z.union([z.literal(30), z.literal(60)]).optional(),
  days: z
    .array(
      z.object({
        weekday: z.number().int().min(1).max(7),
        blocks: z
          .array(
            z.object({
              start: zTime,
              end: zTime,
              perHour: z.number().int().min(1).max(20),
              takeEmergency: z.boolean().optional(),
              avgMinutes: z.number().int().min(1).max(60).optional(),
            }),
          )
          .max(4),
      }),
    )
    .max(7),
});
const leavesBody = z.object({
  days: z.array(z.object({ date: zDate, hospitalId: z.uuid().nullable().optional(), reason: z.string().max(120).optional() })).max(120),
});
const emergencyBody = z.object({
  status: z.enum(['off', 'available_now', 'available_till']),
  untilAt: z.iso.datetime({ offset: true }).optional(),
  hospitalId: z.uuid().optional(),
  mode: z.enum(['at_hospital', 'phone_first']).optional(),
});
const passwordBody = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(1).max(128) });
const range = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

/** The doctor's app. Doctors can't add patients: every booking comes from a patient's paid booking. */
@ApiTags('doctor')
@Roles('doctor')
@Controller('v1/doctor')
export class DoctorController {
  constructor(private readonly doctors: DoctorService) {}

  @Get('me')
  me(@CurrentDoctor() d: DoctorIdentity) {
    return this.doctors.me(d);
  }

  @Patch('me')
  update(@CurrentDoctor() d: DoctorIdentity, @ZBody(profileBody) body: z.output<typeof profileBody>) {
    return this.doctors.update(d, body);
  }

  /** Step 1 of a new photo: a 5-minute upload link. Step 2: PATCH /doctor/me { photoUploadKey }. */
  @Post('me/photo/upload-url')
  @HttpCode(200)
  photo(@CurrentDoctor() d: DoctorIdentity, @ZBody(photoBody) body: z.output<typeof photoBody>) {
    return this.doctors.photoUploadUrl(d, body.contentType);
  }

  @Post('me/bookings-pause')
  @HttpCode(200)
  pause(@CurrentDoctor() d: DoctorIdentity, @ZBody(pauseBody) body: z.output<typeof pauseBody>) {
    return this.doctors.setPaused(d, body.paused);
  }

  @Post('password')
  @HttpCode(200)
  password(@CurrentDoctor() d: DoctorIdentity, @Req() req: AuthedRequest, @ZBody(passwordBody) body: z.output<typeof passwordBody>) {
    const sid = req.principal?.kind === 'app' ? req.principal.sid : '';
    return this.doctors.changePassword(d, sid, body.currentPassword, body.newPassword);
  }

  /** Devices this account is signed in on (at most 2 at a time). */
  @Get('devices')
  devices(@CurrentDoctor() d: DoctorIdentity, @Req() req: AuthedRequest) {
    return this.doctors.devices(d, req.principal?.kind === 'app' ? req.principal.sid : '');
  }

  @Post('devices/:id/sign-out')
  @HttpCode(200)
  signOutDevice(@CurrentDoctor() d: DoctorIdentity, @IdParam() id: string) {
    return this.doctors.signOutDevice(d, id);
  }

  @Get('hospitals')
  hospitals(@CurrentDoctor() d: DoctorIdentity) {
    return this.doctors.hospitals(d);
  }

  @Get('today')
  today(@CurrentDoctor() d: DoctorIdentity, @ZQuery(z.object({ hospital: z.uuid().optional() })) q: { hospital?: string }) {
    return this.doctors.today(d, q.hospital);
  }

  @Get('bookings')
  bookings(
    @CurrentDoctor() d: DoctorIdentity,
    @ZQuery(z.object({ date: zDate, hospital: z.uuid().optional(), filter: z.enum(['all', 'upcoming', 'cancelled']).optional() }))
    q: { date: string; hospital?: string; filter?: 'all' | 'upcoming' | 'cancelled' },
  ) {
    return this.doctors.bookingsOn(d, q.date, q.hospital, q.filter);
  }

  @Get('bookings/:id')
  booking(@CurrentDoctor() d: DoctorIdentity, @IdParam() id: string) {
    return this.doctors.booking(d, id);
  }

  /** Cancel one booking: 100% money back to the patient. */
  @Post('bookings/:id/cancel')
  @HttpCode(200)
  @Idempotent({ required: false })
  cancel(@CurrentDoctor() d: DoctorIdentity, @IdParam() id: string, @ZBody(reasonBody) body: z.output<typeof reasonBody>) {
    return this.doctors.cancelBooking(d, id, body.reason);
  }

  /** Move one booking: the patient picks any new time. */
  @Post('bookings/:id/move')
  @HttpCode(200)
  @Idempotent({ required: false })
  move(@CurrentDoctor() d: DoctorIdentity, @IdParam() id: string, @ZBody(reasonBody) body: z.output<typeof reasonBody>) {
    return this.doctors.moveBooking(d, id, body.reason);
  }

  /** "I can't come on this day": leave + everyone gets all their money back. */
  @Post('days/:date/cancel')
  @HttpCode(200)
  @Idempotent({ required: false })
  cancelDay(@CurrentDoctor() d: DoctorIdentity, @Param('date') date: string, @ZBody(cancelDayBody) body: z.output<typeof cancelDayBody>) {
    return this.doctors.cancelDay(d, zDate.parse(date), body.reason, body.hospitalId);
  }

  @Get('bulk/:id')
  bulk(@CurrentDoctor() d: DoctorIdentity, @IdParam() id: string) {
    return this.doctors.bulk(d, id);
  }

  @Get('schedule')
  week(@CurrentDoctor() d: DoctorIdentity, @ZQuery(z.object({ hospital: z.uuid() })) q: { hospital: string }) {
    return this.doctors.week(d, q.hospital);
  }

  @Put('schedule')
  saveWeek(@CurrentDoctor() d: DoctorIdentity, @ZBody(weekBody) body: z.output<typeof weekBody>) {
    return this.doctors.saveWeek(d, body);
  }

  @Get('leaves')
  leaves(@CurrentDoctor() d: DoctorIdentity) {
    return this.doctors.leaves(d);
  }

  @Put('leaves')
  setLeaves(@CurrentDoctor() d: DoctorIdentity, @ZBody(leavesBody) body: z.output<typeof leavesBody>) {
    return this.doctors.setLeaves(d, body.days);
  }

  @Get('emergency')
  emergency(@CurrentDoctor() d: DoctorIdentity) {
    return this.doctors.emergency(d);
  }

  @Put('emergency')
  setEmergency(@CurrentDoctor() d: DoctorIdentity, @ZBody(emergencyBody) body: z.output<typeof emergencyBody>) {
    return this.doctors.setEmergency(d, body);
  }

  @Get('earnings')
  earnings(@CurrentDoctor() d: DoctorIdentity, @ZQuery(range) q: { days: number }) {
    return this.doctors.earnings(d, q.days);
  }

  @Get('reports')
  reports(@CurrentDoctor() d: DoctorIdentity, @ZQuery(range) q: { days: number }) {
    return this.doctors.reports(d, q.days);
  }
}
