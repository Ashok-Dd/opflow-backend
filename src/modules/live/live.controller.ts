import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { CurrentDoctor, PatientId, Roles } from '../../common/auth/auth.decorators';
import { AppError } from '../../common/errors/app-error';
import { Idempotent } from '../../common/http/idempotency';
import { IdParam, ZBody, ZQuery } from '../../common/http/zod';
import { Command, LiveService } from './live.service';

const commandBody = z.object({
  expectedVersion: z.number().int().min(0).optional(),
  bookingId: z.uuid().optional(),
  minutes: z.number().int().min(0).max(600).optional(),
  leftovers: z.enum(['move', 'cancel']).optional(),
  reason: z.string().trim().max(120).optional(),
});

const COMMANDS: Command[] = ['start', 'pause', 'resume', 'late', 'end', 'call-next', 'done', 'did-not-come', 'skip', 'call-now', 'mark-reached', 'put-back'];

@ApiTags('live')
@Controller('v1')
export class LiveController {
  constructor(private readonly live: LiveService) {}

  /** Patient: their board (polling fallback when the WebSocket is down). */
  @Get('live/sessions/:id')
  @Roles('patient')
  patient(@PatientId() userId: string, @IdParam() id: string, @ZQuery(z.object({ since: z.coerce.number().int().min(0).optional() })) q: { since?: number }) {
    return this.live.patientView(userId, id, q.since);
  }

  /** Doctor: the full line. */
  @Get('doctor/sessions/:id/line')
  @Roles('doctor')
  line(@CurrentDoctor() d: { doctorId: string }, @IdParam() id: string) {
    return this.live.doctorView(d.doctorId, id);
  }

  /**
   * Doctor console: start · pause · resume · late {minutes} · end {leftovers: move|cancel} · call-next · done ·
   * did-not-come · skip · call-now · mark-reached · put-back (the last five with {bookingId}).
   * Send `expectedVersion` (the board version on screen): position commands on an old screen are refused.
   */
  @Post('doctor/sessions/:id/:command')
  @Roles('doctor')
  @HttpCode(200)
  @Idempotent({ required: false })
  command(
    @CurrentDoctor() d: { userId: string; doctorId: string },
    @IdParam() id: string,
    @Param('command') command: string,
    @ZBody(commandBody) body: z.output<typeof commandBody>,
  ) {
    if (!COMMANDS.includes(command as Command)) throw new AppError('NOT_FOUND', 'We could not find this. It may have been moved or removed.', 404);
    return this.live.command(d, id, command as Command, body);
  }
}
