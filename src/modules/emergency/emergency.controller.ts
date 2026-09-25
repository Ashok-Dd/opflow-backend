import { Controller, Get, Header, HttpStatus, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { sql } from 'kysely';
import { z } from 'zod';

import { Public } from '../../common/auth/auth.decorators';
import { AppError } from '../../common/errors/app-error';
import { ZQuery } from '../../common/http/zod';
import { emergencyCharge, money } from '../../common/money';
import { DbService } from '../../infra/db/db.service';
import { RulesService } from '../../infra/rules/rules.service';
import { DirectoryService } from '../directory/directory.service';

const nearQuery = z.object({
  kind: z.string().regex(/^[a-z]+$/).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
});

/** Emergency help. Public: it must work before login, and fast. */
@ApiTags('emergency')
@Public()
@Controller('v1/emergency')
export class EmergencyController {
  constructor(
    private readonly dbs: DbService,
    private readonly dir: DirectoryService,
    private readonly rules: RulesService,
  ) {}

  /** Hospitals with 24-hour emergency (nearest first) and doctors available now for this kind of emergency. */
  @Get('near')
  @Header('Cache-Control', 'private, max-age=15')
  async near(@ZQuery(nearQuery) q: z.output<typeof nearQuery>) {
    if (!(await this.rules.emergencyEnabled())) {
      return { enabled: false, message: 'Please call 108 for an ambulance.', hospitals: [], doctors: [] };
    }
    const near = q.lat !== undefined && q.lng !== undefined ? { lat: q.lat, lng: q.lng } : undefined;
    const hospitals = await this.dir.hospitals({ near, emergency: true, offset: 0, limit: 10 });
    const types = q.kind
      ? (await this.dbs.db.selectFrom('emergencyKindTypes').select('typeId').where('kindId', '=', q.kind).execute()).map((r) => r.typeId)
      : [];
    const ids = await sql<{ doctorId: string }>`
      select es.doctor_id from emergency_status es join doctors d on d.id = es.doctor_id
       where d.verification = 'verified' and d.status = 'active'
         and (es.status = 'available_now' or (es.status = 'available_till' and es.until_at > now()))
         and (${types.length === 0} or d.type_id = any(${types}::text[]))`.execute(this.dbs.db);
    const doctors = ids.rows.length ? (await this.dir.cards({ ids: ids.rows.map((r) => r.doctorId), near, sort: near ? 'distance' : 'name', limit: 30 })).items : [];
    const consultOn = await this.rules.emergencyConsultEnabled();
    const pct = await this.rules.emergencyChargePercent();
    return {
      enabled: true,
      call: '108',
      hospitals: hospitals.items,
      doctors: doctors.map((d) => ({
        ...d,
        emergencyConsult: consultOn
          ? { fee: d.fee, charge: money(Math.max(100, emergencyCharge(d.fee.paise, pct))), total: money(d.fee.paise + Math.max(100, emergencyCharge(d.fee.paise, pct))) }
          : null,
      })),
    };
  }

  /** Every published first-aid page (the app caches them for offline use). */
  @Get('first-aid')
  @Header('Cache-Control', 'public, max-age=300')
  async firstAid() {
    return this.dbs.db
      .selectFrom('firstAidGuides')
      .select(['kindId', 'intro', 'signs', 'callNowIf', 'dos', 'donts', 'sources', 'reviewedByDoctor', 'reviewedAt', 'publishedAt'])
      .where('status', '=', 'published')
      .execute();
  }

  @Get('first-aid/:kind')
  @Header('Cache-Control', 'public, max-age=300')
  async firstAidOne(@Param('kind') kind: string) {
    const g = /^[a-z]+$/.test(kind)
      ? await this.dbs.db
          .selectFrom('firstAidGuides')
          .select(['kindId', 'intro', 'signs', 'callNowIf', 'dos', 'donts', 'sources', 'reviewedByDoctor', 'reviewedAt', 'publishedAt'])
          .where('kindId', '=', kind)
          .where('status', '=', 'published')
          .executeTakeFirst()
      : undefined;
    if (!g) throw new AppError('NOT_PUBLISHED', 'This first-aid page is not ready yet. Please call 108 if it is serious.', HttpStatus.NOT_FOUND);
    return g;
  }
}
