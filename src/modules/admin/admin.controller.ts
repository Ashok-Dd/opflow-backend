import { Controller, Delete, Get, Header, HttpCode, Param, Patch, Post, Put, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';

import { Admin, AdminPrincipal, CurrentAdmin, Meta, Public, RequestMeta, StepUp } from '../../common/auth/auth.decorators';
import { AppError } from '../../common/errors/app-error';
import { Idempotent } from '../../common/http/idempotency';
import { decodeCursor, IdParam, ZBody, zDate, zLimit, zPhone, ZQuery, zCursor } from '../../common/http/zod';
import { RateLimit } from '../../infra/redis/rate-limit';
import { AdminAuthService } from './admin-auth.service';
import { AdminDoctorsService } from './admin-doctors.service';
import { AdminService, KILL_SWITCHES } from './admin.service';

const reason = z.string().trim().min(5, 'Please write a reason (5+ letters)').max(240);
const pageQ = z.object({ cursor: zCursor, limit: zLimit });
const pg = (q: { cursor?: string; limit: number }) => ({ limit: q.limit, offset: decodeCursor(q.cursor) });
const roleEnum = z.enum(['super', 'ops', 'finance', 'support', 'content']);

// ── Auth ─────────────────────────────────────────────────────────────────────────────────────────────

const loginBody = z.object({ email: z.email(), password: z.string().min(1).max(200) });
const totpBody = z.object({ challengeToken: z.string().min(10).max(2000), code: z.string().regex(/^\d{6}$/, 'must be 6 digits') });
const codeBody = z.object({ code: z.string().regex(/^\d{6}$/, 'must be 6 digits') });
const refreshBody = z.object({ refreshToken: z.string().min(20).max(200) });
const setupBody = z.object({ password: z.string().min(1).max(200), code: z.string().regex(/^\d{6}$/) });

@ApiTags('admin: auth')
@Controller('v1/admin/auth')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  @RateLimit('admin-login', 10, 60, 'ip')
  login(@ZBody(loginBody) b: z.output<typeof loginBody>, @Meta() meta: RequestMeta) {
    return this.auth.login(b.email, b.password, meta);
  }

  @Post('totp')
  @Public()
  @HttpCode(200)
  @RateLimit('admin-totp', 10, 60, 'ip')
  totp(@ZBody(totpBody) b: z.output<typeof totpBody>, @Meta() meta: RequestMeta) {
    return this.auth.totp(b.challengeToken, b.code, meta);
  }

  @Post('refresh')
  @Public()
  @HttpCode(200)
  @RateLimit('admin-refresh', 30, 60, 'ip')
  refresh(@ZBody(refreshBody) b: z.output<typeof refreshBody>, @Meta() meta: RequestMeta) {
    return this.auth.refresh(b.refreshToken, meta);
  }

  @Post('step-up')
  @Admin()
  @HttpCode(200)
  @RateLimit('admin-step-up', 10, 60)
  stepUp(@CurrentAdmin() who: AdminPrincipal, @ZBody(codeBody) b: z.output<typeof codeBody>, @Meta() meta: RequestMeta) {
    return this.auth.stepUp(who, b.code, meta);
  }

  @Post('logout')
  @Admin()
  @HttpCode(200)
  logout(@CurrentAdmin() who: AdminPrincipal) {
    return this.auth.logout(who);
  }

  @Get('me')
  @Admin()
  me(@CurrentAdmin() who: AdminPrincipal) {
    return this.auth.me(who);
  }

  @Get('setup/:token')
  @Public()
  @RateLimit('admin-setup', 20, 60, 'ip')
  setupInfo(@Param('token') token: string) {
    return this.auth.setupInfo(token);
  }

  @Post('setup/:token')
  @Public()
  @HttpCode(200)
  @RateLimit('admin-setup', 20, 60, 'ip')
  setup(@Param('token') token: string, @ZBody(setupBody) b: z.output<typeof setupBody>, @Meta() meta: RequestMeta) {
    return this.auth.completeSetup(token, b.password, b.code, meta);
  }
}

// ── Dashboard, live, emergency, audit ─────────────────────────────────────────────────────────────────────────────

@ApiTags('admin')
@Admin()
@Controller('v1/admin')
export class AdminHomeController {
  constructor(private readonly admin: AdminService) {}

