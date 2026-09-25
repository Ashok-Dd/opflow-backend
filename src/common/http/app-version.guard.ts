import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { compareVersions, RulesService } from '../../infra/rules/rules.service';
import { AppError } from '../errors/app-error';

/**
 * The phone app sends `X-App-Version`. Versions older than `min_supported_app_version` get 426, and the app
 * shows its "Please update OPflow" screen. Requests without the header (admin site, webhooks) are not checked.
 */
@Injectable()
export class AppVersionGuard implements CanActivate {
  constructor(private readonly rules: RulesService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const version = ctx.switchToHttp().getRequest<Request>().headers['x-app-version'];
    if (typeof version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(version)) return true;
    const min = await this.rules.minAppVersion().catch(() => null);
    if (min && compareVersions(version, min) < 0) {
      throw new AppError('UPGRADE_REQUIRED', 'Please update OPflow to continue.', 426 as HttpStatus);
    }
    return true;
  }
}
