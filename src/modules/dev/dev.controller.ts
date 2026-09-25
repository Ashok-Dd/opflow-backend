import { Controller, Get, HttpCode, HttpStatus, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { Public } from '../../common/auth/auth.decorators';
import { hmacHex } from '../../common/crypto';
import { AppError } from '../../common/errors/app-error';
import { ZBody } from '../../common/http/zod';
import { allowsStandIns, ENV, Env, isLocal } from '../../config/env';
import { FAKE_WEBHOOK_SECRET, FakeRazorpayGateway, PAYMENT_GATEWAY, PaymentGateway } from '../../infra/payments/gateway';
import { Bucket, LocalStorage, STORAGE, Storage } from '../../infra/storage/storage';
import { JobsService } from '../jobs/jobs.service';

/**
 * LOCAL DEVELOPMENT ONLY (registered only when APP_ENV=local, and every handler checks again):
 * stand-ins for Razorpay Checkout and for file storage, and a way to run background jobs on demand.
 */
@ApiExcludeController()
@Public()
@Controller('v1/dev')
export class DevController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
    @Inject(STORAGE) private readonly storage: Storage,
    private readonly jobs: JobsService,
  ) {}

  /** Everything here is local-only, except what a staging demo needs (`demo: true`): the stand-in Checkout and
   *  signed file links. Running jobs on demand and signing webhooks stay local-only. */
  private guard(demo = false): void {
    if (isLocal(this.env) || (demo && allowsStandIns(this.env))) return;
    throw new AppError('NOT_FOUND', 'Not found.', HttpStatus.NOT_FOUND);
  }

  /** What Razorpay Checkout would return to the app. */
  @Post('razorpay/pay')
  @HttpCode(200)
  pay(@ZBody(z.object({ orderId: z.string(), fail: z.boolean().optional() })) b: { orderId: string; fail?: boolean }) {
    this.guard(true);
    if (!(this.gateway instanceof FakeRazorpayGateway)) throw new AppError('NOT_FAKE', 'Real Razorpay keys are set; use real Checkout.', HttpStatus.CONFLICT);
    return this.gateway.pay(b.orderId, { fail: b.fail });
  }

  /** Signs a webhook body the way Razorpay would (to test /v1/webhooks/razorpay locally). */
  @Post('razorpay/sign')
  @HttpCode(200)
  sign(@Req() req: Request & { rawBody?: Buffer }) {
    this.guard();
    return { signature: hmacHex(FAKE_WEBHOOK_SECRET, req.rawBody ?? Buffer.from('')) };
  }

  /** Test hook: the next Razorpay order fails ("payments are down"). */
  @Post('razorpay/fail-next-order')
  @HttpCode(200)
  failNext() {
    this.guard();
    if (this.gateway instanceof FakeRazorpayGateway) this.gateway.failNextOrder = true;
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