  @Get('dashboard/today')
  today() {
    return this.admin.today();
  }

  @Get('attention')
  attention() {
    return this.admin.attention();
  }

  @Get('live/sessions')
  live() {
    return this.admin.liveSessions();
  }

  @Get('live/sessions/:id')
  liveOne(@IdParam() id: string) {
    return this.admin.liveSession(id);
  }

  @Get('emergency')
  emergency() {
    return this.admin.emergencyList();
  }

  @Post('emergency/:doctorId/off')
  @Admin('super', 'ops')
  @HttpCode(200)
  emergencyOff(@CurrentAdmin() who: AdminPrincipal, @IdParam('doctorId') id: string, @ZBody(z.object({ reason })) b: { reason: string }, @Meta() meta: RequestMeta) {
    return this.admin.emergencyOff(who, id, b.reason, meta);
  }

  @Get('audit')
  audit(
    @CurrentAdmin() who: AdminPrincipal,
    @ZQuery(pageQ.extend({ actor: z.uuid().optional(), entity: z.string().max(60).optional(), entityId: z.string().max(80).optional(), action: z.string().max(80).optional(), from: zDate.optional(), to: zDate.optional() }))
    q: { actor?: string; entity?: string; entityId?: string; action?: string; from?: string; to?: string; cursor?: string; limit: number },
  ) {
    return this.admin.audit(who, { ...q, ...pg(q) });
  }
}

// ── Doctors ──────────────────────────────────────────────────────────────────────────────────────────

const docKind = z.enum(['degree', 'registration', 'id_proof', 'other']);
const docType = z.enum(['application/pdf', 'image/jpeg', 'image/png']);
const createDoctorBody = z.object({
  name: z.string().trim().min(3).max(80),
  gender: z.enum(['female', 'male', 'other']),
  phone: zPhone,
  email: z.email().optional(),
  typeId: z.string().regex(/^[a-z]+$/),
  degrees: z.string().trim().min(2).max(120),
  regCouncil: z.string().trim().min(2).max(60),
  regNo: z.string().trim().min(2).max(40),
  regYear: z.number().int().min(1950).max(2100).optional(),
  yearsExperience: z.number().int().min(0).max(70).optional(),
  languages: z.array(z.string().trim().min(2).max(20)).max(8).optional(),
  about: z.string().max(240).optional(),
  feePaise: z.number().int().min(5000).max(300000),
  hospitals: z.array(z.object({ hospitalId: z.uuid(), isPrimary: z.boolean().optional(), feePaiseOverride: z.number().int().min(5000).max(300000).nullable().optional() })).min(1).max(10),
  documents: z.array(z.object({ kind: docKind, key: z.string().max(200) })).max(10).optional(),
  photoUploadKey: z.string().max(200).optional(),
});
const updateDoctorBody = z.object({
  gender: z.enum(['female', 'male', 'other']).optional(),
  yearsExperience: z.number().int().min(0).max(70).optional(),
  languages: z.array(z.string().trim().min(2).max(20)).max(8).optional(),
  about: z.string().max(240).optional(),
  feePaise: z.number().int().min(5000).max(300000).optional(),
  locked: z.object({ name: z.string().trim().min(3).max(80).optional(), typeId: z.string().regex(/^[a-z]+$/).optional(), degrees: z.string().max(120).optional(), regCouncil: z.string().max(60).optional(), regNo: z.string().max(40).optional() }).optional(),
  reason: z.string().max(240).optional(),
});
const payoutBody = z.object({
  holderName: z.string().trim().min(3).max(80),
  accountNumber: z.string().regex(/^\d{9,18}$/, 'must be 9–18 digits'),
  accountNumberAgain: z.string(),
  ifsc: z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'must look like SBIN0001234'),
  email: z.email().optional(),
});

@ApiTags('admin: doctors')
@Controller('v1/admin')
export class AdminDoctorsController {
  constructor(private readonly doctors: AdminDoctorsService) {}

  @Get('doctors')
  @Admin('super', 'ops', 'support', 'finance')
  list(
    @ZQuery(pageQ.extend({ q: z.string().max(60).optional(), verification: z.enum(['pending', 'verified', 'needs_correction', 'rejected']).optional(), type: z.string().optional(), hospital: z.uuid().optional(), status: z.enum(['active', 'suspended']).optional() }))
    q: { q?: string; verification?: string; type?: string; hospital?: string; status?: string; cursor?: string; limit: number },
  ) {
    return this.doctors.list({ ...q, ...pg(q) });
  }

