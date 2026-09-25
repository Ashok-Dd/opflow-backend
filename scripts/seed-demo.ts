/**
 * Demo data matching the app's mock screens: 5 hospitals in Guntur, 10 verified doctors with weekly timings,
 * and the demo doctor login OPD-10234 / demo1234 (must change on first login, like the app).
 *
 *   npm run seed:demo            add (safe to run again: existing rows are kept)
 *   npm run seed:demo -- --remove  take the demo doctors and hospitals out of patient view
 *
 * Runs as the database's "system" role through the normal API login (never as postgres).
 * Do NOT run it on production.
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
  { key: 'h1', slug: 'demo-sri-lakshmi-hospital-brodipet', name: 'Sri Lakshmi Hospital', area: 'Brodipet', pin: '522002', lat: 16.3016, lng: 80.4428, phone: '0863 223 4455', address: '4th Lane, Brodipet, Guntur 522002', timings: 'Mon–Sat · 9 AM – 1 PM, 5 PM – 8 PM', emergency: true, types: ['general', 'child', 'women', 'bone', 'heart', 'surgeon'] },
  { key: 'h2', slug: 'demo-city-childrens-clinic-arundelpet', name: "City Children's Clinic", area: 'Arundelpet', pin: '522002', lat: 16.2989, lng: 80.4512, phone: '0863 224 1122', address: '2/7 Arundelpet Main Road, Guntur 522002', timings: 'Mon–Sun · 9 AM – 1 PM, 6 PM – 8 PM', emergency: true, types: ['child'] },
  { key: 'h3', slug: 'demo-amaravati-care-hospital', name: 'Amaravati Care Hospital', area: 'Amaravati Road', pin: '522034', lat: 16.3175, lng: 80.4301, phone: '0863 235 7788', address: 'Near RTC Colony, Amaravati Road, Guntur 522034', timings: 'Mon–Sat · 9 AM – 2 PM, 5 PM – 8 PM', emergency: true, types: ['general', 'heart', 'brain', 'lungs', 'kidney', 'stomach', 'surgeon'] },
  { key: 'h4', slug: 'demo-sai-eye-ent-centre-lakshmipuram', name: 'Sai Eye & ENT Centre', area: 'Lakshmipuram', pin: '522007', lat: 16.3101, lng: 80.4203, phone: '0863 226 9090', address: 'Main Road, Lakshmipuram, Guntur 522007', timings: 'Mon–Sat · 10 AM – 2 PM', emergency: false, types: ['eye', 'ent'] },
  { key: 'h5', slug: 'demo-krishna-skin-smile-clinic-kothapet', name: 'Krishna Skin & Smile Clinic', area: 'Kothapet', pin: '522001', lat: 16.2952, lng: 80.4589, phone: '0863 221 3344', address: 'Opp. Market, Kothapet, Guntur 522001', timings: 'Mon–Sat · 10 AM – 1 PM, 5 PM – 8 PM', emergency: false, types: ['skin', 'teeth', 'mind'] },
];

const WEEK = [1, 2, 3, 4, 5, 6];
const DOCTORS = [
  { login: 'OPD-10234', phone: '+919000010234', name: 'Dr. Srinivas Rao', type: 'child', degrees: 'MBBS, MD (Pediatrics)', years: 14, langs: ['Telugu', 'English', 'Hindi'], fee: 300, hospitals: ['h1', 'h2'], days: WEEK, gender: 'male', reg: '45821', about: 'Child doctor for new-born babies to 16 years. Fever, cough, feeding problems, vaccines and growth checks.' },
  { login: 'OPD-10235', phone: '+919000010235', name: 'Dr. Lakshmi Prasanna', type: 'women', degrees: 'MBBS, MS (OBG)', years: 11, langs: ['Telugu', 'English'], fee: 400, hospitals: ['h1'], days: WEEK, gender: 'female', reg: '51230', about: "Pregnancy care, periods problems and women's health." },
  { login: 'OPD-10236', phone: '+919000010236', name: 'Dr. K. Venkatesh', type: 'general', degrees: 'MBBS, MD (General Medicine)', years: 20, langs: ['Telugu', 'English'], fee: 250, hospitals: ['h1', 'h3'], days: WEEK, gender: 'male', reg: '30417', about: 'Fever, sugar, BP, body pains and all common health problems for adults.' },
  { login: 'OPD-10237', phone: '+919000010237', name: 'Dr. Sravani Devi', type: 'general', degrees: 'MBBS, DNB (Family Medicine)', years: 7, langs: ['Telugu', 'English', 'Hindi'], fee: 200, hospitals: ['h3'], days: [1, 2, 3, 4, 5, 6, 7], gender: 'female', reg: '60218', about: 'Family doctor for all ages. Fever, cough, cold and regular health checks.' },
  { login: 'OPD-10238', phone: '+919000010238', name: 'Dr. Anjali Reddy', type: 'skin', degrees: 'MBBS, MD (Dermatology)', years: 9, langs: ['Telugu', 'English'], fee: 350, hospitals: ['h5'], days: WEEK, gender: 'female', reg: '55412', about: 'Skin rash, itching, pimples, hair fall and nail problems.' },
  { login: 'OPD-10239', phone: '+919000010239', name: 'Dr. Ramesh Babu', type: 'bone', degrees: 'MBBS, MS (Ortho)', years: 16, langs: ['Telugu', 'English'], fee: 400, hospitals: ['h1'], days: WEEK, gender: 'male', reg: '38820', about: 'Joint pain, back pain, broken bones and sports injuries.' },
  { login: 'OPD-10240', phone: '+919000010240', name: 'Dr. Farah Khan', type: 'eye', degrees: 'MBBS, MS (Ophthalmology)', years: 12, langs: ['English', 'Hindi', 'Urdu', 'Telugu'], fee: 300, hospitals: ['h4'], days: WEEK, gender: 'female', reg: '47301', about: 'Eye checks, glasses, red eyes, eye pain and cataract.' },
  { login: 'OPD-10241', phone: '+919000010241', name: 'Dr. P. Suresh', type: 'ent', degrees: 'MBBS, MS (ENT)', years: 10, langs: ['Telugu', 'English'], fee: 300, hospitals: ['h4'], days: WEEK, gender: 'male', reg: '50119', about: 'Ear pain, hearing problems, nose block, sinus and throat pain.' },
  { login: 'OPD-10242', phone: '+919000010242', name: 'Dr. Harika Chowdary', type: 'teeth', degrees: 'BDS, MDS', years: 6, langs: ['Telugu', 'English'], fee: 200, hospitals: ['h5'], days: WEEK, gender: 'female', reg: '20931', about: "Tooth pain, cleaning, fillings and children's teeth." },
  { login: 'OPD-10243', phone: '+919000010243', name: 'Dr. M. Naveen Kumar', type: 'heart', degrees: 'MBBS, MD, DM (Cardiology)', years: 18, langs: ['Telugu', 'English'], fee: 600, hospitals: ['h3', 'h1'], days: [1, 3, 5], gender: 'male', reg: '33105', about: 'Chest pain, BP, heart beat problems and heart checks.' },
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
      await sql`update doctors d set status = 'suspended' from doctor_credentials c where c.user_id = d.user_id and c.login_id between 'OPD-10234' and 'OPD-10243' and d.reg_council = 'DEMO'`.execute(tx);
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
        .values({ slug: h.slug, name: h.name, address: h.address, area: h.area, city: 'Guntur', pin: h.pin, lat: h.lat, lng: h.lng, phone: h.phone, opdTimingsText: h.timings, hasEmergency: h.emergency })
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
  console.log('Demo doctor login: OPD-10234 / demo1234 (asks for a new password at first login).');
  await app.close();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
