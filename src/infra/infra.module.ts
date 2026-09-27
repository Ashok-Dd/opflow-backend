import { Global, Logger, Module } from '@nestjs/common';

import { JwtService } from '../common/auth/jwt.service';
import { allowsStandIns, ENV, Env, isLocal, phoneLogin } from '../config/env';
import { LiveBus } from './bus/live-bus';
import { ClosedPhoneVerifier, DevPhoneVerifier, FirebasePhoneVerifier, PHONE_VERIFIER, PhoneVerifier } from './firebase/phone-verifier';
import { EMAIL, EmailSender, FcmPush, LogEmail, LogOtp, LogPush, LogSms, Msg91Otp, Msg91Sms, OTP_SENDER, OtpSender, PUSH, PushSender, ResendEmail, SMS } from './messaging/messaging';
import { CashfreeGateway, FakeCashfreeGateway, PAYMENT_GATEWAY, PaymentGateway } from './payments/gateway';
import { CashfreePayouts, FakePayouts, PAYOUTS, PayoutsProvider } from './payments/payouts';
import { RateLimiter } from './redis/rate-limit';
import { RedisService } from './redis/redis.service';
import { RulesService } from './rules/rules.service';
import { LocalStorage, S3Storage, Storage, STORAGE } from './storage/storage';

const log = new Logger('Providers');

/** Picks the real provider when its keys are set; otherwise the local stand-in (allowed on APP_ENV=local only). */
function pick<T>(name: string, configured: boolean, env: Env, real: () => T, standIn: () => T): T {
  if (configured) return real();
  if (!allowsStandIns(env)) throw new Error(`${name} is not configured (required outside local development)`);
  log.warn(`${name}: not configured, using the local stand-in`);
  return standIn();
}

/** Shared services every module can use: Redis, rules, tokens, and the outside providers. */
@Global()
@Module({
  providers: [
    RedisService,
    RateLimiter,
    LiveBus,
    RulesService,
    JwtService,
    {
      provide: PAYMENT_GATEWAY,
      inject: [ENV],
      useFactory: (env: Env): PaymentGateway =>
        pick<PaymentGateway>('Cashfree Payment Gateway', !!(env.CASHFREE_CLIENT_ID && env.CASHFREE_CLIENT_SECRET), env,
          () => new CashfreeGateway(env), () => new FakeCashfreeGateway()),
    },
    {
      provide: PAYOUTS,
      inject: [ENV],
      useFactory: (env: Env): PayoutsProvider =>
        pick<PayoutsProvider>('Cashfree Payouts', !!(env.CASHFREE_PAYOUT_CLIENT_ID && env.CASHFREE_PAYOUT_CLIENT_SECRET && env.CASHFREE_PAYOUT_PUBLIC_KEY_B64), env,
          () => new CashfreePayouts(env), () => new FakePayouts()),
    },
    {
      provide: STORAGE,
      inject: [ENV],
      useFactory: (env: Env) =>
        env.STORAGE_PROVIDER === 'local'
          ? pick<Storage>('Storage', false, env, () => new LocalStorage(env), () => new LocalStorage(env))
          : pick<Storage>('Storage (R2)', !!(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY), env, () => new S3Storage(env), () => new LocalStorage(env)),
    },
    {
      provide: PHONE_VERIFIER,
      inject: [ENV],
      useFactory: (env: Env): PhoneVerifier => {
        const mode = phoneLogin(env);
        if (mode === 'sms') return new ClosedPhoneVerifier();
        if (mode === 'firebase') return new FirebasePhoneVerifier(env);
        log.warn('Patient login: demo code (no SMS is sent)');
        return new DevPhoneVerifier(isLocal(env) ? null : (env.DEMO_OTP_CODE ?? null));
      },
    },
    {
      provide: OTP_SENDER,
      inject: [ENV],
      useFactory: (env: Env): OtpSender =>
        env.MSG91_AUTH_KEY && env.MSG91_OTP_TEMPLATE_ID
          ? new Msg91Otp(env)
          : pick<OtpSender>('Login codes by SMS (MSG91 OTP)', false, env, () => new LogOtp(), () => new LogOtp()),
    },
    {
      provide: PUSH,
      inject: [ENV],
      useFactory: (env: Env) =>
        pick<PushSender>('Push (FCM)', !!(env.FIREBASE_PROJECT_ID && env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY_B64), env,
          () => new FcmPush(env), () => new LogPush()),
    },
    {
      provide: EMAIL,
      inject: [ENV],
      useFactory: (env: Env) => pick<EmailSender>('Email (Resend)', !!env.RESEND_API_KEY, env, () => new ResendEmail(env), () => new LogEmail()),
    },
    {
      provide: SMS,
      inject: [ENV],
      // SMS is optional everywhere for now: without MSG91 the doctor's password is given by the admin in person.
      useFactory: (env: Env) => (env.MSG91_AUTH_KEY && env.MSG91_SMS_TEMPLATE_ID ? new Msg91Sms(env) : new LogSms(isLocal(env))),
    },
  ],
  exports: [RedisService, RateLimiter, LiveBus, RulesService, JwtService, PAYMENT_GATEWAY, PAYOUTS, STORAGE, PHONE_VERIFIER, OTP_SENDER, PUSH, EMAIL, SMS],
})
export class InfraModule {}
