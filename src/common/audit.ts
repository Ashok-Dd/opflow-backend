import type { ActorType } from '../infra/db/schema';
import type { Tx } from '../infra/db/db.service';
import type { RequestMeta } from './auth/auth.decorators';

export interface AuditEntry {
  actorType: ActorType;
  actorId: string | null;
  action: string; // 'doctor.create', 'approval.approve', 'patient.reveal_phone'…
  entity: string; // 'doctor', 'booking', 'app_config'…
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  meta?: RequestMeta;
}

/** Append-only record of who changed what (the database refuses edits and deletes of these rows). */
export async function audit(tx: Tx, e: AuditEntry): Promise<void> {
  await tx
    .insertInto('auditLog')
    .values({
      actorType: e.actorType,
      actorId: e.actorId,
      action: e.action,
      entity: e.entity,
      entityId: e.entityId ?? null,
      before: e.before === undefined ? null : JSON.stringify(e.before),
      after: e.after === undefined ? null : JSON.stringify(e.after),
      ip: e.meta?.ip ?? null,
      requestId: e.meta?.requestId ?? null,
    })
    .execute();
}
