import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

import { ENV, Env } from '../../config/env';

/**
 * Optional Redis (Upstash). When REDIS_URL is empty, `client` is undefined and callers fall back to
 * in-process behaviour, which is correct for a single API machine. Redis being down never breaks a request:
 * callers treat errors as "no cache".
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly log = new Logger(RedisService.name);
  readonly client?: Redis;
  readonly prefix: string;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.prefix = env.REDIS_KEY_PREFIX;
    if (env.REDIS_URL) {
      this.client = this.connect();
    }
  }

  /** A new connection (Socket.IO's adapter and pub/sub need their own). */
  connect(): Redis {
    const r = new Redis(this.env.REDIS_URL!, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: false,
      retryStrategy: (times) => Math.min(times * 500, 5000),
    });
    r.on('error', (err) => this.log.warn(`Redis: ${err.message}`));
    return r;
  }

  key(k: string): string {
    return `${this.prefix}${k}`;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.quit().catch(() => undefined);
  }
}
