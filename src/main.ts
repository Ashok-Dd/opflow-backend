import 'reflect-metadata';

import { loadDotEnvForLocal } from './config/env';

loadDotEnvForLocal();

import { captureError, flushSentry, initSentry } from './common/sentry';

initSentry();

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import { ENV, Env } from './config/env';

async function bootstrap() {
  // rawBody: Cashfree webhook signatures are checked on the exact bytes received.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true, rawBody: true });
  app.useBodyParser('json', { limit: '200kb' });
  const env = app.get<Env>(ENV);
  const log = app.get(Logger);
  app.useLogger(log);

  app.use(helmet());
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', 1);
  // The mobile app is not a browser; CORS is only for the admin site.
  app.enableCors({ origin: [...env.CORS_ORIGINS, ...(env.DOCTOR_WEB_ORIGIN ? [env.DOCTOR_WEB_ORIGIN] : [])], credentials: true });
  app.enableShutdownHooks(); // finish in-flight requests and close the database pool on deploy/restart

  if (env.APP_ENV !== 'production') {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('OPflow API').setVersion('v1').setDescription('See backend/docs/ARCHITECTURE.md').build(),
    );
    SwaggerModule.setup('docs', app, doc, { jsonDocumentUrl: 'docs/openapi.json' });
  }

  await app.listen(env.PORT, '0.0.0.0');
  log.log(`OPflow API listening on :${env.PORT} (${env.APP_ENV})`, 'Bootstrap');
}

// A crash is logged, and the host restarts the process. Other instances keep serving meanwhile.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
  captureError(reason, { where: 'unhandledRejection' });
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception, exiting so the host restarts us:', err);
  captureError(err, { where: 'uncaughtException' });
  void flushSentry().finally(() => process.exit(1));
});

bootstrap().catch((err: unknown) => {
  // Most often: the environment is not valid (the message lists what to fix).
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