  /** Wizard step 3 before the doctor exists: upload link for a document. */
  @Post('uploads/document-url')
  @Admin('super', 'ops')
  @HttpCode(200)
  wizardUpload(@ZBody(z.object({ contentType: docType })) b: { contentType: string }) {
    return this.doctors.wizardUploadUrl(b.contentType);
  }

  /** The wizard's final "Create doctor". Returns the login ID and a one-time password (shown once). */
  @Post('doctors')
  @Admin('super', 'ops')
  @Idempotent()
  create(@CurrentAdmin() who: AdminPrincipal, @ZBody(createDoctorBody) b: z.output<typeof createDoctorBody>, @Meta() meta: RequestMeta) {
    return this.doctors.create(who, b, meta);
  }

  @Get('doctors/:id')
  @Admin('super', 'ops', 'support', 'finance')
  get(@IdParam() id: string) {
    return this.doctors.get(id);
  }

  @Patch('doctors/:id')
  @Admin('super', 'ops')
  update(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @ZBody(updateDoctorBody) b: z.output<typeof updateDoctorBody>, @Meta() meta: RequestMeta) {
    return this.doctors.update(who, id, b, meta);
  }

  @Post('doctors/:id/documents/upload-url')
  @Admin('super', 'ops')
  @HttpCode(200)
  docUpload(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @ZBody(z.object({ kind: docKind, contentType: docType })) b: { kind: 'degree'; contentType: string }, @Meta() meta: RequestMeta) {
    return this.doctors.documentUploadUrl(who, id, b.kind, b.contentType, meta);
  }

  @Get('doctors/:id/documents/:docId/url')
  @Admin('super', 'ops')
  docUrl(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @IdParam('docId') docId: string, @Meta() meta: RequestMeta) {
    return this.doctors.documentUrl(who, id, docId, meta);
  }

  @Post('doctors/:id/documents/:docId/review')
  @Admin('super', 'ops')
  @HttpCode(200)
  review(
    @CurrentAdmin() who: AdminPrincipal,
    @IdParam() id: string,
    @IdParam('docId') docId: string,
    @ZBody(z.object({ status: z.enum(['approved', 'rejected']), note: z.string().max(240).optional() })) b: { status: 'approved' | 'rejected'; note?: string },
    @Meta() meta: RequestMeta,
  ) {
    return this.doctors.reviewDocument(who, id, docId, b.status, b.note, meta);
  }

  @Post('doctors/:id/hospitals')
  @Admin('super', 'ops')
  @HttpCode(200)
  addHospital(
    @CurrentAdmin() who: AdminPrincipal,
    @IdParam() id: string,
    @ZBody(z.object({ hospitalId: z.uuid(), isPrimary: z.boolean().optional(), feePaiseOverride: z.number().int().min(5000).max(300000).nullable().optional() })) b: { hospitalId: string; isPrimary?: boolean; feePaiseOverride?: number | null },
    @Meta() meta: RequestMeta,
  ) {
    return this.doctors.addHospital(who, id, b, meta);
  }

  @Delete('doctors/:id/hospitals/:hid')
  @Admin('super', 'ops')
  removeHospital(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @IdParam('hid') hid: string, @Meta() meta: RequestMeta) {
    return this.doctors.removeHospital(who, id, hid, meta);
  }

  @Post('doctors/:id/payout-account')
  @Admin('super', 'ops')
  @StepUp()
  @HttpCode(200)
  payout(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @ZBody(payoutBody) b: z.output<typeof payoutBody>, @Meta() meta: RequestMeta) {
    if (b.accountNumber !== b.accountNumberAgain) throw new AppError('INVALID_INPUT', 'The two account numbers are not the same.', 400);
    return this.doctors.payoutAccount(who, id, b, meta);
  }

  /** The bank check at Cashfree can finish later: asks again. */
  @Post('doctors/:id/payout-account/refresh')
  @Admin('super', 'ops')
  @HttpCode(200)
  async refreshPayout(@IdParam() id: string) {
    return { status: await this.doctors.refreshPayoutAccount(id) };
  }

