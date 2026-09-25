import { EventEmitter } from 'node:events';

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type Redis from 'ioredis';

import { RedisService } from '../redis/redis.service';

export interface LiveChange {
  sessionId: string;
  version: number;
}

/**
 * "This OPD's line changed" signals. With Redis they reach every API machine (pub/sub); without it they stay
 * inside this process, which is enough for one machine (and locally, where jobs run in the API too).
 * Phones never depend on this alone: they also re-check every 15 s, so a lost signal only delays an update.
 */
@Injectable()
export class LiveBus implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(LiveBus.name);
  private readonly local = new EventEmitter().setMaxListeners(100);
  private sub?: Redis;
  private readonly channel: string;

  constructor(private readonly redis: RedisService) {
    this.channel = redis.key('live');
  }

  onModuleInit(): void {
    if (!this.redis.client) return;
    this.sub = this.redis.connect();
    this.sub.subscribe(this.channel).catch((err: Error) => this.log.warn(`Live bus subscribe failed: ${err.message}`));
    this.sub.on('message', (_channel: string, message: string) => {
      try {
        this.local.emit('change', JSON.parse(message) as LiveChange);
      } catch {
        /* ignore malformed */
      }
    });
  }

  publish(change: LiveChange): void {
    if (this.redis.client) {
      this.redis.client.publish(this.channel, JSON.stringify(change)).catch(() => this.local.emit('change', change));
    } else {
      this.local.emit('change', change);
    }
  }

  onChange(handler: (change: LiveChange) => void): () => void {
    this.local.on('change', handler);
    return () => this.local.off('change', handler);
  }

  async onModuleDestroy(): Promise<void> {
    await this.sub?.quit().catch(() => undefined);
  }
}
