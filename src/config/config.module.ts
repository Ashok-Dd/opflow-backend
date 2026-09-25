import { Global, Module } from '@nestjs/common';

import { ENV, loadEnv } from './env';

/** Makes the checked environment available everywhere as `@Inject(ENV) env: Env`. */
@Global()
@Module({
  providers: [{ provide: ENV, useFactory: () => loadEnv() }],
  exports: [ENV],
})
export class ConfigModule {}