  /** Make the doctor visible to patients (after the checklist). Needs a fresh authenticator code. */
  @Post('doctors/:id/verify')
  @Admin('super', 'ops')
  @StepUp()
  @HttpCode(200)
  verify(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @ZBody(z.object({ reason })) b: { reason: string }, @Meta() meta: RequestMeta) {
    return this.doctors.verify(who, id, b.reason, meta);
  }

  @Post('doctors/:id/needs-correction')
  @Admin('super', 'ops')
  @HttpCode(200)
  correction(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @ZBody(z.object({ note: reason })) b: { note: string }, @Meta() meta: RequestMeta) {
    return this.doctors.needsCorrection(who, id, b.note, meta);
  }

  /** Hide the doctor now; every future booking is refunded in full. Needs a fresh authenticator code. */
  @Post('doctors/:id/suspend')
  @Admin('super', 'ops')
  @StepUp()
  @HttpCode(200)
  suspend(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @ZBody(z.object({ reason })) b: { reason: string }, @Meta() meta: RequestMeta) {
    return this.doctors.suspend(who, id, b.reason, meta);
  }

  @Post('doctors/:id/reactivate')
  @Admin('super', 'ops')
  @HttpCode(200)
  reactivate(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @Meta() meta: RequestMeta) {
    return this.doctors.reactivate(who, id, meta);
  }

  @Post('doctors/:id/reset-password')
  @Admin('super', 'ops', 'support')
  @StepUp()
  @HttpCode(200)
  reset(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @ZBody(z.object({ reason })) b: { reason: string }, @Meta() meta: RequestMeta) {
    return this.doctors.resetPassword(who, id, b.reason, meta);
  }

  @Post('doctors/:id/unlock')
  @Admin('super', 'ops', 'support')
  @HttpCode(200)
  unlock(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @Meta() meta: RequestMeta) {
    return this.doctors.unlock(who, id, meta);
  }

  @Post('doctors/:id/sign-out-everywhere')
  @Admin('super', 'ops', 'support')
  @HttpCode(200)
  signOut(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @Meta() meta: RequestMeta) {
    return this.doctors.signOutEverywhere(who, id, meta);
  }

  @Get('doctors/:id/history')
  @Admin('super', 'ops', 'support', 'finance')
  history(@IdParam() id: string, @ZQuery(pageQ) q: { cursor?: string; limit: number }) {
    const p = pg(q);
    return this.doctors.history(id, p.limit, p.offset);
  }

  @Get('doctors/:id/sessions')
  @Admin('super', 'ops', 'support', 'finance')
  sessions(@IdParam() id: string, @ZQuery(z.object({ from: zDate, to: zDate })) q: { from: string; to: string }) {
    return this.doctors.sessions(id, q.from, q.to);
  }
}

// ── Hospitals, bookings, money, patients, content, support, settings ─────────────────────────────────

const hospitalBody = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/).max(80).optional(),
  name: z.string().trim().min(3).max(120),
  address: z.string().trim().min(5).max(240),
  area: z.string().trim().min(2).max(80),
  city: z.string().trim().min(2).max(60),
  pin: z.string().regex(/^[1-9]\d{5}$/),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  phone: z.string().trim().min(6).max(20),
  opdTimingsText: z.string().max(120).nullable().optional(),
  hasEmergency: z.boolean().optional(),
  departments: z.array(z.string().regex(/^[a-z]+$/)).max(40).optional(),
});
const firstAidBody = z.object({
  intro: z.string().max(600).nullable().optional(),
  signs: z.array(z.string().min(3).max(300)).max(12),
  callNowIf: z.array(z.string().min(3).max(300)).min(1).max(12),
  dos: z.array(z.string().min(3).max(300)).min(1).max(15),
  donts: z.array(z.string().min(3).max(300)).min(1).max(15),
  sources: z.array(z.object({ title: z.string().min(5).max(200), year: z.number().int().nullable().optional(), url: z.url().nullable().optional() })).min(1).max(6),
  sourceToConfirm: z.boolean(),
});

@ApiTags('admin: operations')
@Controller('v1/admin')
export class AdminOpsController {
  constructor(private readonly admin: AdminService) {}

