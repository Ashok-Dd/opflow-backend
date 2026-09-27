import { Controller, Get, Headers, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { PatientId, Roles } from '../../common/auth/auth.decorators';
import { Idempotent } from '../../common/http/idempotency';
import { decodeCursor, encodeCursor, IdParam, ZBody, zCursor, zLimit, ZQuery } from '../../common/http/zod';
import { RateLimit } from '../../infra/redis/rate-limit';
import { BookingsService } from './bookings.service';
import { zReturnTo } from '../payments/orders';

const holdBody = z.object({ windowId: z.uuid(), note: z.string().trim().max(140).optional(), returnTo: zReturnTo });
const emergencyBody = z.object({ doctorId: z.uuid(), returnTo: zReturnTo });
const rescheduleBody = z.object({ windowId: z.uuid() });
const listQuery = z.object({ tab: z.enum(['upcoming', 'past']).default('upcoming'), cursor: zCursor, limit: zLimit });

@ApiTags('bookings')
@Roles('patient')
@Controller('v1/bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  /** Keep a place for 10 minutes and get a Cashfree order to pay for it. */
  @Post('hold')
  @Idempotent()
  @RateLimit('hold', 10, 60)
  hold(@PatientId() userId: string, @ZBody(holdBody) body: z.output<typeof holdBody>, @Headers('idempotency-key') key?: string) {
    return this.bookings.hold(userId, body, key);
  }

  /** Emergency consultation with a doctor who is available now: fee + emergency charge. */
  @Post('emergency')
  @Idempotent()
  @RateLimit('hold', 10, 60)
  emergency(@PatientId() userId: string, @ZBody(emergencyBody) body: z.output<typeof emergencyBody>, @Headers('idempotency-key') key?: string) {
    return this.bookings.holdEmergency(userId, body.doctorId, key, body.returnTo);
  }

  @Get()
  async list(@PatientId() userId: string, @ZQuery(listQuery) q: z.output<typeof listQuery>) {
    const offset = decodeCursor(q.cursor);
    const r = await this.bookings.list(userId, q.tab, offset, q.limit);
    return { items: r.items, nextCursor: r.hasMore ? encodeCursor(offset + q.limit) : null };
  }

  @Get(':id')
  get(@PatientId() userId: string, @IdParam() id: string) {
    return this.bookings.get(userId, id);
  }

  @Get(':id/timeline')
  timeline(@PatientId() userId: string, @IdParam() id: string) {
    return this.bookings.timeline(userId, id);
  }

  /** Change date or time (once, up to 2 hours before). */
  @Post(':id/reschedule')
  @HttpCode(200)
  @Idempotent()
  reschedule(@PatientId() userId: string, @IdParam() id: string, @ZBody(rescheduleBody) body: z.output<typeof rescheduleBody>) {
    return this.bookings.reschedule(userId, id, body.windowId);
  }

  @Get(':id/receipt')
  receipt(@PatientId() userId: string, @IdParam() id: string) {
    return this.bookings.receipt(userId, id);
  }
}
