import { Controller, Get, Headers, HttpCode, HttpStatus, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { Public } from '../../common/auth/auth.decorators';
import { AppError } from '../../common/errors/app-error';
import { ZBody } from '../../common/http/zod';
import { allowsStandIns, ENV, Env, isLocal } from '../../config/env';
import { FAKE_WEBHOOK_SECRET, FakeCashfreeGateway, PAYMENT_GATEWAY, PaymentGateway, webhookSignature } from '../../infra/payments/gateway';
import { FAKE_PAYOUT_WEBHOOK_SECRET, FakePayouts, PAYOUTS, PayoutsProvider } from '../../infra/payments/payouts';
import { Bucket, LocalStorage, STORAGE, Storage } from '../../infra/storage/storage';
import { JobsService } from '../jobs/jobs.service';

/**
 * LOCAL DEVELOPMENT ONLY (registered only when APP_ENV=local, and every handler checks again):
 * stand-ins for the Cashfree checkout page and for file storage, and a way to run background jobs on demand.
 */
@ApiExcludeController()
@Public()
@Controller('v1/dev')
export class DevController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(PAYOUTS) private readonly payouts: PayoutsProvider,
    @Inject(STORAGE) private readonly storage: Storage,
    private readonly jobs: JobsService,
  ) {}

  /** Everything here is local-only, except what a staging demo needs (`demo: true`): the stand-in Checkout and
   *  signed file links. Running jobs on demand and signing webhooks stay local-only. */
  private guard(demo = false): void {
    if (isLocal(this.env) || (demo && allowsStandIns(this.env))) return;
    throw new AppError('NOT_FOUND', 'Not found.', HttpStatus.NOT_FOUND);
  }

  /** What paying on the Cashfree checkout page does (success, or a failed attempt). The app then asks the server. */
  @Post('cashfree/pay')
  @HttpCode(200)
  pay(@ZBody(z.object({ orderId: z.string(), fail: z.boolean().optional() })) b: { orderId: string; fail?: boolean }) {
    this.guard(true);
    if (!(this.gateway instanceof FakeCashfreeGateway)) throw new AppError('NOT_FAKE', 'Real Cashfree keys are set; use the real checkout.', HttpStatus.CONFLICT);
    return this.gateway.pay(b.orderId, { fail: b.fail });
  }

  /** Signs a webhook body the way Cashfree would (to test /v1/webhooks/cashfree and …/cashfree-payouts locally). */
  @Post('cashfree/sign')
  @HttpCode(200)
  sign(@Req() req: Request & { rawBody?: Buffer }, @Query('for') target: string, @Headers('x-webhook-timestamp') ts?: string) {
    this.guard();
    const timestamp = ts ?? String(Date.now());
    const secret = target === 'payouts' ? FAKE_PAYOUT_WEBHOOK_SECRET : FAKE_WEBHOOK_SECRET;
    return { timestamp, signature: webhookSignature(secret, timestamp, req.rawBody ?? Buffer.from('')) };
  }

  /** Test hook: the next Cashfree order fails ("payments are down"). */
  @Post('cashfree/fail-next-order')
  @HttpCode(200)
  failNext() {
    this.guard();
    if (this.gateway instanceof FakeCashfreeGateway) this.gateway.failNextOrder = true;
    return { ok: true };
  }

  /** Test hooks for doctor payouts: the next bank payout fails, or payouts stay "pending" (settled by webhook). */
  @Post('payouts/:mode')
  @HttpCode(200)
  payoutMode(@Param('mode') mode: string) {
    this.guard();
    if (!(this.payouts instanceof FakePayouts)) throw new AppError('NOT_FAKE', 'Real Cashfree Payouts keys are set.', HttpStatus.CONFLICT);
    if (mode === 'fail-next') this.payouts.failNext = true;
    else if (mode === 'hold') this.payouts.holdTransfers = true;
    else if (mode === 'normal') this.payouts.holdTransfers = false;
    else throw new AppError('NOT_FOUND', 'Unknown mode.', HttpStatus.NOT_FOUND);
    return { ok: true };
  }

  /** Runs one background job now (outbox relay, hold expiry, auto sessions…). */
  @Post('jobs/:name')
  @HttpCode(200)
  async job(@Param('name') name: string) {
    this.guard();
    const jobs: Record<string, () => Promise<unknown>> = {
      relay: () => this.jobs.relay(),
      'sessions.generate': () => this.jobs['schedule'].syncAll(),
      'holds.expire': () => this.jobs['payments'].expireHolds(),
      'payouts.release': () => this.jobs['payments'].releaseDueTransfers(),
      'payouts.sync': () => this.jobs['payments'].syncPendingPayouts(),
      'sessions.auto': () => this.jobs.autoSessions(),
      invariants: () => this.jobs.invariants(),
      housekeeping: () => this.jobs.housekeeping(),
    };
    const fn = jobs[name];
    if (!fn) throw new AppError('NOT_FOUND', 'Unknown job.', HttpStatus.NOT_FOUND);
    return { name, result: await fn() };
  }

  /** Local "presigned" upload. */
  @Put('files/:bucket/*key')
  @HttpCode(200)
  async upload(@Param('bucket') bucket: string, @Param('key') key: string | string[], @Query('exp') exp: string, @Query('sig') sig: string, @Req() req: Request & { rawBody?: Buffer }) {
    this.guard(true);
    const k = Array.isArray(key) ? key.join('/') : key;
    const s = this.local();
    if (!['public', 'private'].includes(bucket) || !s.verify('PUT', bucket as Bucket, k, Number(exp), String(sig))) {
      throw new AppError('FORBIDDEN', 'This upload link is not valid.', HttpStatus.FORBIDDEN);
    }
    const body = req.rawBody ?? (await readBody(req));
    if (body.length > this.env.UPLOAD_MAX_BYTES * 2) throw new AppError('TOO_BIG', 'The file is too big.', HttpStatus.PAYLOAD_TOO_LARGE);
    await s.put(bucket as Bucket, k, body);
    return { ok: true, bytes: body.length };
  }

  /** Local file download: public files openly, private ones with a signed link. */
  @Get('files/:bucket/*key')
  async download(@Param('bucket') bucket: string, @Param('key') key: string | string[], @Query('exp') exp: string, @Query('sig') sig: string, @Res() res: Response) {
    this.guard(true);
    const k = Array.isArray(key) ? key.join('/') : key;
    const s = this.local();
    if (bucket !== 'public' && !(bucket === 'private' && s.verify('GET', 'private', k, Number(exp), String(sig)))) {
      throw new AppError('FORBIDDEN', 'This link is not valid.', HttpStatus.FORBIDDEN);
    }
    const data = await s.get(bucket as Bucket, k);
    res.setHeader('Content-Type', k.endsWith('.webp') ? 'image/webp' : k.endsWith('.pdf') ? 'application/pdf' : k.endsWith('.png') ? 'image/png' : 'image/jpeg');
    // Public photos show on the doctor website and the admin site (other origins), like a CDN would allow.
    if (bucket === 'public') res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.send(data);
  }

  private local(): LocalStorage {
    if (!(this.storage instanceof LocalStorage)) throw new AppError('NOT_LOCAL', 'Real storage is configured.', HttpStatus.CONFLICT);
    return this.storage;
  }
}

function readBody(req: Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