  @Get('hospitals')
  @Admin()
  hospitals(@ZQuery(pageQ.extend({ q: z.string().max(60).optional() })) q: { q?: string; cursor?: string; limit: number }) {
    return this.admin.hospitals(q.q, pg(q));
  }

  @Post('hospitals')
  @Admin('super', 'ops')
  createHospital(@CurrentAdmin() who: AdminPrincipal, @ZBody(hospitalBody) b: z.output<typeof hospitalBody>, @Meta() meta: RequestMeta) {
    return this.admin.createHospital(who, b, meta);
  }

  @Get('hospitals/:id')
  @Admin()
  hospital(@IdParam() id: string) {
    return this.admin.hospital(id);
  }

  @Patch('hospitals/:id')
  @Admin('super', 'ops')
  updateHospital(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @ZBody(hospitalBody.partial().extend({ status: z.enum(['active', 'hidden']).optional() })) b: Record<string, unknown>, @Meta() meta: RequestMeta) {
    return this.admin.updateHospital(who, id, b, meta);
  }

  @Post('hospitals/geocode')
  @Admin('super', 'ops')
  @HttpCode(200)
  geocode(@ZBody(z.object({ address: z.string().min(5).max(300) })) b: { address: string }) {
    return this.admin.geocode(b.address);
  }

  @Get('bookings')
  @Admin('super', 'ops', 'finance', 'support')
  bookings(
    @ZQuery(pageQ.extend({ code: z.string().regex(/^OPF[0-9A-Za-z]{5,7}$/).optional(), phone: zPhone.optional(), doctor: z.uuid().optional(), date: zDate.optional(), token: z.coerce.number().int().optional() }))
    q: { code?: string; phone?: string; doctor?: string; date?: string; token?: number; cursor?: string; limit: number },
  ) {
    return this.admin.searchBookings({ ...q, ...pg(q) });
  }

  @Get('bookings/:id')
  @Admin('super', 'ops', 'finance', 'support')
  booking(@IdParam() id: string) {
    return this.admin.booking(id);
  }

  @Post('bookings/:id/resend-receipt')
  @Admin('super', 'ops', 'finance', 'support')
  @HttpCode(200)
  resend(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @Meta() meta: RequestMeta) {
    return this.admin.resendReceipt(who, id, meta);
  }

  @Post('bookings/:id/refund')
  @Admin('super', 'finance')
  @StepUp()
  @Idempotent()
  @HttpCode(200)
  refund(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @ZBody(z.object({ amountPaise: z.number().int().min(100), reason })) b: { amountPaise: number; reason: string }, @Meta() meta: RequestMeta) {
    return this.admin.refund(who, id, b.amountPaise, b.reason, meta);
  }

  @Post('bookings/:id/move')
  @Admin('super', 'ops')
  @HttpCode(200)
  move(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @ZBody(z.object({ reason })) b: { reason: string }, @Meta() meta: RequestMeta) {
    return this.admin.moveBooking(who, id, b.reason, meta);
  }

  @Post('bookings/:id/cancel')
  @Admin('super', 'ops')
  @StepUp()
  @HttpCode(200)
  cancel(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @ZBody(z.object({ reason })) b: { reason: string }, @Meta() meta: RequestMeta) {
    return this.admin.cancelBooking(who, id, b.reason, meta);
  }

  @Get('payments')
  @Admin('super', 'finance')
  payments(@ZQuery(pageQ.extend({ status: z.string().optional(), method: z.string().optional(), from: zDate.optional(), to: zDate.optional() })) q: { status?: string; method?: string; from?: string; to?: string; cursor?: string; limit: number }) {
    return this.admin.paymentsList({ ...q, ...pg(q) });
  }

  @Get('refunds')
  @Admin('super', 'finance')
  refunds(@ZQuery(pageQ.extend({ status: z.enum(['pending', 'processed', 'failed']).optional() })) q: { status?: string; cursor?: string; limit: number }) {
    const p = pg(q);
    return this.admin.refunds(q.status, p.limit, p.offset);
  }

  @Post('refunds/:id/retry')
  @Admin('super', 'finance')
  @HttpCode(200)
  retry(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @Meta() meta: RequestMeta) {
    return this.admin.retryRefund(who, id, meta);
  }

