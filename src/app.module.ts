import { randomUUID } from 'node:crypto';

import { Inject, Injectable, Module, OnApplicationBootstrap } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';

import { AuthGuard } from './common/auth/auth.guard';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { AppVersionGuard } from './common/http/app-version.guard';
import { IdempotencyInterceptor } from './common/http/idempotency';
import { ConfigModule } from './config/config.module';
import { ENV, Env, isLocal } from './config/env';
import { DbModule } from './infra/db/db.module';
import { InfraModule } from './infra/infra.module';
import { RateLimitGuard } from './infra/redis/rate-limit';
import { AdminCoreModule, AdminModule } from './modules/admin/admin.module';
import { AppFeaturesModule, DoctorCoreModule } from './modules/app-features.module';
import { AuthModule } from './modules/auth/auth.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { CoreHttpModule, CoreModule } from './modules/core.module';
import { DevController } from './modules/dev/dev.controller';
import { DirectoryModule } from './modules/directory/directory.module';
import { HealthModule } from './modules/health/health.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { JobsService } from './modules/jobs/jobs.service';

/** Everything both processes (API and worker) need: config, database, providers, and the domain services. */
export const DOMAIN_IMPORTS = [ConfigModule, DbModule, InfraModule, DirectoryModule, AuthModule, CoreModule, DoctorCoreModule, AdminCoreModule, JobsModule];

/** Locally (or with JOBS_IN_API=true) the API process also runs the background jobs, so one command runs everything. */
@Injectable()
class JobsInApi implements OnApplicationBootstrap {
  constructor(
    private readonly jobs: JobsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap(): void {
    if (this.env.JOBS_IN_API ?? isLocal(this.env)) this.jobs.start();
  }
}

function hasPrettyLogs(): boolean {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

@Module({ imports: [JobsModule], controllers: [DevController] })
class DevModule {}

const devModules =
  process.env.APP_ENV === undefined || process.env.APP_ENV === 'local' || (process.env.APP_ENV === 'staging' && ['true', '1'].includes(process.env.DEMO_MODE ?? ''))
    ? [DevModule]
    : [];

@Module({
  imports: [
    ...DOMAIN_IMPORTS,
    LoggerModule.forRootAsync({
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          // One id per request: from the caller's X-Request-Id, or new. Returned in the response and in every error.
          genReqId: (req, res) => {
            const incoming = req.headers['x-request-id'];
            const id = typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : `req_${randomUUID()}`;
            res.setHeader('X-Request-Id', id);
            return id;
          },
          // Short request lines: id, method, path, status. Never headers, bodies, secrets or personal data.
          serializers: {
            req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url.replace(/\/setup\/[^/?]+/, '/setup/***').replace(/sig=[^&]+/, 'sig=***') }),
            res: (res: { statusCode: number }) => ({ status: res.statusCode }),
          },
          autoLogging: { ignore: (req) => req.url === '/health' },
          // Readable lines on a laptop; plain JSON on servers (pino-pretty is a dev-only package, absent in the image).
          transport: env.APP_ENV === 'local' && hasPrettyLogs() ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
        },
      }),
    }),
    HealthModule,
    CatalogModule,
    CoreHttpModule,
    AppFeaturesModule,
    AdminModule,
    ...devModules,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Order matters: who is calling → are they over the limit → is their app too old.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: AppVersionGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    JobsInApi,
  ],
})
export class AppModule {}
