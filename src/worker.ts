import 'reflect-metadata';

import { loadDotEnvForLocal } from './config/env';

loadDotEnvForLocal();

import { initSentry } from './common/sentry';

initSentry();

import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { DOMAIN_IMPORTS } from './app.module';
import { JobsService } from './modules/jobs/jobs.service';

/**
 * The worker process: same code, no HTTP. Delivers the outbox (pushes, emails, SMS, refunds at Razorpay,
 * photo resizing) and runs the timed jobs (hold expiry, session generation, payouts, auto-end, checks).
 */
@Module({ imports: DOMAIN_IMPORTS })
class WorkerModule {}

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: false });
  app.enableShutdownHooks();
  app.get(JobsService).start();
  new Logger('Worker').log('OPflow worker started');
}

process.on('unhandledRejection', (reason) => console.error('Unhandled promise rejection:', reason));

bootstrap().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