  @Post('refunds/:id/mark-paid')
  @Admin('super', 'finance')
  @StepUp()
  @HttpCode(200)
  markPaid(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @ZBody(z.object({ utr: z.string().regex(/^[A-Za-z0-9]{8,40}$/) })) b: { utr: string }, @Meta() meta: RequestMeta) {
    return this.admin.markRefundPaid(who, id, b.utr, meta);
  }

  @Get('transfers')
  @Admin('super', 'finance')
  transfers(@ZQuery(pageQ.extend({ status: z.enum(['on_hold', 'released', 'reversed', 'failed']).optional(), doctor: z.uuid().optional() })) q: { status?: string; doctor?: string; cursor?: string; limit: number }) {
    const p = pg(q);
    return this.admin.transfers(q.status, q.doctor, p.limit, p.offset);
  }

  @Get('payouts')
  @Admin('super', 'finance')
  payouts(@ZQuery(pageQ.extend({ status: z.enum(['pending', 'success', 'failed']).optional(), doctor: z.uuid().optional() })) q: { status?: string; doctor?: string; cursor?: string; limit: number }) {
    const p = pg(q);
    return this.admin.payoutsList(q.status, q.doctor, p.limit, p.offset);
  }

  /** Pays what is due now (the same as the hourly run). */
  @Post('payouts/run')
  @Admin('super', 'finance')
  @StepUp()
  @HttpCode(200)
  runPayouts(@CurrentAdmin() who: AdminPrincipal, @Meta() meta: RequestMeta) {
    return this.admin.runPayouts(who, meta);
  }

  @Get('reconciliation')
  @Admin('super', 'finance')
  reconciliation(@ZQuery(z.object({ date: zDate })) q: { date: string }) {
    return this.admin.reconciliation(q.date);
  }

  @Get('exports/:kind')
  @Admin('super', 'finance')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async export(@Param('kind') kind: string, @ZQuery(z.object({ from: zDate, to: zDate })) q: { from: string; to: string }, @Res() res: Response) {
    const k = kind.replace(/\.csv$/, '');
    if (!['payments', 'refunds', 'transfers', 'payouts'].includes(k)) throw new AppError('NOT_FOUND', 'Unknown export.', 404);
    const csv = await this.admin.exportCsv(k as 'payments', q.from, q.to);
    res.setHeader('Content-Disposition', `attachment; filename="opflow-${k}-${q.from}-to-${q.to}.csv"`);
    res.send(csv);
  }

  @Get('patients')
  @Admin('super', 'ops', 'support')
  patients(@ZQuery(z.object({ phone: zPhone.optional(), code: z.string().max(12).optional() })) q: { phone?: string; code?: string }) {
    if (!q.phone && !q.code) throw new AppError('INVALID_INPUT', 'Search by the full phone number or a booking code.', 400);
    return this.admin.patients(q.phone, q.code);
  }

  @Get('patients/:id')
  @Admin('super', 'ops', 'support')
  patient(@IdParam() id: string) {
    return this.admin.patient(id);
  }

  @Post('patients/:id/reveal')
  @Admin('super', 'ops', 'support')
  @StepUp()
  @HttpCode(200)
  reveal(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @ZBody(z.object({ field: z.literal('phone'), reason })) b: { reason: string }, @Meta() meta: RequestMeta) {
    return this.admin.reveal(who, id, b.reason, meta);
  }

  @Post('patients/:id/block')
  @Admin('super', 'ops', 'support')
  @StepUp()
  @HttpCode(200)
  block(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @ZBody(z.object({ blocked: z.boolean(), reason })) b: { blocked: boolean; reason: string }, @Meta() meta: RequestMeta) {
    return this.admin.block(who, id, b.blocked, b.reason, meta);
  }

  @Post('patients/:id/deletion')
  @Admin('super', 'ops', 'support')
  @StepUp()
  @HttpCode(200)
  deletion(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @ZBody(z.object({ reason })) b: { reason: string }, @Meta() meta: RequestMeta) {
    return this.admin.deletePatient(who, id, b.reason, meta);
  }

  @Post('patients/:id/export')
  @Admin('super', 'ops', 'support')
  @StepUp()
  @HttpCode(200)
  exportPatient(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @Meta() meta: RequestMeta) {
    return this.admin.exportPatient(who, id, meta);
  }

