import { createPrivateKey, sign as cryptoSign } from 'node:crypto';

import { Logger } from '@nestjs/common';

import type { Env } from '../../config/env';

/**
 * Messages that leave OPflow: phone pushes (FCM), emails (Resend) and SMS (MSG91). Each has a log-only
 * stand-in used locally when its keys are empty. Sending always happens from the worker (outbox), never
 * inside a request, so a slow provider can't slow the app down.
 */

export interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, string>;
}
export interface PushSender {
  /** Returns the tokens the provider says are dead (uninstalled app): the caller removes them. */
  send(tokens: string[], message: PushMessage): Promise<{ sent: number; deadTokens: string[] }>;
}
export interface EmailSender {
  send(to: string, subject: string, text: string): Promise<void>;
}
export interface SmsSender {
  /** Template SMS (India requires DLT-registered templates): variables fill the approved text. */
  send(toE164: string, variables: Record<string, string>, fallbackText: string): Promise<void>;
}

/** Patient login codes by SMS. */
export interface OtpSender {
  send(toE164: string, code: string): Promise<void>;
}

export const PUSH = Symbol('PUSH');
export const OTP_SENDER = Symbol('OTP_SENDER');
export const EMAIL = Symbol('EMAIL');
export const SMS = Symbol('SMS');

const log = new Logger('Messages');

/** Masks a phone/email for logs: +9198xxxxx210, ra***@gmail.com. */
export function maskContact(v: string): string {
  if (v.includes('@')) {
    const [name = '', domain = ''] = v.split('@');
    return `${name.slice(0, 2)}***@${domain}`;
  }
  return v.length > 7 ? `${v.slice(0, 5)}xxxxx${v.slice(-3)}` : 'xxxx';
}

// ── Log-only stand-ins (local) ────────────────────────────────────────────────────────────────────────

export class LogPush implements PushSender {
  readonly outbox: { tokens: string[]; message: PushMessage }[] = [];
  async send(tokens: string[], message: PushMessage) {
    this.outbox.push({ tokens, message });
    log.log(`[push → ${tokens.length} device(s)] ${message.title}: ${message.body}`);
    return { sent: tokens.length, deadTokens: [] };
  }
}

export class LogEmail implements EmailSender {
  readonly outbox: { to: string; subject: string; text: string }[] = [];
  async send(to: string, subject: string, text: string) {
    this.outbox.push({ to, subject, text });
    log.log(`[email → ${maskContact(to)}] ${subject}`);
  }
}

export class LogSms implements SmsSender {
  readonly outbox: { to: string; variables: Record<string, string>; text: string }[] = [];
  /** `reveal` only locally: the text may hold a one-time password and must never reach server logs. */
  constructor(private readonly reveal: boolean) {}
  async send(to: string, variables: Record<string, string>, text: string) {
    if (this.reveal) this.outbox.push({ to, variables, text });
    log.log(this.reveal ? `[sms → ${maskContact(to)}] ${text}` : `[sms → ${maskContact(to)}] not sent: SMS is not configured`);
  }
}

/** Local only: the login code is written to the server log instead of an SMS. */
export class LogOtp implements OtpSender {
  readonly sent: { to: string; code: string }[] = [];
  async send(to: string, code: string) {
    this.sent.push({ to, code });
    log.log(`[otp → ${maskContact(to)}] login code ${code} (not sent: the MSG91 OTP template is not set)`);
  }
}

// ── Firebase Cloud Messaging (HTTP v1) ───────────────────────────────────────────────────────────────

export class FcmPush implements PushSender {
  private token?: { value: string; exp: number };

  constructor(private readonly env: Env) {}

  private async accessToken(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: this.env.FIREBASE_CLIENT_EMAIL,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    })}`;
    const key = createPrivateKey(Buffer.from(this.env.FIREBASE_PRIVATE_KEY_B64!, 'base64').toString('utf8'));
    const assertion = `${unsigned}.${cryptoSign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`;
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`FCM auth failed: ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: body.access_token, exp: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  async send(tokens: string[], message: PushMessage) {
    const access = await this.accessToken();
    const deadTokens: string[] = [];
    let sent = 0;
    for (const token of tokens) {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${this.env.FIREBASE_PROJECT_ID}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: message.title, body: message.body },
            data: message.data ?? {},
            android: { priority: 'high', notification: { channel_id: 'opflow' } },
            apns: { payload: { aps: { sound: 'default' } } },
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) sent++;
      else if (res.status === 404 || res.status === 400) {
        const text = await res.text();
        if (/UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT/.test(text)) deadTokens.push(token);
      } else if (res.status >= 500 || res.status === 429) {
        throw new Error(`FCM ${res.status}`); // retried by the outbox
      }
    }
    return { sent, deadTokens };
  }
}

// ── Resend ───────────────────────────────────────────────────────────────────────────────────────────

export class ResendEmail implements EmailSender {
  constructor(private readonly env: Env) {}

  async send(to: string, subject: string, text: string) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.env.EMAIL_FROM, to: [to], subject, text, reply_to: this.env.EMAIL_REPLY_TO }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

// ── MSG91 OTP (our own code, sent with the DLT-approved OTP template; we check it ourselves) ────────────

export class Msg91Otp implements OtpSender {
  constructor(private readonly env: Env) {}

  async send(to: string, code: string) {
    const url = new URL('https://control.msg91.com/api/v5/otp');
    url.searchParams.set('template_id', this.env.MSG91_OTP_TEMPLATE_ID!);
    url.searchParams.set('mobile', to.replace(/^\+/, ''));
    url.searchParams.set('otp', code);
    url.searchParams.set('otp_expiry', '5');
    const res = await fetch(url, {
      method: 'POST',
      headers: { authkey: this.env.MSG91_AUTH_KEY!, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(10_000),
    });
    // MSG91 answers 200 with {"type":"error"} for most problems (bad template, no balance…).
    const body = (await res.json().catch(() => ({}))) as { type?: string; message?: string };
    if (!res.ok || body.type !== 'success') throw new Error(`MSG91 OTP ${res.status}: ${String(body.message ?? 'failed').slice(0, 200)}`);
  }
}

// ── MSG91 (Flow API with a DLT template) ─────────────────────────────────────────────────────────────

export class Msg91Sms implements SmsSender {
  constructor(private readonly env: Env) {}

  async send(to: string, variables: Record<string, string>) {
    const res = await fetch('https://control.msg91.com/api/v5/flow', {
      method: 'POST',
      headers: { authkey: this.env.MSG91_AUTH_KEY!, 'content-type': 'application/json' },
      body: JSON.stringify({
        template_id: this.env.MSG91_SMS_TEMPLATE_ID,
        short_url: '0',
        recipients: [{ mobiles: to.replace(/^\+/, ''), ...variables }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`MSG91 ${res.status}`);
  }
}
