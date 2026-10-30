/**
 * Demo doctors near Bhimavaram (West Godavari) so the owner can test near their own location.
 *   npx ts-node --transpile-only scripts/seed-bhimavaram.ts            add (safe to run again)
 *   npx ts-node --transpile-only scripts/seed-bhimavaram.ts --remove   hide them from patients
 */
import 'reflect-metadata';

import { loadDotEnvForLocal } from '../src/config/env';

loadDotEnvForLocal();

import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { sql } from 'kysely';

import { DOMAIN_IMPORTS } from '../src/app.module';
import { DbService } from '../src/infra/db/db.service';
import { PasswordsService } from '../src/modules/auth/passwords.service';
import { ScheduleService } from '../src/modules/schedule/schedule.service';

@Module({ imports: DOMAIN_IMPORTS })
class SeedModule {}

const HOSPITALS = [
  { key: 'b1', slug: 'demo-sri-venkateswara-hospital-bhimavaram', name: 'Sri Venkateswara Hospital', area: 'JP Road', pin: '534201', lat: 16.5446, lng: 81.5198, phone: '08816 223 344', address: 'JP Road, near Old Bus Stand, Bhimavaram 534201', timings: 'Mon–Sat · 9 AM – 1 PM, 5 PM – 8 PM', emergency: true, types: ['general', 'child', 'women', 'bone'] },
  { key: 'b2', slug: 'demo-godavari-care-clinic-chinamiram', name: 'Godavari Care Clinic', area: 'Chinamiram', pin: '534204', lat: 16.5412, lng: 81.5003, phone: '08816 231 122', address: 'Main Road, Chinamiram, Bhimavaram 534204', timings: 'Mon–Sat · 10 AM – 1 PM, 5 PM – 7 PM', emergency: false, types: ['general', 'skin', 'child'] },
];

const WEEK = [1, 2, 3, 4, 5, 6];
const DOCTORS = [
  { login: 'OPD-10244', phone: '+919000010244', name: 'Dr. Ch. Ravi Kumar', type: 'general', degrees: 'MBBS, MD (General Medicine)', years: 15, langs: ['Telugu', 'English'], fee: 250, hospitals: ['b1', 'b2'], days: WEEK, gender: 'male', reg: '61244', about: 'Fever, sugar, BP, body pains and all common health problems for adults.' },
  { login: 'OPD-10245', phone: '+919000010245', name: 'Dr. B. Padmavathi', type: 'women', degrees: 'MBBS, MS (OBG)', years: 12, langs: ['Telugu', 'English'], fee: 350, hospitals: ['b1'], days: WEEK, gender: 'female', reg: '61245', about: "Pregnancy care, periods problems and women's health." },
  { login: 'OPD-10246', phone: '+919000010246', name: 'Dr. G. Satish', type: 'child', degrees: 'MBBS, MD (Pediatrics)', years: 9, langs: ['Telugu', 'English', 'Hindi'], fee: 300, hospitals: ['b2', 'b1'], days: [1, 2, 3, 4, 5, 6, 7], gender: 'male', reg: '61246', about: 'Child doctor for new-born babies to 16 years. Fever, cough, vaccines and growth checks.' },
  { login: 'OPD-10247', phone: '+919000010247', name: 'Dr. K. Swathi', type: 'skin', degrees: 'MBBS, MD (Dermatology)', years: 7, langs: ['Telugu', 'English'], fee: 300, hospitals: ['b2'], days: WEEK, gender: 'female', reg: '61247', about: 'Skin rash, itching, pimples, hair fall and nail problems.' },
  { login: 'OPD-10248', phone: '+919000010248', name: 'Dr. V. Nageswara Rao', type: 'bone', degrees: 'MBBS, MS (Ortho)', years: 18, langs: ['Telugu', 'English'], fee: 400, hospitals: ['b1'], days: WEEK, gender: 'male', reg: '61248', about: 'Joint pain, back pain, broken bones and sports injuries.' },
] as const;

