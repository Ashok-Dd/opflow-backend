import { Controller, Get, HttpStatus, Inject } from '@nestjs/common';
import { Public } from '../../common/auth/auth.decorators';
import { ApiTags } from '@nestjs/swagger';

import { ENV, Env } from '../../config/env';
import { AppError } from '../../common/errors/app-error';
import { DbService } from '../../infra/db/db.service';

/** `/health`: the process is up (for restarts). `/ready`: it can serve traffic (for the load balancer). */
@Public()
@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    private readonly dbs: DbService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('health')
  health() {
    return { status: 'ok', process: this.env.PROCESS_TYPE, env: this.env.APP_ENV, uptimeSeconds: Math.round(process.uptime()) };
  }

  @Get('ready')
  async ready() {
    try {
      const dbMs = await this.dbs.ping();
      return { status: 'ready', checks: { database: { ok: true, ms: dbMs }, redis: { ok: null, note: 'not used until B5' } } };
    } catch {
      throw new AppError('NOT_READY', 'The server cannot reach the database right now.', HttpStatus.SERVICE_UNAVAILABLE, true);
    }
  }
}
