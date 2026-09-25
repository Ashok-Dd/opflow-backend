import { Injectable } from '@nestjs/common';

import type { AdminPrincipal, RequestMeta } from '../../common/auth/auth.decorators';
import { audit } from '../../common/audit';
import { enqueue, notify } from '../../common/outbox';
import type { Tx } from '../../infra/db/db.service';
import { RulesService } from '../../infra/rules/rules.service';
import { TokensService } from '../auth/tokens.service';

export type Change =
  | { kind: 'verify_doctor'; doctorId: string }
  | { kind: 'edit_doctor_locked'; doctorId: string; changes: { name?: string; typeId?: string; degrees?: string; regCouncil?: string; regNo?: string } }
  | { kind: 'suspend_doctor'; doctorId: string }
  | { kind: 'config_change'; key: string; value: unknown };

/**
 * OPflow has one admin, so risky changes apply at once, never waiting for a second person. What protects them:
 * the admin re-enters their authenticator code for the riskiest ones (step-up), must give a reason, and every
 * change is written to the append-only audit log with before/after.
 */
@Injectable()
export class ChangesService {
  constructor(
    private readonly tokens: TokensService,
    private readonly rules: RulesService,
  ) {}

  async apply(tx: Tx, who: AdminPrincipal, subject: { type: string; id: string }, c: Change, reason: string, meta: RequestMeta): Promise<unknown> {
    const applied = await this.run(tx, who, c);
    await audit(tx, { actorType: 'admin', actorId: who.adminId, action: `change.${c.kind}`, entity: subject.type, entityId: subject.id, after: { change: c, reason, applied }, meta });
    return applied;
  }

  private async run(tx: Tx, who: AdminPrincipal, c: Change): Promise<unknown> {
    switch (c.kind) {
      case 'verify_doctor': {
        const d = await tx.selectFrom('doctors').select(['id', 'userId', 'listedAt']).where('id', '=', c.doctorId).executeTakeFirstOrThrow();
        await tx
          .updateTable('doctors')
          .set({ verification: 'verified', verifiedAt: new Date(), verifiedBy: who.adminId, verificationNote: null, listedAt: d.listedAt ?? new Date() })
          .where('id', '=', c.doctorId)
          .execute();
        await notify(tx, { userId: d.userId, kind: 'system', title: 'You are live on OPflow', body: 'Patients can now find you and book your times.', dedupeKey: `live:${d.id}` });
        return { verified: true };
      }
      case 'edit_doctor_locked': {
        const changes = Object.fromEntries(Object.entries(c.changes).filter(([, v]) => v !== undefined && v !== ''));
        const before = await tx.selectFrom('doctors').select(['name', 'typeId', 'degrees', 'regCouncil', 'regNo', 'userId']).where('id', '=', c.doctorId).executeTakeFirstOrThrow();
        await tx.updateTable('doctors').set(changes).where('id', '=', c.doctorId).execute();
        await notify(tx, { userId: before.userId, kind: 'system', title: 'Your profile was updated', body: 'The OPflow team updated your registered details.', push: false });
        return { before: { name: before.name, typeId: before.typeId, degrees: before.degrees, regCouncil: before.regCouncil, regNo: before.regNo }, after: changes };
      }
      case 'suspend_doctor': {
        const d = await tx.selectFrom('doctors').select(['id', 'userId']).where('id', '=', c.doctorId).executeTakeFirstOrThrow();
        await tx.updateTable('doctors').set({ status: 'suspended' }).where('id', '=', d.id).execute();
        await this.tokens.revokeAllForUser(tx, d.userId, 'doctor');
        await tx.updateTable('emergencyStatus').set({ status: 'off', untilAt: null, hospitalId: null }).where('doctorId', '=', d.id).execute();
        // Future bookings: full refunds through the same doctor-cancel flow (one background job per booking).
        const future = await tx.selectFrom('bookings').select(['id']).where('doctorId', '=', d.id).where('status', '=', 'confirmed').execute();
        if (future.length) {
          const op = await tx.insertInto('bulkOperations').values({ doctorId: d.id, kind: 'cancel_day', total: future.length, createdBy: who.adminId }).returning('id').executeTakeFirstOrThrow();
          for (const b of future) {
            await enqueue(tx, { topic: 'bulk.cancel', payload: { bulkId: op.id, bookingId: b.id, reason: 'The doctor is not available on OPflow', actorId: null } }, { dedupeKey: `bulk:${op.id}:${b.id}` });
          }
        }
        await tx.updateTable('opdWindows').set({ status: 'closed' }).where('sessionId', 'in', (eb) => eb.selectFrom('opdSessions').select('id').where('doctorId', '=', d.id).where('status', '=', 'scheduled')).execute();
        return { suspended: true, bookingsToRefund: future.length };
      }
      case 'config_change': {
        const before = await tx.selectFrom('appConfig').select('value').where('key', '=', c.key).executeTakeFirstOrThrow();
        await tx.updateTable('appConfig').set({ value: JSON.stringify(c.value), updatedBy: who.adminId }).where('key', '=', c.key).execute();
        this.rules.invalidate();
        return { key: c.key, before: before.value, after: c.value };
      }
    }
  }
}
