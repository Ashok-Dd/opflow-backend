# OPflow backend

NestJS API + worker for the OPflow app and the admin site. Design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
Database: Supabase Postgres (Mumbai), schema in [`migrations/`](migrations/README.md). Admin plan: [`../admin/docs/ADMIN_PORTAL.md`](../admin/docs/ADMIN_PORTAL.md).

## What's here (B1–B10 built)

| Area | Endpoints (full list with request/response shapes: `GET /docs` locally) |
|---|---|
| Health | `GET /health` · `GET /ready` |
| Catalog (public) | `GET /v1/catalog` — types of doctor, problems, emergencies + published first aid, rules, kill switches, app versions |
| Directory (public) | `GET /v1/doctors?type=&problem=&who=&hospital=&q=&lang=&day=&near=lat,lng&sort=` · `GET /v1/doctors/:id` (with weekly timings) · `GET /v1/doctors/:id/days` · `GET /v1/doctors/:id/windows?date=` · `GET /v1/hospitals` · `GET /v1/hospitals/:id` |
| Auth | `POST /v1/auth/patient/exchange` (Firebase phone token) · `POST /v1/auth/doctor/login` · `POST /v1/auth/doctor/set-password` · `POST /v1/auth/refresh` · `POST /v1/auth/logout` |
| Patient | `GET/PATCH/DELETE /v1/me` · `GET/PATCH /v1/me/notification-prefs` · `POST /v1/me/devices` · `GET /v1/notifications` · `POST /v1/notifications/read` · `POST /v1/support/tickets` |
| Bookings | `POST /v1/bookings/hold` · `POST /v1/bookings/emergency` · `GET /v1/bookings?tab=` · `GET /v1/bookings/:id` · `…/timeline` · `…/reschedule` · `…/receipt` |
| Payments | `POST /v1/payments/verify` · `POST /v1/payments/:bookingId/retry` · `POST /v1/webhooks/cashfree` · `POST /v1/webhooks/cashfree-payouts` |
| Live line | `GET /v1/live/sessions/:id` (patient board) · WebSocket namespace `/live` (`join {sessionId}` → `board` / `line` events) |
| Doctor | `GET/PATCH /v1/doctor/me` · photo upload · `bookings-pause` · `today` · `bookings` · cancel / move one booking · cancel a whole day · `schedule` · `leaves` · `emergency` · `earnings` · `reports` · `password` · console: `POST /v1/doctor/sessions/:id/{start,pause,resume,late,end,call-next,done,did-not-come,skip,call-now,mark-reached,put-back}` |
| Emergency (public) | `GET /v1/emergency/near?kind=&lat=&lng=` · `GET /v1/emergency/first-aid[/:kind]` |
| Admin | `/v1/admin/*` (exactly one admin): sign-in (password + authenticator, step-up), dashboard, needs attention, doctors (the only way a doctor is added; verify/suspend apply at once), hospitals, bookings, refunds, payouts, reconciliation, CSV exports, patients (masked + logged reveal), live OPDs, emergency, first aid + catalog, support, rules + kill switches, audit |

**A doctor account works on at most 2 devices** (`doctor.max_devices`): a third sign-in signs out the device used
least recently (the doctor is told), and a signed-out phone stops at once. Doctors see and sign out devices with
`GET /v1/doctor/devices` · `POST /v1/doctor/devices/:id/sign-out`.

**Money rules in code and database:** the patient pays fee (+ 20% emergency charge for emergency consultations);
the doctor gets exactly 90% of the fee (database-checked), released 24 h after the OPD; no patient cancel, one free
change up to 2 h before; a doctor/OPflow cancel is always a 100% refund.

## Run it locally

```bash
cd backend
npm install
npm run start:dev        # http://localhost:3000/docs · background jobs run inside the API locally
```

With only `DATABASE_URL` set, everything works: outside services are replaced by **local stand-ins** (refused
on staging/production):

| Service | Local stand-in |
|---|---|
| Firebase phone login | send `idToken: "dev:+919876543210"` to `/v1/auth/patient/exchange` |
| Cashfree | fake gateway: after `hold`, call `POST /v1/dev/cashfree/pay {orderId}` (the checkout page), then `POST /v1/payments/verify {orderId}`. Doctor payouts use a fake Payouts too |
| R2 file storage | files in `backend/.uploads`, served by `/v1/dev/files/…` |
| FCM / Resend / MSG91 | printed to the log |
| Redis | in-process rate limits and live signals (fine for one API machine) |

