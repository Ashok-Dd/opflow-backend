/**
 * OPflow has exactly one admin. This makes that admin and prints a one-time setup link (24 h).
 *
 *   npm run admin:create -- --email you@opflow.in --name "Your Name"
 *     first time: creates the admin
 *     again with the same email: a fresh setup link (lost phone / forgot password): the old password and
 *     authenticator stop working once the new setup is finished
 *   npm run admin:create -- --email new@opflow.in --name "New Person" --replace
 *     hand over to a different person: the current admin is switched off and signed out
 */
import 'reflect-metadata';

import { loadDotEnvForLocal } from '../src/config/env';

loadDotEnvForLocal();

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { DOMAIN_IMPORTS } from '../src/app.module';
import { audit } from '../src/common/audit';
import { DbService } from '../src/infra/db/db.service';
import { AdminAuthService } from '../src/modules/admin/admin-auth.service';

@Module({ imports: DOMAIN_IMPORTS })
class CliModule {}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const email = arg('email');
  const name = arg('name');
  const replace = process.argv.includes('--replace');
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name) {
    console.error('Usage: npm run admin:create -- --email you@opflow.in --name "Your Name" [--replace]');
    process.exit(2);
  }
  const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error'] });
  const dbs = app.get(DbService);
  const auth = app.get(AdminAuthService);
  const existing = await dbs.db.selectFrom('adminUsers').select(['id', 'status']).where('email', '=', email.toLowerCase()).executeTakeFirst();
  const result = await dbs.system(async (tx) => {
    if (existing) {
      if (existing.status !== 'active') {
        if (!replace) throw new Error(`${email} is switched off. Add --replace to make them the admin again.`);
        const others = await tx.selectFrom('adminUsers').select('id').where('status', '=', 'active').execute();
        for (const o of others) await tx.updateTable('adminUsers').set({ status: 'suspended' }).where('id', '=', o.id).execute();
        await tx.updateTable('refreshTokens').set({ revokedAt: new Date() }).where('adminId', 'is not', null).where('revokedAt', 'is', null).execute();
        await tx.updateTable('adminUsers').set({ status: 'active' }).where('id', '=', existing.id).execute();
      }
      const token = await auth.createSetupLink(tx, existing.id);
      return { id: existing.id, url: auth.setupUrl(token), created: false };
    }
    const r = await auth.createAdmin(tx, { email, name, replace });
    await audit(tx, { actorType: 'system', actorId: null, action: 'admin.create_cli', entity: 'admin_user', entityId: r.admin.id, after: { email, replace } });
    return { id: r.admin.id, url: r.setupUrl, created: true };
  });
  console.log(result.created ? 'Admin created.' : 'Admin already exists: here is a new setup link.');
  console.log(`One-time setup link (valid 24 hours, give it only to ${email}):\n${result.url}`);
  await app.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