async function main() {
  const app = await NestFactory.createApplicationContext(SeedModule, { logger: ['error', 'warn'] });
  const dbs = app.get(DbService);
  const passwords = app.get(PasswordsService);
  const schedule = app.get(ScheduleService);
  const remove = process.argv.includes('--remove');

  if (remove) {
    await dbs.system(async (tx) => {
      await tx.updateTable('hospitals').set({ status: 'hidden' }).where('slug', 'like', 'demo-%').execute();
      await sql`update doctors d set status = 'suspended' from doctor_credentials c where c.user_id = d.user_id and c.login_id between 'OPD-10244' and 'OPD-10248' and d.reg_council = 'DEMO'`.execute(tx);
    });
    console.log('Demo doctors and hospitals are hidden from patients.');
    await app.close();
    return;
  }

  const demoHash = await passwords.hash('demo1234');
  const ids = new Map<string, string>();
  await dbs.system(async (tx) => {
    for (const h of HOSPITALS) {
      const row = await tx
        .insertInto('hospitals')
        .values({ slug: h.slug, name: h.name, address: h.address, area: h.area, city: 'Bhimavaram', pin: h.pin, lat: h.lat, lng: h.lng, phone: h.phone, opdTimingsText: h.timings, hasEmergency: h.emergency })
        .onConflict((oc) => oc.column('slug').doUpdateSet({ status: 'active' }))
        .returning('id')
        .executeTakeFirstOrThrow();
      ids.set(h.key, row.id);
      for (const t of h.types) await tx.insertInto('hospitalDepartments').values({ hospitalId: row.id, typeId: t }).onConflict((oc) => oc.doNothing()).execute();
    }
  });

  let created = 0;
  for (const d of DOCTORS) {
    const doctorId = await dbs.system(async (tx) => {
      const existing = await tx.selectFrom('doctorCredentials as c').innerJoin('doctors as d', 'd.userId', 'c.userId').select('d.id').where('c.loginId', '=', d.login).executeTakeFirst();
      if (existing) {
        await tx.updateTable('doctors').set({ status: 'active' }).where('id', '=', existing.id).execute();
        return existing.id;
      }
      const user = await tx.insertInto('users').values({ phone: d.phone }).onConflict((oc) => oc.column('phone').doUpdateSet({ status: 'active' })).returning('id').executeTakeFirstOrThrow();
      await tx.insertInto('userRoles').values({ userId: user.id, role: 'doctor' }).onConflict((oc) => oc.doNothing()).execute();
      const doc = await tx
        .insertInto('doctors')
        .values({
          userId: user.id,
          name: d.name,
          typeId: d.type,
          degrees: d.degrees,
          regCouncil: 'DEMO',
          regNo: d.reg,
          gender: d.gender,
          yearsExperience: d.years,
          languages: [...d.langs],
          about: d.about,
          feePaise: d.fee * 100,
          verification: 'verified',
          verifiedAt: new Date(),
          listedAt: new Date(),
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await tx
        .insertInto('doctorHospitals')
        .values(d.hospitals.map((h, i) => ({ doctorId: doc.id, hospitalId: ids.get(h)!, isPrimary: i === 0 })))
        .execute();
      await tx.insertInto('doctorCredentials').values({ userId: user.id, loginId: d.login, passwordHash: demoHash, mustChange: true }).execute();
      await tx.insertInto('payoutAccounts').values({ doctorId: doc.id }).execute();
      await tx.insertInto('emergencyStatus').values({ doctorId: doc.id }).execute();
      created++;
      return doc.id;
    });
    // Mornings at the first hospital, evenings at the second.
    for (const [i, h] of d.hospitals.entries()) {
      await dbs.system((tx) =>
        schedule.saveWeek(tx, doctorId, {
          hospitalId: ids.get(h)!,
          days: d.days.map((weekday) => ({
            weekday,
            blocks: i === 0 ? [{ start: '09:00', end: '13:00', perHour: 6 }] : [{ start: '17:00', end: '19:00', perHour: 6 }],
          })),
        }),
        60_000,
      );
    }
  }
  const sessions = await dbs.db.selectFrom('opdSessions').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow();
  console.log(`Demo ready: ${HOSPITALS.length} hospitals, ${DOCTORS.length} doctors (${created} new), ${sessions.n} OPD sessions.`);
  console.log('Doctor logins OPD-10244 … OPD-10248 / demo1234 (new password asked at first login).');
  await app.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