Useful commands:

```bash
npm run seed:demo                        # the app's 5 hospitals + 10 doctors; demo doctor OPD-10234 / demo1234
npm run seed:demo -- --remove            # hide the demo data again (never seed production)
npm run admin:create -- --email you@opflow.in --name "Your Name"   # THE admin (only one) → setup link
                                         # same email again = new setup link · --replace = hand over to someone else
npm run keys:generate                    # secrets for staging/production (paste into the host's secrets)
npm run worker                           # the worker as its own process (after npm run build)
```

## Tests

```bash
npm test          # unit tests (no database)
npm run test:db   # 7 checks against the database in .env (Supabase): RLS, admin-only doctors, pgcrypto, routes
FLOW_DATABASE_URL=postgres://opflow_api:<pw>@localhost:5432/<throwaway db> npm run test:flow
                  # 26 end-to-end journeys (never point this at Supabase: it writes a lot of data)
npm run typecheck
```

`test:flow` covers: admin setup + TOTP, adding and verifying a doctor (two admins), doctor first login, timings,
search, hold → pay → confirm, idempotent retries, 6 people racing for 4 places, reschedule rules, webhooks,
late payment, Cashfree down, pause bookings, emergency consultation money split, live line over WebSocket and
polling, doctor cancel + refund, cancel a whole day, admin refunds/reveal/kill switch, first-aid publishing
rules, refresh-token reuse, old-app upgrade, suspension, and the nightly consistency checks. CI runs all of it.

## After changing the database

```bash
# 1. add a new file in migrations/, test it on a throwaway Postgres, apply it with dbmate (migrations/README.md)
# 2. refresh the TypeScript types:
DATABASE_URL="<opflow_api url with ?sslmode=no-verify>" npm run db:types
```

## How the code is laid out

```
src/
├─ main.ts / worker.ts        two processes, one codebase (API + WebSocket / background jobs)
├─ app.module.ts              modules, global guards (auth → rate limit → app version), idempotency, error filter
├─ config/env.ts              every environment variable, checked with zod at startup
├─ common/                    auth (EdDSA JWT, guard, decorators), errors, zod validation, idempotency,
│                             outbox + audit helpers, India time, money, crypto (TOTP, codes)
├─ infra/                     db (DbService.as / system / sys), redis (optional), rate limits, live bus,
│                             rules (app_config), payments gateway, storage (S3/R2 or local), messaging, Firebase
└─ modules/
   ├─ catalog, directory      public reads
   ├─ auth, me                logins and the patient's own account
   ├─ schedule                weekly timings → sessions, hours and places
   ├─ bookings, payments      hold, confirm (one shared path), reschedule, cancel, refunds, payouts, webhooks
   ├─ live                    console commands, boards, WebSocket gateway
   ├─ doctor, emergency       doctor app, emergency help
   ├─ admin                   admin sign-in, approvals, doctors, operations
   ├─ jobs                    outbox relay + timed jobs (leases in job_leases, no Redis needed)
   └─ dev                     local-only stand-ins (fake Checkout, local files, run a job now)
```

**Rule for every query on personal data:** run it inside `dbs.as({ role, … }, tx => …)` (or `dbs.system` for
server work). Tables with row-level security (bookings, queue entries, profiles, notifications) show **no rows**
to a query without a role, by design.

## Deploy

**Now: Render** (test server in demo mode) — step by step in [`docs/DEPLOY_RENDER.md`](docs/DEPLOY_RENDER.md), blueprint in
`../render.yaml`, secrets generated in `backend/.env.render` (never committed). Later/alternative: Fly.io below.

`Dockerfile` builds one image. `fly.toml` runs it in Mumbai as two process groups: `api` (health-checked on `/ready`)
and `worker`. Set secrets with `fly secrets set …` (everything marked `[required]`/`[prod]` in `.env.example`).
CI (`.github/workflows/backend.yml`) type-checks, unit-tests, builds, applies every migration to a throwaway Postgres
and runs the end-to-end journeys on every push.
