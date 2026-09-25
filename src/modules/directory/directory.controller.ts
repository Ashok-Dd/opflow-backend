import { Controller, Get, Header } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { Public } from '../../common/auth/auth.decorators';
import { decodeCursor, encodeCursor, IdParam, zCursor, zDate, zLimit, ZQuery } from '../../common/http/zod';
import { DirectoryService } from './directory.service';

const near = z
  .string()
  .regex(/^-?\d{1,2}(\.\d+)?,-?\d{1,3}(\.\d+)?$/, 'must be "lat,lng"')
  .transform((v) => {
    const [lat, lng] = v.split(',').map(Number) as [number, number];
    return { lat, lng };
  })
  .optional();

const doctorsQuery = z.object({
  type: z.string().regex(/^[a-z]+$/).optional(),
  problem: z.string().regex(/^[a-z]+$/).optional(),
  who: z.enum(['adult', 'child']).optional(),
  hospital: z.uuid().optional(),
  q: z.string().max(60).optional(),
  lang: z.string().max(20).optional(),
  day: z.enum(['today', 'tomorrow']).optional(),
  near,
  sort: z.enum(['soonest', 'fee', 'distance', 'name']).optional(),
  cursor: zCursor,
  limit: zLimit,
});

const hospitalsQuery = z.object({
  q: z.string().max(60).optional(),
  near,
  type: z.string().regex(/^[a-z]+$/).optional(),
  emergency: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  cursor: zCursor,
  limit: zLimit,
});

/** Public (no login): patients can look around before logging in. Only verified doctors appear. */
@ApiTags('directory')
@Public()
@Controller('v1')
export class DirectoryController {
  constructor(private readonly dir: DirectoryService) {}

  @Get('doctors')
  @Header('Cache-Control', 'private, max-age=15')
  async doctors(@ZQuery(doctorsQuery) q: z.output<typeof doctorsQuery>) {
    const offset = decodeCursor(q.cursor);
    const { cursor: _c, limit, ...filter } = q;
    const r = await this.dir.cards({ ...filter, offset, limit });
    return { items: r.items, nextCursor: r.hasMore ? encodeCursor(offset + limit) : null };
  }

  @Get('doctors/:id')
  @Header('Cache-Control', 'private, max-age=15')
  doctor(@IdParam() id: string) {
    return this.dir.doctor(id);
  }

  @Get('doctors/:id/days')
  days(@IdParam() id: string, @ZQuery(z.object({ hospital: z.uuid().optional() })) q: { hospital?: string }) {
    return this.dir.days(id, q.hospital);
  }

  @Get('doctors/:id/windows')
  windows(@IdParam() id: string, @ZQuery(z.object({ date: zDate, hospital: z.uuid().optional() })) q: { date: string; hospital?: string }) {
    return this.dir.windows(id, q.date, q.hospital);
  }

  @Get('hospitals')
  @Header('Cache-Control', 'private, max-age=60')
  async hospitals(@ZQuery(hospitalsQuery) q: z.output<typeof hospitalsQuery>) {
    const offset = decodeCursor(q.cursor);
    const r = await this.dir.hospitals({ q: q.q, near: q.near, type: q.type, emergency: q.emergency, offset, limit: q.limit });
    return { items: r.items, nextCursor: r.hasMore ? encodeCursor(offset + q.limit) : null };
  }

  @Get('hospitals/:id')
  @Header('Cache-Control', 'private, max-age=30')
  hospital(@IdParam() id: string) {
    return this.dir.hospital(id);
  }
}
