import * as Sentry from '@sentry/node';

/**
 * Error reports to Sentry: on only when SENTRY_DSN is set (a free Sentry account gives one). Server errors
 * (5xx), failed background jobs and crashes are sent; never request bodies, tokens or personal details.
 */
let on = false;

export function initSentry(): void {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn || on) return;
  Sentry.init({
    dsn,
    environment: process.env.APP_ENV ?? 'local',
    release: process.env.RENDER_GIT_COMMIT,
    sendDefaultPii: false,
    tracesSampleRate: 0,
    beforeSend(event) {
      // Only the method and path of a request: no headers (tokens), cookies, query or body (patient data).
      if (event.request) event.request = { method: event.request.method, url: event.request.url?.split('?')[0] };
      delete event.user;
      return event;
    },
  });
  on = true;
}

export function captureError(err: unknown, context: Record<string, string | number | null | undefined> = {}): void {
  if (!on) return;
  Sentry.withScope((scope) => {
    for (const [k, v] of Object.entries(context)) if (v !== undefined && v !== null) scope.setTag(k, String(v));
    Sentry.captureException(err);
  });
}

/** Before the process exits: give queued reports up to 2 s to leave. */
export async function flushSentry(): Promise<void> {
  if (on) await Sentry.flush(2000).catch(() => undefined);
}
