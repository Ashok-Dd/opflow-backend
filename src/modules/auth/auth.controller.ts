import { Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { Meta, Public, RequestMeta } from '../../common/auth/auth.decorators';
import { ZBody } from '../../common/http/zod';
import { RateLimit } from '../../infra/redis/rate-limit';
import { AuthService } from './auth.service';
import { TokensService } from './tokens.service';

export const zDevice = z
  .object({
    platform: z.enum(['android', 'ios', 'web']),
    fcmToken: z.string().min(10).max(4096).optional(),
    // A random id kept by the app / browser for as long as it is installed: "the same device" for sign-in places.
    installId: z.string().regex(/^[A-Za-z0-9-]{16,64}$/).optional(),
    appVersion: z.string().max(20).optional(),
    locale: z.string().max(10).optional(),
  })
  .optional();

const exchangeBody = z.object({ idToken: z.string().min(10).max(5000), device: zDevice });
const zIndianMobile = z.string().trim().regex(/^\+91[6-9]\d{9}$/, 'must be an Indian mobile number like +919876543210');
const otpSendBody = z.object({ phone: zIndianMobile });
const otpVerifyBody = z.object({ phone: zIndianMobile, code: z.string().regex(/^\d{6}$/, 'must be the 6-digit code'), device: zDevice });
const doctorLoginBody = z.object({
  loginId: z.string().trim().regex(/^OPD-\d{4,8}$/i, 'must look like OPD-10234'),
  password: z.string().min(1).max(128),
  device: zDevice,
});
const setPasswordBody = z.object({ changeToken: z.string().min(10).max(2000), newPassword: z.string().min(1).max(128), device: zDevice });
const refreshBody = z.object({ refreshToken: z.string().min(20).max(200) });

@ApiTags('auth')
@Public()
@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokensService,
  ) {}

  /** Patient login step 1: send a code by SMS. Answers { mode } so the app knows how this server logs in. */
  @Post('patient/otp')
  @HttpCode(200)
  @RateLimit('otp-send', 10, 600, 'ip')
  sendOtp(@ZBody(otpSendBody) body: z.output<typeof otpSendBody>, @Meta() meta: RequestMeta) {
    return this.auth.sendPatientOtp(body.phone, meta);
  }

  /** Patient login step 2: the code from the SMS → an OPflow session (the account is made on first login). */
  @Post('patient/otp/verify')
  @HttpCode(200)
  @RateLimit('otp-verify', 30, 600, 'ip')
  verifyOtp(@ZBody(otpVerifyBody) body: z.output<typeof otpVerifyBody>, @Meta() meta: RequestMeta) {
    return this.auth.verifyPatientOtp(body.phone, body.code, body.device, meta);
  }

  /** Patient: swap a Firebase phone-login token (after the OTP) for an OPflow session. */
  @Post('patient/exchange')
  @HttpCode(200)
  @RateLimit('otp-exchange', 20, 60, 'ip')
  exchange(@ZBody(exchangeBody) body: z.output<typeof exchangeBody>, @Meta() meta: RequestMeta) {
    return this.auth.patientExchange(body.idToken, body.device, meta);
  }

  /** Doctor: login ID (OPD-…) + password. First login returns { mustChange, changeToken }. */
  @Post('doctor/login')
  @HttpCode(200)
  @RateLimit('doctor-login', 10, 60, 'ip')
  doctorLogin(@ZBody(doctorLoginBody) body: z.output<typeof doctorLoginBody>, @Meta() meta: RequestMeta) {
    return this.auth.doctorLogin(body.loginId, body.password, body.device, meta);
  }

  /** Doctor: set their own password after the first login. */
  @Post('doctor/set-password')
  @HttpCode(200)
  @RateLimit('doctor-set-password', 10, 60, 'ip')
  setPassword(@ZBody(setPasswordBody) body: z.output<typeof setPasswordBody>, @Meta() meta: RequestMeta) {
    return this.auth.doctorSetPassword(body.changeToken, body.newPassword, body.device, meta);
  }

  /** New token pair. Each refresh token works once. */
  @Post('refresh')
  @HttpCode(200)
  @RateLimit('refresh', 30, 60, 'ip')
  refresh(@ZBody(refreshBody) body: z.output<typeof refreshBody>, @Meta() meta: RequestMeta) {
    return this.tokens.rotate(body.refreshToken, 'app', meta);
  }

  /** Log out this phone (ends this session). */
  @Post('logout')
  @HttpCode(200)
  async logout(@ZBody(refreshBody) body: z.output<typeof refreshBody>) {
    await this.tokens.revokeByToken(body.refreshToken);
    return { ok: true };
  }
}
