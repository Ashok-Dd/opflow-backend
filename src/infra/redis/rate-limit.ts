import { CanActivate, ExecutionContext, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AuthedRequest, clientIp } from '../../common/auth/auth.decorators';
import { AppError } from '../../common/errors/app-error';
import { RedisService } from './redis.service';

export interface LimitRule {
  name: string;
  limit: number;
  windowSeconds: number;
  by: 'ip' | 'user';
}

export const RATE_LIMIT = 'rateLimit';

/** Per-route limit, e.g. @RateLimit('doctor-login', 10, 60, 'ip'). Every route also has a generous default. */
export const RateLimit = (name: string, limit: number, windowSeconds: number, by: LimitRule['by'] = 'user') =>
  SetMetadata(RATE_LIMIT, { name, limit, windowSeconds, by } satisfies LimitRule);

const DEFAULT_USER: LimitRule = { name: 'default', limit: 240, windowSeconds: 60, by: 'user' };
// Generous for public reads: many Indian mobile users share one carrier IP (CGNAT).
const DEFAULT_IP: LimitRule = { name: 'public', limit: 600, windowSeconds: 60, by: 'ip' };

/** Fixed-window counters in Redis, or in memory when Redis isn't configured or is down. */
@Injectable()
export class RateLimiter {
  private readonly memory = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly redis: RedisService) {}

  /** Counts one hit. Returns false when over the limit. */
  async hit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
    const full = `rl:${key}:${bucket}`;
    if (this.redis.client) {
      try {
        const k = this.redis.key(full);
        const n = await this.redis.client.incr(k);
        if (n === 1) await this.redis.client.expire(k, windowSeconds + 1);
        return n <= limit;
      } catch {
        // fall through to memory
      }
    }
    const now = Date.now();
    if (this.memory.size > 50_000) {
      for (const [k, v] of this.memory) if (v.resetAt < now) this.memory.delete(k);
    }
    const entry = this.memory.get(full);
    if (!entry || entry.resetAt < now) {
      this.memory.set(full, { count: 1, resetAt: now + windowSeconds * 1000 });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  }

  async check(key: string, limit: number, windowSeconds: number): Promise<void> {
    if (!(await this.hit(key, limit, windowSeconds))) {
      throw new AppError('TOO_MANY_REQUESTS', 'Too many tries. Please wait a minute and try again.', HttpStatus.TOO_MANY_REQUESTS, true);
    }
  }
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiter,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const specific = this.reflector.getAllAndOverride<LimitRule | undefined>(RATE_LIMIT, [ctx.getHandler(), ctx.getClass()]);
    const who = req.principal ? (req.principal.kind === 'admin' ? `a:${req.principal.adminId}` : `u:${req.principal.userId}`) : undefined;
    // The general limit counts per signed-in device (session), so a doctor's desk website and phone each have their
    // own budget and one can never block the other. Specific limits (payments, sign-in…) stay per person.
    const session = req.principal ? `${who}:${req.principal.sid}` : undefined;
    const rules = specific ? [specific] : [who ? DEFAULT_USER : DEFAULT_IP];
    for (const rule of rules) {
      const id = rule.by === 'user' && who ? (specific ? who : session!) : `ip:${clientIp(req) ?? 'unknown'}`;
      await this.limiter.check(`${rule.name}:${id}`, rule.limit, rule.windowSeconds);
    }
    return true;
  }
}
