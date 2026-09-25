import { createParamDecorator, ExecutionContext, HttpStatus, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

import { AppError } from '../errors/app-error';
import type { AdminRoleName, AppRole } from './jwt.service';

/** Who is calling, set by AuthGuard. */
export type AppPrincipal = { kind: 'app'; role: AppRole; userId: string; doctorId?: string; sid: string };
export type AdminPrincipal = { kind: 'admin'; adminId: string; role: AdminRoleName; sid: string; stepUpAt: number };
export type Principal = AppPrincipal | AdminPrincipal;

export type AuthedRequest = Request & { id?: string; principal?: Principal; rawBody?: Buffer };

export const PUBLIC = 'auth:public';
export const APP_ROLES = 'auth:appRoles';
export const ADMIN_ROLES = 'auth:adminRoles';
export const STEP_UP = 'auth:stepUp';

/** No login needed (catalog, doctor search, emergency help, webhooks). */
export const Public = () => SetMetadata(PUBLIC, true);

/** Only these app logins (patient phone login, doctor ID login). */
export const Roles = (...roles: AppRole[]) => SetMetadata(APP_ROLES, roles);

/** Only admin-site sessions, and only these admin roles (empty = any admin). */
export const Admin = (...roles: AdminRoleName[]) => SetMetadata(ADMIN_ROLES, roles);

/** Admin actions that need a fresh authenticator code (within 5 minutes): approvals, refunds, reveals, config. */
export const StepUp = () => SetMetadata(STEP_UP, true);

const principalOf = (ctx: ExecutionContext): Principal | undefined => ctx.switchToHttp().getRequest<AuthedRequest>().principal;

/** The logged-in patient. */
export const PatientId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const p = principalOf(ctx);
  if (p?.kind !== 'app' || p.role !== 'patient') throw new AppError('FORBIDDEN', "You can't open this.", HttpStatus.FORBIDDEN);
  return p.userId;
});

/** The logged-in doctor: { userId, doctorId }. */
export const CurrentDoctor = createParamDecorator((_: unknown, ctx: ExecutionContext): { userId: string; doctorId: string } => {
  const p = principalOf(ctx);
  if (p?.kind !== 'app' || p.role !== 'doctor' || !p.doctorId) throw new AppError('FORBIDDEN', "You can't open this.", HttpStatus.FORBIDDEN);
  return { userId: p.userId, doctorId: p.doctorId };
});

/** Any app login (patient or doctor). */
export const CurrentApp = createParamDecorator((_: unknown, ctx: ExecutionContext): AppPrincipal => {
  const p = principalOf(ctx);
  if (p?.kind !== 'app') throw new AppError('UNAUTHENTICATED', 'Please log in again.', HttpStatus.UNAUTHORIZED);
  return p;
});

/** The logged-in admin. */
export const CurrentAdmin = createParamDecorator((_: unknown, ctx: ExecutionContext): AdminPrincipal => {
  const p = principalOf(ctx);
  if (p?.kind !== 'admin') throw new AppError('UNAUTHENTICATED', 'Please sign in again.', HttpStatus.UNAUTHORIZED);
  return p;
});

/** Request facts for the audit log. */
export interface RequestMeta {
  ip: string | null;
  requestId: string | null;
  userAgent: string | null;
}
export const Meta = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestMeta => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  return { ip: clientIp(req), requestId: req.id ?? null, userAgent: req.headers['user-agent']?.slice(0, 300) ?? null };
});

export function clientIp(req: Request): string | null {
  const ip = req.ip ?? req.socket?.remoteAddress ?? null;
  return ip ? ip.replace(/^::ffff:/, '') : null;
}