  @Get('first-aid')
  @Admin('super', 'content')
  firstAid() {
    return this.admin.firstAidList();
  }

  @Put('first-aid/:kind')
  @Admin('super', 'content')
  putFirstAid(@CurrentAdmin() who: AdminPrincipal, @Param('kind') kind: string, @ZBody(firstAidBody) b: z.output<typeof firstAidBody>, @Meta() meta: RequestMeta) {
    if (!/^[a-z]+$/.test(kind)) throw new AppError('NOT_FOUND', 'Unknown emergency.', 404);
    return this.admin.putFirstAid(who, kind, b, meta);
  }

  @Post('first-aid/:kind/publish')
  @Admin('super', 'content')
  @StepUp()
  @HttpCode(200)
  publish(@CurrentAdmin() who: AdminPrincipal, @Param('kind') kind: string, @ZBody(z.object({ reviewedByDoctor: z.string().trim().min(5).max(80) })) b: { reviewedByDoctor: string }, @Meta() meta: RequestMeta) {
    return this.admin.publishFirstAid(who, kind, b.reviewedByDoctor, meta);
  }

  @Get('catalog/:part')
  @Admin()
  catalog(@Param('part') part: string) {
    if (!['types', 'problems', 'emergency-kinds'].includes(part)) throw new AppError('NOT_FOUND', 'Unknown list.', 404);
    return this.admin.catalog(part as 'types');
  }

  @Put('catalog/:part')
  @Admin('super', 'content')
  putCatalog(@CurrentAdmin() who: AdminPrincipal, @Param('part') part: string, @ZBody(z.object({ items: z.array(z.record(z.string(), z.unknown()).refine((v) => typeof v.id === 'string' && /^[a-z]+$/.test(v.id), 'each item needs an id of small letters')).min(1).max(200) })) b: { items: Record<string, unknown>[] }, @Meta() meta: RequestMeta) {
    if (!['types', 'problems', 'emergency-kinds'].includes(part)) throw new AppError('NOT_FOUND', 'Unknown list.', 404);
    return this.admin.putCatalog(who, part as 'types', b.items, meta);
  }

  @Get('tickets')
  @Admin('super', 'ops', 'finance', 'support')
  tickets(@ZQuery(pageQ.extend({ status: z.enum(['open', 'answered', 'closed']).optional() })) q: { status?: string; cursor?: string; limit: number }) {
    const p = pg(q);
    return this.admin.tickets(q.status, p.limit, p.offset);
  }

  @Post('tickets/:id/reply')
  @Admin('super', 'ops', 'finance', 'support')
  @HttpCode(200)
  reply(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @ZBody(z.object({ reply: z.string().trim().min(2).max(500) })) b: { reply: string }, @Meta() meta: RequestMeta) {
    return this.admin.replyTicket(who, id, b.reply, meta);
  }

  @Post('tickets/:id/close')
  @Admin('super', 'ops', 'finance', 'support')
  @HttpCode(200)
  close(@CurrentAdmin() who: AdminPrincipal, @IdParam() id: string, @Meta() meta: RequestMeta) {
    return this.admin.closeTicket(who, id, meta);
  }

  @Get('config')
  @Admin()
  config() {
    return this.admin.config();
  }

  /** Change a rule now (fresh authenticator code, reason, audit log). */
  @Put('config/:key')
  @Admin('super', 'ops')
  @StepUp()
  @HttpCode(200)
  putConfig(@CurrentAdmin() who: AdminPrincipal, @Param('key') key: string, @ZBody(z.object({ value: z.unknown(), reason })) b: { value: unknown; reason: string }, @Meta() meta: RequestMeta) {
    return this.admin.setConfig(who, key, b.value, b.reason, meta);
  }

  /** Break glass: turn a kill switch OFF now (one admin). */
  @Post('config/:key/kill')
  @Admin('super', 'ops')
  @StepUp()
  @HttpCode(200)
  kill(@CurrentAdmin() who: AdminPrincipal, @Param('key') key: string, @ZBody(z.object({ reason })) b: { reason: string }, @Meta() meta: RequestMeta) {
    return this.admin.kill(who, key, b.reason, meta);
  }

  @Get('config/kill-switches')
  @Admin()
  switches() {
    return KILL_SWITCHES;
  }
}
