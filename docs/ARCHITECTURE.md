# OPflow Backend — Architecture & Build Plan

> Scope: the API, database, real-time line, payments, notifications and jobs behind the Flutter app
> (`app/`) and the future admin site. The landing site (`web/`) stays static.
> Status: plan. Nothing here is built yet.

---

## 0. What the backend must guarantee

These come from the product rules and from the app we already built. Every design choice below serves one of them.

| # | Guarantee | Why it matters |
|---|---|---|
| G1 | **Never overbook an hour.** Two patients paying for the last place at the same second: exactly one gets it. | The whole product is "come at your time". |
| G2 | **A booking exists only after payment is verified by the server.** | No free bookings, no "paid but no booking". |
| G3 | **Money rules are enforced by the server, not the app.** No patient cancel. One free change, up to 2 hours before. Doctor cancel = 100% money back. OPflow keeps 10% of each fee. | The app can be modified; the server cannot. |
| G4 | **The live line updates on every phone within about 1 second** of the doctor tapping CALL NEXT, and survives bad hospital Wi-Fi. | This is the feature patients open the app for. |
| G5 | **A patient sees only their own data; a doctor sees only their own sessions.** Every query is scoped. | Health data, DPDP Act. |
| G6 | **Screens feel instant.** p95 read under 200 ms from India; cached lists; no spinner longer than the OP loader already shows. | "Cool and smooth". |
| G7 | **Every money movement and every status change is recorded** (who, when, why). | Disputes, refunds, audits. |
| G8 | **No money is ever lost or double-counted.** Every rupee captured ends as exactly one of: confirmed booking, refund, or duplicate-refund, and this is checked every night. | Trust with patients and doctors. |
| G9 | **One failing dependency never takes the whole app down.** Redis, Razorpay, Firebase or push down: the rest keeps working, and the failing feature says so in plain words. | Hospitals run all day; outages happen. |
| G10 | **Old app versions keep working** until we force an update, and we can force one. | People do not update apps. |

**Principles used everywhere below**

1. **Postgres is the only source of truth.** Redis is a cache, a messenger and a speed-up. If Redis is wiped, nothing is lost.
2. **Every state change is a guarded transition:** `UPDATE … SET status = 'b' WHERE id = $1 AND status = 'a'`. Zero rows updated means someone else got there first, so we stop and re-read. No read-modify-write races.
3. **Every write the app can repeat is idempotent** (Idempotency-Key or a natural unique key), so retries after bad network are always safe.
4. **Side effects go out after commit** (transactional outbox). Nothing is sent for a change that was rolled back.
5. **Every external call has a timeout, a retry policy and a circuit breaker.** Never wait forever on Razorpay, Firebase or FCM.
6. **Time comes from the database clock** (`now()`), never from the phone. Rules like "2 hours before" are checked on the server.

---

## 1. System overview

```
                        ┌──────────────── Flutter app (patient + doctor) ───────────────┐
                        │  Dio REST client · WebSocket (live line) · FCM push · Razorpay │
                        └───────────────┬───────────────────────────┬───────────────────┘
                                        │ HTTPS /v1                 │ WSS /live
┌─────────────── Admin site (Next.js) ──┤                           │
│ doctors, hospitals, refunds, content  │                           │
└───────────────────────────────────────┤                           │
                                        ▼                           ▼
                        ┌────────────────────── api (NestJS) ──────────────────────┐
                        │ REST controllers · WS gateway · auth guards · validation │
                        │ modules: auth, users, catalog, doctors, schedule,        │
                        │ availability, bookings, payments, queue, emergency,      │
                        │ notifications, content, earnings, support, admin, audit  │
                        └──────┬───────────────┬──────────────────┬────────────────┘
                               │ SQL           │ cache/pubsub/locks│ jobs (BullMQ)
                               ▼               ▼                  ▼
                        ┌────────────┐  ┌──────────────┐  ┌──────────────────────────┐
                        │ PostgreSQL │  │ Redis        │  │ worker (same codebase)   │
                        │ + earthdist│  │ (Upstash)    │  │ session generator, hold   │
                        │ + pg_trgm  │  │              │  │ expiry, reminders, pushes,│
                        └────────────┘  └──────────────┘  │ payouts, outbox relay     │
                                                          └──────────┬───────────────┘
                 External: Firebase (phone OTP + FCM push) · Razorpay (orders, Route,   │
                 refunds, webhooks) · Resend (email) · Cloudflare R2 (photos) ◄─────────┘
```

**Style: a modular monolith.** One NestJS codebase, two processes (`api` and `worker`), clear module boundaries.
Microservices would add network hops, deployments and failure modes that a pilot with 1–50 doctors does not need.
A module can be split out later if one outgrows the rest (the live line is the likeliest).

### Stack (decided)

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Node.js 22 LTS, **NestJS 11**, TypeScript strict | Already chosen for OPflow. |
| DB | **Supabase Postgres** (decided), region **Mumbai (ap-south-1)**, with pg_trgm, citext, btree_gist, earthdistance | Used only as Postgres: its REST API and Auth are switched off and locked out (migration …001500). The API logs in as `opflow_api` (no RLS bypass) through the transaction pooler. Health data stays in India. All env vars are in `backend/.env.example`. |
| Migrations | **Plain SQL files in `backend/migrations/`, run by dbmate** (up + down per file) | The schema relies on exclusion constraints, partial unique indexes, state-machine triggers and row-level security, which ORM migration generators don't express well. All 14 files are tested: 21 rule checks, a 40-buyer race for 8 places, and a full rollback and re-apply. |
| Queries | **Kysely** (typed SQL query builder) with types generated from the live schema (`npm run db:types`, kysely-codegen) | Our schema leans on raw-SQL features (RLS identity per transaction, `SKIP LOCKED`, triggers), which Kysely expresses directly with no extra engine. `DbService.as(identity, fn)` runs every personal-data query as a specific patient/doctor/admin so row-level security applies. |
| Cache, locks, pub/sub, rate limits, jobs | **Redis** (Upstash, Mumbai) + **BullMQ** | One Redis for everything at pilot scale. |
| Real time | **Socket.IO** gateway with the Redis adapter | Works across several API instances. Rooms are per OPD session. |
| Push | **Firebase Cloud Messaging** | Android and iOS, including when the app is closed. |
| Patient login | **Firebase Phone Auth**, exchanged for OPflow tokens | No DLT paperwork for the pilot. Swap to MSG91 later by changing one service. |
| Payments | **Razorpay**: Orders, Checkout (`razorpay_flutter`), webhooks, Refunds, **Route** (split to doctor) | Implements the 90/10 split per booking. |
| Email | **Resend** | Receipts, doctor onboarding, admin alerts. |
| Files | **Cloudflare R2** (S3 API) behind a CDN, with presigned uploads | Doctor photos and verification documents (documents are private). |
| Hosting | **Fly.io, Mumbai region (`bom`)**: `api` ×2, `worker` ×1 | Or AWS ECS/App Runner in ap-south-1. Both run the same Docker image. |
| Observability | Pino JSON logs, **Sentry** (API + Flutter), OpenTelemetry traces, `/health` checks | |
| CI/CD | GitHub Actions: lint → unit → e2e (Testcontainers Postgres + Redis) → migrate → deploy | |

---

## 2. Core concepts (the language of the code)

| Concept | Meaning | Example |
|---|---|---|
| **Doctor type** | What the app calls "Type of doctor" | `child` = Child doctor (Pediatrics) |
| **Hospital** | A place where OPD happens | Sri Lakshmi Hospital |
| **Schedule template** | The doctor's weekly plan per hospital | Mon–Sat 9–13, 8 online per hour, 10 direct places |
| **OPD session** | One real OPD on one date, created from the template | Dr. Rao · Sri Lakshmi · 24 Sep · 9 AM–1 PM |
| **Window** | One hour inside a session with a capacity | 10–11 AM, capacity 8 (6 booked, 1 held, 1 free) |
| **Booking** | A patient's paid place in a window, with a token | Token 18, for Chintu |
| **Slot** | One place in a window; its number is the token | 10–11 AM, token 11, state `held` |
| **Hold** | A place reserved for 10 minutes while the patient pays | A `pending_payment` booking + a `held` slot |
| **Queue entry** | A patient's live position on the day (online, direct or emergency) | state `waiting`, order 180 |
| **Live state** | What the board shows: now seeing, late minutes, on break | `nowSeeing 15, late 20` |

All money is stored as **integer paise**. All instants are `timestamptz` in UTC. Session dates and hours are
computed in **Asia/Kolkata**; the API returns ISO strings with offsets, and the app formats them.

---

## 3. Database schema

Tables grouped by module. `id` is UUID v7 (time-ordered; good index locality) unless stated.
Every table has `created_at` and `updated_at`. Soft deletes only where noted.

### 3.1 Identity & access

```
users
  id                uuid pk
  phone             varchar(15) unique null     -- E.164, patients
  email             citext unique null
  status            enum(active, suspended, deleted)
  last_login_at     timestamptz
  deleted_at        timestamptz null            -- account deletion (DPDP); PII scrubbed by a job

user_roles
  user_id           fk users
  role              enum(patient, doctor, admin)
  pk(user_id, role)

doctor_credentials                              -- doctors log in with ID + password issued by OPflow
  user_id           pk fk users
  login_id          varchar(16) unique          -- "OPD-10234"
  password_hash     text                        -- argon2id
  must_change       boolean default true        -- first login forces a new password
  failed_attempts   int default 0
  locked_until      timestamptz null            -- 5 wrong tries → 15 min lock
  password_changed_at timestamptz

admin_users
  id, email citext unique, name, password_hash, totp_secret_enc bytea, role enum(super, ops, finance, support), status

refresh_tokens                                  -- rotating, reuse detection
  id                uuid pk
  user_id           fk users (or admin id)
  family_id         uuid                        -- all rotations of one login
  token_hash        bytea unique                -- sha256 of the opaque token
  device_id         fk devices null
  expires_at, revoked_at, replaced_by, ip inet, user_agent

devices
  id, user_id, platform enum(android, ios, web), fcm_token text unique null,
  app_version, locale, last_seen_at
```

### 3.2 Patients

One phone account = one patient. **There are no family members:** every booking is for the logged-in patient.
(Booking for family can be added later as a separate table without changing bookings, because bookings keep
their own copy of the patient's details, below.)

```
patient_profiles
  user_id           pk fk users                 -- the phone account
  name              varchar(80)
  birth_year        smallint                    -- store the year, show the age (age changes, the year does not)
  gender            enum(male, female, other)

notification_prefs
  user_id pk, reminders bool, late_alerts bool, turn_alerts bool, email_receipts bool
```

### 3.3 Catalog (seeded from `app/lib/mock/*.dart`)

```
doctor_types        id slug pk ('child'), simple_name, proper_name, icon, sort, is_common bool
hospitals           id, name, slug unique, address, area, city, pin, lat, lng (earthdistance index),
                    phone, opd_timings_text, has_emergency bool, status enum(active, hidden), facade_seed int
hospital_departments  hospital_id, type_id, pk(hospital_id, type_id)
health_problems     id slug, name, icon, is_danger bool, sort
problem_type_map    problem_id, type_id, audience enum(adult, child), rank, pk(problem_id, type_id, audience)
emergency_kinds     id slug, name, detail, icon, sort
emergency_kind_types  kind_id, type_id
```

### 3.4 Doctors

```
doctors
  id                uuid pk
  user_id           fk users unique
  name              varchar(80)                 -- locked: only admin edits
  type_id           fk doctor_types             -- locked
  degrees           varchar(120)                -- locked
  reg_council       varchar(60), reg_no varchar(40)   -- locked
  gender            enum                        -- editable by doctor
  years_experience  smallint                    -- editable
  languages         text[]                      -- editable
  about             varchar(240)                -- editable
  fee_paise         int check (fee_paise between 5000 and 300000)   -- editable (₹50–₹3000)
  photo_key         text null                   -- R2 key; public CDN URL built from it
  verification      enum(pending, verified, needs_correction, rejected)
  verification_note text null
  status            enum(active, suspended)
  search_vector     tsvector (generated: name, degrees, type names)
  -- listing rule: only verification = 'verified' AND status = 'active' are public

doctor_hospitals    doctor_id, hospital_id, fee_paise_override null, is_primary, status, pk(doctor_id, hospital_id)
doctor_documents    id, doctor_id, kind enum(degree, registration, id_proof, other), file_key (private), status, reviewed_by
payout_accounts     doctor_id pk, razorpay_account_id, status enum(pending, active, suspended), bank_last4, ifsc
emergency_status    doctor_id pk, hospital_id, status enum(off, available_now, available_till, on_call),
                    mode enum(at_hospital, phone_first), until_at timestamptz null, updated_at
                    -- a job sets status=off when until_at passes; patients never see stale "available"
```

### 3.5 Schedule, sessions & windows (the heart of G1)

```
schedule_templates
  id, doctor_id, hospital_id, weekday smallint (1–7),
  start_time time, end_time time,               -- 09:00–13:00 (IST wall clock)
  window_minutes smallint default 60,
  online_per_window smallint,                   -- "Patients per hour"
  direct_places smallint,                       -- "Places for direct patients"
  take_emergency bool,
  avg_consult_minutes smallint,                 -- the starting estimate; learnt from real data later
  open_days_ahead smallint default 14,
  close_minutes_before smallint default 30,
  valid_from date, valid_to date null
  no overlapping blocks for the same doctor on the same weekday, across ALL hospitals (checked on save;
  sessions also carry a DB exclusion constraint, see opd_sessions)

doctor_leaves       id, doctor_id, hospital_id null (null = all), date, reason, created_by

opd_sessions
  id                uuid pk
  doctor_id, hospital_id
  date              date                        -- IST date
  starts_at, ends_at timestamptz
  status            enum(scheduled, running, paused, ended, cancelled)
  late_minutes      smallint default 0
  started_at, ended_at timestamptz null
  avg_consult_sec   int                         -- running average (EWMA) during the day
  now_seeing_token  int null                    -- denormalised for fast board reads
  next_direct_token int                         -- D-series counter (walk-ins)
  next_emergency_token int                      -- E-series counter
  version           int default 0               -- bumps on every live change (ordering, caching)
  template_id       fk null
  unique(doctor_id, hospital_id, date, starts_at)
  exclude using gist (doctor_id with =, tstzrange(starts_at, ends_at) with &&) where (status <> 'cancelled')
                                                -- one doctor, one place at a time, across all hospitals

opd_windows
  id                uuid pk
  session_id        fk opd_sessions
  starts_at, ends_at timestamptz
  capacity          smallint                    -- online places in this hour
  token_start       int                         -- window k owns tokens token_start .. token_start+capacity-1
  status            enum(open, closed)          -- closed = booking cut-off passed, leave, or cancelled

window_slots                                    -- ONE ROW PER PLACE. This is what makes overbooking impossible.
  window_id         fk opd_windows
  token             int
  state             enum(free, held, booked, blocked)   -- blocked = doctor reduced capacity after booking
  booking_id        fk bookings null            -- set when held/booked
  held_until        timestamptz null
  version           int default 0
  pk(window_id, token)
  check ((state = 'free') = (booking_id is null))
  index(window_id, state, token)
```

**Why one row per place (not counters).** A counter such as `booked + held` drifts if any code path forgets to
increment or decrement it, and it cannot say *which* token is free. With one row per place:
- **Taking a place** is one statement that can never oversell:
  ```sql
  UPDATE window_slots s SET state='held', booking_id=$b, held_until=now()+interval '10 min', version=version+1
  WHERE (s.window_id, s.token) = (
      SELECT window_id, token FROM window_slots
      WHERE window_id=$w AND state='free'
      ORDER BY token LIMIT 1
      FOR UPDATE SKIP LOCKED)          -- concurrent buyers take different rows, nobody waits
  RETURNING token;                     -- 0 rows → WINDOW_FULL
  ```
- **The token is the place.** A released place (expired hold) becomes `free` again with the *same* token, so the next
  buyer gets the lowest free token. No clashes, no gaps, no renumbering.
- **Counts are exact by construction:** `count(*) … group by state`. The availability cache is rebuilt from these rows.

**Tokens.** Each window owns a fixed token range sized for the maximum places per hour (`MAX_PER_WINDOW = 20`):
9–10 → tokens 1–20, 10–11 → 21–40, and so on. Only the first `capacity` numbers of each range exist as slots at first,
so with 8 per hour the tokens are 1–8, 21–28, 41–48… A token therefore still tells the patient their hour, and adding
places later never collides with the next hour. The app never does maths on token numbers: "N people before you"
always comes from the server.
**Direct and emergency patients** get their own series, shown with a letter: **D1, D2…** (came directly) and **E1…**
(emergency), from `opd_sessions.next_direct_token` / `next_emergency_token`. Staff and patients can never confuse them
with online tokens. (App change: the doctor console shows these labels.)

**Changing timings when bookings already exist (safe rules).**
- Template edits apply only to **future sessions**. Sessions that already have bookings are adjusted, never rebuilt.
- **More places per hour** → new `free` slot rows are added at the end of the window's range. The range is sized for
  the maximum places per hour (`MAX_PER_WINDOW = 20`), so adding places never collides with the next hour's tokens.
- **Fewer places per hour** → only `free` rows become `blocked`. Booked places are never taken away. If the new
  number is below what is already booked, the doctor is told: "8 patients already booked at 10–11. New bookings stop here."
- **Removing an hour or a whole day** that has bookings uses the doctor-cancel flow (§4.3): move patients, or refund.
- **A doctor cannot be in two places at once:** an exclusion constraint on `opd_sessions`
  (`EXCLUDE USING gist (doctor_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE status <> 'cancelled'`)
  across **all** hospitals, not just within one.

### 3.6 Bookings, queue & events

```
bookings
  id                uuid pk
  code              varchar(10) unique          -- human code "OPF7Q2K9", on receipts
  patient_user_id   fk users                    -- the account that booked (ownership check)
  patient_name      varchar(80)                 -- copy of the profile at booking time: what the doctor sees,
  patient_age       smallint                    -- and it stays correct even if the profile changes later
  patient_gender    enum(male, female, other)
  doctor_id, hospital_id, session_id, window_id
  token             int
  source            enum(online, direct, emergency)
  status            enum(pending_payment, confirmed, completed, no_show,
                         cancelled_by_provider, expired)          -- no "cancelled_by_patient": rule G3
  hold_expires_at   timestamptz null            -- pending_payment only
  window_id + token point at exactly one window_slots row (FK on (window_id, token))
  fee_paise         int                         -- price at booking time (the fee may change later)
  platform_fee_paise int                        -- 10% of fee_paise, computed server-side
  note              varchar(140)
  reschedule_count  smallint default 0          -- max 1
  rescheduled_at    timestamptz null
  cancelled_reason  varchar(120) null, cancelled_by fk users null
  idempotency_key   varchar(64) unique null     -- from the app's Idempotency-Key header
  unique(session_id, source, token) where status in ('pending_payment','confirmed','completed','no_show')
                                                -- online 11, D11 and E11 can coexist; two online 11s cannot
  index(patient_user_id, created_at desc)
  index(session_id, status)

queue_entries                                   -- one per booking on the day, plus walk-ins
  booking_id        pk fk bookings
  session_id        fk
  state             enum(not_come, waiting, with_doctor, done, did_not_come, cancelled, moved)
  order_key         numeric                     -- emergency gets min-1, "skip" gets max+1; no renumbering
  reached_at, called_at, done_at timestamptz null
  index(session_id, state, order_key)

booking_events      -- append-only history for bookings (timeline screen, disputes)
  id bigserial, booking_id, type enum(held, confirmed, payment_failed, expired, rescheduled,
  cancelled_by_provider, refund_started, refund_done, reached, called, done, did_not_come, put_back),
  actor_id, actor_role, data jsonb, at timestamptz

queue_events        -- append-only per session; drives the live stream and time predictions
  id bigserial, session_id, version int, type, booking_id null, data jsonb, at
  unique(session_id, version)
```

### 3.7 Payments

```
payments
  id                uuid pk
  booking_id        fk
  razorpay_order_id  varchar unique
  razorpay_payment_id varchar unique null
  amount_paise      int, currency char(3) default 'INR'
  status            enum(created, authorized, captured, failed)
  method            varchar null                -- upi, card, netbanking
  failure_reason    text null
  raw               jsonb                       -- the last Razorpay payload, for support

refunds
  id, payment_id, razorpay_refund_id unique null, amount_paise,
  reason enum(provider_cancelled, late_payment, duplicate, admin_goodwill), status enum(pending, processed, failed),
  attempts int, next_attempt_at, failure_reason,
  initiated_by fk users/admin

transfers           -- the doctor's 90% (Razorpay Route)
  id, payment_id unique, doctor_id, razorpay_transfer_id unique null, amount_paise,
  status enum(on_hold, released, reversed, failed), release_at timestamptz

idempotency_keys    -- replay-safe writes (hold, verify, reschedule, cancel, console commands)
  key varchar(64), user_id, route varchar, request_hash bytea, response jsonb, status_code int,
  created_at, pk(user_id, key)                 -- purged after 24 h

bulk_operations     -- "cancel the whole day", "move everyone": progress + audit
  id, doctor_id, kind enum(cancel_day, move_day, end_opd_cancel, end_opd_move), session_id,
  total int, done int, failed int, status enum(running, finished, needs_attention), created_by, created_at

webhook_events      -- every Razorpay webhook stored once (dedupe by event id), then processed
  id varchar pk (razorpay event id), type, payload jsonb, received_at, processed_at null, error text null
```

### 3.8 Notifications, content, support, platform

```
notifications       id, user_id, kind enum(booked, reminder, late, turn, cancelled, changed, refund, system),
                    title, body, booking_id null, data jsonb, read_at null, created_at
                    index(user_id, created_at desc)
outbox              id bigserial, topic, payload jsonb, available_at, attempts, last_error, done_at null
                    -- written in the same transaction as the change; relayed by the worker (see §6)

first_aid_guides    kind_id pk → emergency_kinds, intro, signs[], call_now_if[], dos[], donts[],
                    sources jsonb [{title, year, url}] (WHO documents), source_to_confirm bool,
                    status enum(draft, in_review, published), reviewed_by_doctor, reviewed_at, published_at
                    -- publishing needs a named doctor's review AND a confirmed WHO source (DB constraint).
                    -- The app also bundles this content so emergency help works with no internet.
                    -- (The earlier health-tips tables were removed in migration …001700.)

support_tickets     id, user_id, message, status enum(open, answered, closed), assigned_to
app_config          key pk, value jsonb        -- platform_fee_percent=10, reschedule_cutoff_minutes=120,
                                               -- hold_minutes=10, reschedule_max=1. Shared with web/site.ts.
audit_log           id bigserial, actor_type, actor_id, action, entity, entity_id, before jsonb, after jsonb,
                    ip inet, at timestamptz    -- all admin actions, all money actions, all doctor profile edits
```

---

## 4. The critical flows

### 4.0 State machines (the only allowed moves)

Every status column below changes only through these transitions, each written as a guarded
`UPDATE … WHERE status = <from>`. A transition table in code (`*.states.ts`) is the single place that lists them.
A DB trigger rejects anything else, as a safety net for manual SQL.

```
Booking        pending_payment ──confirm──► confirmed ──complete──► completed
                      │                         │  ├──no_show──────► no_show ──undo(doctor)──► confirmed
                      └──expire──► expired      │  └──provider_cancel──► cancelled_by_provider
                                                └──reschedule (stays confirmed, reschedule_count 0→1)

Window slot    free ──hold──► held ──confirm──► booked ──release(cancel)──► free
                ▲              └──expire───────────────────────────────────────┘
                └── blocked ◄──(capacity lowered; only from free)

Queue entry    not_come ─► waiting ─► with_doctor ─► done
                  │           │ ▲          │
                  │           │ └─skip─────┘   (skip/put-back move order_key to the end)
                  └───────────┴──► did_not_come ──put_back──► waiting
               any open state ──► cancelled | moved (only by provider-cancel / move flows)

Session        scheduled ─► running ⇄ paused ─► ended          scheduled|running|paused ─► cancelled

Payment        created ─► authorized ─► captured          created|authorized ─► failed
Refund         pending ─► processed | failed ─(retry)─► pending
Transfer       on_hold ─► released          on_hold|released ─► reversed
```

**Races are settled by the lock order.** Every flow that touches a booking locks rows in the same order:
**session → booking → slot → payment**. For example, "patient reschedules" and "doctor cancels" at the same second:
both `SELECT … FOR UPDATE` the booking, one waits, then re-checks the state and finds it has moved on. It returns
`409 BOOKING_CHANGED` with the fresh booking, and the app shows it. A consistent order also means no deadlocks.

### 4.1 Booking and paying (G1, G2, G3, G8)

```
App                          API                                     Postgres / Razorpay
 │ POST /bookings/hold   ──► checks: caller has a patient profile; window open; now() < starts_at − cut-off;
 │  {windowId,                        caller has < 2 active holds; caller has no active booking with this
 │   note}                           doctor on this date (stops one phone taking all places)
 │  Idempotency-Key: k1      BEGIN
 │                             take lowest free slot (UPDATE … FOR UPDATE SKIP LOCKED, see §3.5)
 │                               ── 0 rows → 409 WINDOW_FULL ("This time just got full. Please pick another.")
 │                             INSERT bookings(pending_payment, token, fee, platform_fee = round(fee × 10%),
 │                                             hold_expires_at = now() + 10 min)
 │                             INSERT payments(created, amount = fee)          ← amount always from the server
 │                           COMMIT
 │                           Razorpay: create order (receipt = booking.code, notes.bookingId), 5 s timeout,
 │                             store razorpay_order_id. Failure → release the slot and return
 │                             503 PAYMENTS_UNAVAILABLE ("Payments are not working right now. No money was taken.")
 │ ◄── {bookingId, token, orderId, amount, keyId, holdExpiresAt}
 │ Razorpay Checkout (payment_capture = auto) ─────────────────────────────► Razorpay
 │ ◄── {razorpay_payment_id, razorpay_signature}
 │ POST /payments/verify ──► verify HMAC; fetch the payment from Razorpay (amount, order id and status must match)
 │                           confirmBooking(paymentId)   ← the one shared function (below)
 │ ◄── booking (token, window, code)
 │
 │               webhook payment.captured ──► store in webhook_events (dedupe by event id) ──► confirmBooking()
```

**`confirmBooking(payment)`**, shared by verify and webhook, safe to run twice or at the same time:
```
BEGIN
  lock booking FOR UPDATE
  case booking.status
    confirmed, same payment id   → return it (already done: idempotent)
    confirmed, other payment id  → duplicate payment: refund it fully (reason=duplicate), return the booking
    pending_payment              → slot held→booked, booking→confirmed, payment→captured,
                                   transfer(on_hold, 90%), queue entry, events, outbox(booked)
    expired                      → try to take the SAME token again (it may still be free):
                                     free  → confirm as above
                                     taken → try any free slot in the same window:
                                               found → confirm with the new token, tell the patient
                                               none  → refund fully (reason=late_payment), outbox(refund)
COMMIT
```
So a patient who pays at 10:01 with a hold that ended at 10:00 either still gets a place or gets all their money back
automatically. Never "paid but nothing".

- **Hold expiry** runs from the **database**, not only Redis. A sweeper every 30 s runs
  `UPDATE … WHERE status='pending_payment' AND hold_expires_at < now() RETURNING …`, and a BullMQ delayed job
  gives second-level accuracy. If Redis is lost, holds still expire.
- **Before expiring a hold**, the sweeper asks Razorpay once whether the order was paid (for holds with an order).
  This catches payments whose webhook is delayed.
- **Payment failed or cancelled** in Checkout: the booking stays `pending_payment` until expiry. "Try again" creates a
  new Razorpay order on the same booking (the previous order is marked abandoned). Only one open order per booking.
- **Price lock:** the fee is copied into the booking at hold time, so a doctor changing their fee mid-payment has no effect.
- **Idempotency-Key:** stored with a hash of the request body. The same key with a different body → `422 IDEMPOTENCY_MISMATCH`.
  Kept 24 h in Postgres (`idempotency_keys` table), cached in Redis.

### 4.2 Change date or time (patient, once)

`POST /bookings/:id/reschedule {windowId}` + Idempotency-Key, in one transaction, with the §4.0 lock order:
1. Lock session (old), booking, then the booking's slot. Check `confirmed`, `reschedule_count = 0`,
   `now() < old window start − 120 min` and the new window is open and in the future. Otherwise
   `422 RESCHEDULE_NOT_ALLOWED` with the reason text the app already shows.
2. Take the lowest free slot in the new window (same SKIP LOCKED statement). None → `409 WINDOW_FULL`, and nothing changes.
3. Release the old slot (`booked → free`), point the booking at the new session/window/token, `reschedule_count = 1`.
4. Update the queue entry if the new date is today. Events, outbox(changed). No money moves.

All or nothing: the patient can never end up with two places, or none.

### 4.3 Doctor cancels (one booking, or the whole day) (G3, G8)

- **One booking:** `POST /doctor/bookings/:id/cancel {reason}` → guarded `confirmed → cancelled_by_provider`,
  slot released, `refunds(pending, 100% of fee)`, transfer reversed if released, outbox(cancelled). The Razorpay refund
  call happens **after commit** from the outbox (retried with backoff), so a slow Razorpay never blocks the doctor.
- **Whole day / leave / END OPD "cancel and give money back":** one `bulk_operations` row (who, what, how many) plus a
  BullMQ job per booking, running the same single-booking code. Each is idempotent, so a crash halfway is safe to
  rerun. The doctor sees progress ("12 of 18 refunds started").
- **"Move them to another day":** bookings become `moved`, and patients get a one-tap "pick a new time" link. They choose
  freely (reschedule limits don't apply to a provider move), or get a full refund automatically after 48 h.
- **Refund failures** (bank rejects, UPI closed): retried 3 times over 24 h, then put in the admin queue with the
  patient's details. Status is visible to the patient: "Money back started / reached / delayed: we are fixing it".

### 4.4 Live line (G4)

**Doctor console commands** (REST, each with `commandId` for idempotency and `expectedVersion`):
`start`, `call-next`, `done`, `did-not-come`, `skip`, `call-now`, `mark-reached`, `put-back`, `pause`, `resume`,
`late {minutes}`, `add-direct`, `add-emergency`, `end`.

Each command runs as:
1. `BEGIN; SELECT … FROM opd_sessions WHERE id=$1 FOR UPDATE` — **the database row lock is the real guard**.
   Two taps, or two devices (doctor's phone + a future receptionist tablet), are applied strictly one after another.
2. If `expectedVersion ≠ session.version`: for **safe commands** (`late`, `pause`, `mark-reached`, `add-direct`) apply anyway.
   For **position commands** (`call-next`, `done`, `skip`, `call-now`) reject with `409 STALE_BOARD` and the fresh
   board, so the doctor never "calls next" based on a screen that is out of date.
3. Apply the change to `queue_entries` / `opd_sessions`, `version = version + 1`, insert `queue_events(version)`
   (unique per session: no two events share a version), insert outbox(live). COMMIT.
4. The outbox relay publishes `{sessionId, version, board}` to Redis pub/sub → Socket.IO room `session:{id}`, updates the
   Redis `board:{sessionId}` cache, recomputes predictions, and queues pushes.
   (For speed, the API also publishes right after commit. The relay's copy with the same version is ignored by clients.)

**Patient phones** join `session:{id}` for their today-booking and receive
`board {nowSeeing, late, onBreak, version, ahead, etaRange}`. "N people before you" is computed per patient on the server,
so a phone never receives the whole list (privacy: G5).

**Resilience**
- **Version gaps:** a client that had v41 and receives v43 calls `GET /live/sessions/:id?since=41` and replays.
- **Socket drop:** exponential reconnect (1 s, 2 s, 4 s … up to 30 s); meanwhile it polls `GET /live/…` every 15 s with ETag.
- **Token expiry on an open socket:** the server sends `reauth`; the client refreshes and re-joins without a gap.
- **App closed:** FCM push for turn alerts and delays.
- **Doctor console offline:** commands are queued on the phone (persisted), applied optimistically on screen, and sent
  in order on reconnect. Position commands that come back `STALE_BOARD` are shown as "Line changed while you were
  offline. Please check" with the fresh board, never applied blindly.
- **Push flood control:** late alerts are coalesced (at most one per patient per 10 minutes, and only when the delay
  changes by 10 minutes or more). Turn alerts at most once per patient for "2 away" and once for "called".
- **Multiple API instances:** the Socket.IO Redis adapter fans out across instances. If Redis pub/sub is down, clients
  keep getting correct data from polling (degraded to 15 s, still correct).

### 4.5 Waiting-time prediction (v1: simple and honest)

```
ahead         = waiting/not_come entries with order_key < mine (did_not_come skipped)
avg           = session.avg_consult_sec   (EWMA over today's done entries, α = 0.3;
                                            starts from template.avg_consult_minutes)
late          = session.late_minutes
wait_low      = ahead × avg × 0.8 + late
wait_high     = ahead × avg × 1.2 + late + 5 min
```
The app shows a range ("About 15 – 25 min"), never an exact minute. `queue_events` keeps the history needed to
train something better after the pilot (per doctor, per weekday, per hour).

### 4.6 Doctor profile & photo

1. `POST /doctor/me/photo/upload-url` → presigned R2 PUT URL (`image/jpeg`, max 5 MB, 5-minute expiry).
2. The app uploads straight to R2 (no API bandwidth), then calls `PATCH /doctor/me {photoKey}`.
3. The worker makes 3 sizes (96, 320, 800 px, WebP) with `sharp`. The API returns `photo: {s, m, l}` CDN URLs.
4. Locked fields (name, type, degrees, registration) can be changed only through the admin API, with `audit_log`.
   Editable fields go live immediately and invalidate the doctor's cached cards.

### 4.7 Authentication

| Who | Login | Tokens |
|---|---|---|
| Patient | Firebase Phone Auth on the phone → `POST /auth/patient/exchange {firebaseIdToken}` → the server verifies it with the Firebase Admin SDK, finds or creates the `users` row by phone, and adds the `patient` role | **Access JWT** (15 min, EdDSA-signed: `sub, roles, sid`) + **refresh token** (opaque, 30 days, rotating) |
| Doctor | `POST /auth/doctor/login {loginId, password}` → argon2 check, lockout after 5 failures. If `must_change`: returns `{mustChange: true, changeToken}` → `POST /auth/doctor/set-password` | Same tokens; `roles: [doctor]`, `doctorId` claim |
| Admin | Email + password + **TOTP** on the admin site; short sessions (8 h), IP logged | Separate audience (`aud: admin`) |

- **Refresh rotation with reuse detection:** using an old refresh token revokes the whole family (stolen-token defence).
- Tokens live in `flutter_secure_storage`. Dio's interceptor refreshes once on 401 and queues parallel requests
  while it does.
- **Rate limits** (Redis): OTP exchange 5/min/phone; doctor login 10/min/IP; booking hold 10/min/user;
  general 120/min/user.

### 4.8 Money settlement

- **Emergency consultation** (migration …001800): the patient pays **fee + emergency charge** (`emergency_charge_percent`, 20%
  by default). The charge is entirely OPflow's; the fee splits 90/10 as usual. For a ₹500 fee: patient ₹600, doctor ₹450,
  OPflow ₹150. Database triggers refuse a payment that isn't exactly fee + charge, and a doctor transfer that isn't exactly
  90% of the fee. Emergency bookings get E-tokens and go to the top of the line.
- **Pause bookings:** `doctors.bookings_paused`. While it's true, `POST /bookings/hold` returns `409 BOOKINGS_PAUSED`
  ("The doctor is not taking new bookings right now"). Existing bookings are untouched.

- Every captured payment creates a Route **transfer of 90%** to the doctor's linked account, **on hold** until
  24 h after the session ends. The worker releases due transfers every hour.
- Doctor cancels before release → refund 100%, reverse the transfer (nothing was paid out yet: the common case).
- Doctor cancels after release (rare, late disputes) → refund 100% from the platform balance; the reversal is
  recovered from the next settlement (`transfers.status = reversed`).
- The earnings screen reads `transfers` (not `payments`), so "In bank / Coming / Money back given" matches reality.

---

## 5. API (v1)

REST + JSON, base `/v1`. OpenAPI 3.1 is generated by `@nestjs/swagger` and is the contract for the Flutter client.

**Conventions**
- Errors: `{ "error": { "code": "WINDOW_FULL", "message": "This time just got full. Please pick another.", "details": {} } }`.
  The message is written in the app's simple English, so the app can show it directly.
- Lists use cursor pagination: `?cursor=…&limit=20` → `{ items, nextCursor }`.
- Changing requests (hold, verify, reschedule, cancel, console commands) take an `Idempotency-Key` header.
- Reads send `ETag`; the client sends `If-None-Match` (cheap refreshes).
- Times are ISO-8601 with offset. Money is `{ "paise": 30000, "display": "₹300" }`.

| Module | Endpoints (auth) |
|---|---|
| **auth** | `POST /auth/patient/exchange` · `POST /auth/doctor/login` · `POST /auth/doctor/set-password` · `POST /auth/refresh` · `POST /auth/logout` · `DELETE /me` (account deletion) |
| **users** (patient) | `GET/PATCH /me` (name, age, gender) · `GET/PATCH /me/notification-prefs` · `POST /me/devices` (FCM token) · `PATCH /me/place` |
| **catalog** (public) | `GET /catalog` → types, problems + maps, emergency kinds, topics, `app_config` (one call at startup, cached 24 h) · `GET /hospitals?near=lat,lng&q=&cursor=` · `GET /hospitals/:id` |
| **doctors** (public) | `GET /doctors?type=&problem=&who=&hospital=&q=&near=&day=today\|tomorrow&lang=&sort=fee\|distance&cursor=` → cards with `nextFree` included (one query, no N+1) · `GET /doctors/:id` (with weekly timings table) |
| **availability** (public) | `GET /doctors/:id/days?hospital=` → 14-day strip (free counts per day) · `GET /doctors/:id/windows?date=&hospital=` → windows with capacity/booked/held/over |
| **bookings** (patient) | `POST /bookings/hold` · `GET /bookings?tab=upcoming\|past` · `GET /bookings/:id` (with timeline and live board if today) · `POST /bookings/:id/reschedule` · `GET /bookings/:id/receipt` |
| **payments** | `POST /payments/verify` (patient) · `POST /payments/:bookingId/retry` · `POST /webhooks/razorpay` (signature-verified, public) |
| **live** | `GET /live/sessions/:id?since=` (patient: own board; doctor: full line) · WS namespace `/live`: `join {sessionId}` (token checked), events `board`, `line` (doctor only) |
| **doctor** (doctor) | `GET/PATCH /doctor/me` · `POST /doctor/me/photo/upload-url` · `GET /doctor/hospitals` · `GET /doctor/today?hospital=` · `POST /doctor/sessions/:id/{start,pause,resume,late,end}` · `POST /doctor/sessions/:id/queue/{call-next,done,did-not-come,skip,call-now,mark-reached,put-back}` · `POST /doctor/sessions/:id/{direct,emergency}` · `GET /doctor/bookings?date=&filter=` · `GET /doctor/bookings/:id` · `POST /doctor/bookings/:id/{cancel,move}` · `POST /doctor/days/:date/cancel` · `GET/PUT /doctor/schedule?hospital=` · `GET/PUT /doctor/leaves` · `GET/PUT /doctor/emergency` · `GET /doctor/earnings?range=` · `GET /doctor/reports?range=` · `POST /doctor/password` |
| **emergency** (public) | `GET /emergency/near?kind=&lat=&lng=` → emergency hospitals + doctors whose status is not expired, with `updatedAt` |
| **notifications** | `GET /notifications?cursor=` · `POST /notifications/read {ids \| all}` |
| **emergency** (public) | `GET /emergency/first-aid` → every published first-aid page (the app caches it; bundled copy works offline) · `GET /emergency/first-aid/:kind` |
| **support** | `POST /support/tickets` |
| **admin** (admin, TOTP) — full plan in `admin/docs/ADMIN_PORTAL.md` | doctors (create account and issue login ID, verify, edit locked fields, suspend), hospitals, documents, bookings search, refunds, transfers, content publishing, config, support, audit log search |

---

## 6. Background work (worker process)

| Job | Trigger | What it does |
|---|---|---|
| `sessions.generate` | Nightly 00:30 IST, and on every template or leave change | Creates `opd_sessions` + `opd_windows` for the next `open_days_ahead` days, skipping leave days. Idempotent (unique key). |
| `holds.expire` | DB sweeper every 30 s (works without Redis) + BullMQ delayed job for accuracy | Checks the Razorpay order once, then pending_payment → expired and slot held → free (guarded transitions). |
| `outbox.relay` | Continuous (1 s poll, or LISTEN/NOTIFY) | Reads `outbox` rows and fans out to pushes, emails, in-app notifications and WS publishes. Retries with backoff. |
| `reminders` | Scheduled per booking | 1 day before and 1 hour before ("Your time starts at 10 AM"), respecting prefs. |
| `turn.alerts` | After each queue event | Push when a patient becomes 2 away and when called. |
| `sessions.auto` | Every 5 min | Marks `not_come` as `did_not_come` 60 min after their window ends (doctor can undo); auto-ends sessions 3 h after `ends_at`. |
| `emergency.expire` | Every 5 min | `available_till` past its time → `off`. |
| `payouts.release` | Hourly | Releases due Route transfers. |
| `refunds.sync` | Webhook + hourly reconcile | Updates refund status and notifies "Money back reached". |
| `photos.process` | On upload | Resize to WebP sizes, strip EXIF (removes location). |
| `privacy.purge` | Daily | Scrubs deleted accounts after the retention window; deletes expired OTP/idempotency keys. |
| `payments.reconcile` | Nightly | Compares Razorpay settlements with `payments`/`transfers`; alerts admins on any mismatch. |
| `invariants.check` | Nightly + on demand | Runs every check in §10; pages on failure. |
| `refunds.retry` | Every 15 min | Retries failed refunds (3 tries over 24 h), then hands them to the admin queue. |
| `bulk.run` | On doctor action | Cancel/move a whole day, one idempotent job per booking; progress in `bulk_operations`. |
| `idempotency.purge` | Hourly | Deletes idempotency keys older than 24 h. |
| `sessions.capacity` | On template change | Adds or blocks free slots in future sessions (never touches booked ones), per §3.5 rules. |

**Transactional outbox:** side effects (push, email, WS) are never sent inside a request. The request writes an
`outbox` row in the same transaction as the data change, and the worker delivers it. So a crash can never produce
"patient notified but booking not saved", or the other way round.

---

## 7. Making it smooth (G6) — performance & caching

| What | How |
|---|---|
| Startup | One `GET /catalog` (types, problems, topics, config), cached on the phone for 24 h with ETag. Home renders from cache instantly, then refreshes. |
| Doctor cards | One SQL query builds cards with `nextFree` (a lateral join to the first open window) and distance (`earth_distance(ll_to_earth(…))`, with a GiST index for "near me"). Redis cache per filter key, 30 s TTL, invalidated when a doctor's windows change. |
| Availability | Counts per window come from `window_slots` (`group by state`) and are cached in Redis (`win:{sessionId}`), refreshed after every hold/confirm/expire/release. If the cache is missing, one indexed query rebuilds it. A 14-day strip is one grouped query. |
| Search | `pg_trgm` + `tsvector` on doctor and hospital names, types and problems; trigram handles typos ("pediatric", "peadiatric"). |
| Images | CDN WebP sizes; the app requests `s` in lists and `l` on the doctor page; `cached_network_image` on the phone. |
| Live board | Read from Redis `board:{sessionId}` (O(1)), not Postgres. |
| DB | PgBouncer (transaction mode) in front of Postgres; indexes listed in §3; `EXPLAIN` checks in CI for the 10 hottest queries. |
| Latency budget | Mumbai region for DB, Redis and API → about 20–40 ms network from Andhra Pradesh. p95 targets: reads < 200 ms, hold < 400 ms (includes Razorpay order), WS fan-out < 1 s. |
| App side | Stale-while-revalidate for lists; optimistic UI for console commands and read-marks; the OP loader only for real waits (payment, hold). |

---

## 8. Security & privacy (G5, G7)

- **Authorisation in one place:** a `PolicyGuard` plus query scoping helpers (`forPatient(userId)`, `forDoctor(doctorId)`).
  Repositories never take a raw id without an owner. e2e tests try cross-account access on every route.
- **Doctors see** name, age, gender, note and a **masked phone** (`98xxxxx210`). The full number is used only by
  a server-side "call" feature later (number masking via an exotel-style bridge); it is never sent to the doctor app.
- **Encryption:** TLS everywhere; DB and R2 encrypted at rest; `note` and document keys encrypted at column level
  (pgcrypto, key in the secrets manager). Verification documents are private R2 objects with 5-minute signed read URLs.
- **Secrets:** Fly/AWS secrets; nothing in the repo; Razorpay webhook secret rotated yearly.
- **Payments:** amount always from the server (never from the app); signature verification; webhook dedupe by event id.
- **Abuse:** rate limits (§4.7); hold limits (max 2 active holds per account); OTP abuse alerts.
- **DPDP Act 2023:** consent at signup (link to the privacy policy on the website), account deletion (`DELETE /me`),
  data export on request, minimum data (birth year, not full date of birth), India-region storage, a grievance officer
  (already listed in `web/src/lib/site.ts`).
- **Audit:** every admin action, money action, doctor locked-field change and login is written to `audit_log`.

---

### 8.1 Stronger defences (added)

- **Defence in depth for patient data:** besides the app-level scoping, Postgres **Row-Level Security** is enabled on
  `bookings`, `patient_profiles`, `notifications` and `queue_entries`. The API sets `app.user_id` / `app.doctor_id` per
  transaction (`set_config(..., true)`); a missed `where` in code still cannot leak another patient's rows.
- **Signing keys rotate:** access JWTs carry `kid`. Two active keys during rotation (every 90 days); the old one is
  refused after the longest access-token life.
- **Doctor accounts on a new device:** a login from a new device sends an alert to the doctor's registered phone and
  email ("New login to your OPflow account"). Optional second factor (OTP to the registered phone) can be switched on
  per doctor.
- **Admin safety:** admin site behind TOTP plus an IP allow-list. **Two-person approval** for refunds above ₹2,000 and for
  editing a doctor's locked fields. Every admin screen view of patient data is audited.
- **Anti-abuse on places:** at most 2 open holds per account, 1 active booking per account per doctor per day,
  and holds per device fingerprint. Play Integrity /
  App Attest checks on `hold` after the pilot.
- **Supply chain:** Dependabot + `npm audit` in CI, secret scanning, pinned Docker base image, SBOM per release.
- **Before launch:** an external penetration test against OWASP ASVS level 2, and a DPDP review.

---

## 9. Failure modes — what happens when something breaks (G9)

| What breaks | What users see | What the system does |
|---|---|---|
| **Redis down** | Everything still works. Live board updates arrive every 15 s instead of instantly. | Postgres is the truth. Caches are skipped (read from DB). Rate limits fall back to an in-memory limiter per instance. Hold expiry continues via the DB sweeper. Jobs queue up in the outbox table and drain when Redis returns. |
| **Razorpay down or slow** | "Payments are not working right now. No money was taken. Please try in a few minutes." Booking screens still work. | Circuit breaker opens after 5 failures in 30 s; holds are not created while it's open (so no one's place is locked for nothing). Verify/webhook resume when it recovers; reconcile catches anything missed. |
| **Webhooks delayed or lost** | Nothing (verify from the app usually confirms first). | The hold sweeper checks the order status with Razorpay before expiring; the nightly reconcile compares all captured payments. |
| **Firebase OTP down** | "We could not send the code. Please try again in a minute." | Second OTP provider (MSG91) switched on by a config flag. Doctors (password login) are unaffected. |
| **FCM push down** | Pushes are late. | In-app notifications are still written; the live board still updates over WebSocket; the relay retries pushes for up to 30 min, then drops stale ones (a "your turn" push 30 min late is worse than none). |
| **Email (Resend) down** | Receipt email is late. | Retries with backoff for 24 h; the receipt is always in the app. |
| **R2 / CDN down** | Monogram portraits show instead of photos. | The app already falls back to monograms when an image fails. Uploads are refused with a plain message. |
| **One API instance crashes** | Nothing (the other instance takes over); WebSocket clients reconnect in 1–2 s. | 2+ instances behind the load balancer; health checks restart the bad one. Graceful shutdown drains requests and sockets for 20 s on deploy. |
| **Worker crashes mid-job** | Nothing visible, or a delayed notification. | BullMQ retries; every job is idempotent. Stuck bulk operations show "needs attention" in admin. |
| **Postgres failover** | 30–60 s of "Something went wrong. Please try again." on writes. | Managed HA with a standby. The app retries idempotent writes automatically with the same Idempotency-Key. |
| **Doctor's phone offline in OPD** | Console keeps working; a banner says "Offline. Changes will be sent when you're back." | Commands are queued and replayed (§4.4). Patients see the last board plus "Updated 3 min ago". |
| **Patient offline** | Last known booking and board from cache with "Updated at 10:42"; **Emergency help always works**. | The emergency screen, 108 and the list of emergency hospitals are bundled in the app and refreshed when online, so emergency help never depends on the server. |

**Timeouts (all external calls):** Razorpay 5 s, Firebase verify 3 s, FCM 3 s, R2 presign 2 s, DB statement 5 s
(hot paths 1 s). Retries use exponential backoff with jitter, and only for idempotent calls.

---

## 10. Consistency guards — trust, but check every night (G1, G8)

A job runs the checks below every night (and on demand from admin). Any failure pages the on-call person and appears
in the admin "Needs attention" list with a one-click fix where safe.

| Invariant | Check |
|---|---|
| Every `booked` slot has exactly one `confirmed/completed/no_show` booking, and vice versa | join `window_slots` ↔ `bookings` |
| No slot is `held` past `held_until + 2 min` | sweeper health |
| Every captured payment maps to exactly one outcome: confirmed booking, or a refund (cancelled / duplicate / late) | `payments` ↔ `bookings` ↔ `refunds` |
| Sum of captured − refunded = Razorpay settlement report for the day | `payments.reconcile` |
| Every confirmed booking has a transfer of exactly 90% (rounded down to the paisa), and OPflow's 10% is the remainder | `transfers` ↔ `bookings` |
| No transfer is `released` for a booking that is `cancelled_by_provider` without a reversal | `transfers` ↔ `refunds` |
| `queue_events` versions per session are gap-free (1…N) | window function |
| No `outbox` row older than 5 minutes is undelivered | relay health |
| Every public doctor is `verified` and `active`, and has at least one open session in the next 14 days or is hidden from "Doctors near you" | listing hygiene |

**Rounding rule (money):** `platform_fee = floor(fee × 10 / 100)` paise, `doctor_share = fee − platform_fee`. One rule,
in one function, used everywhere. The share always adds up exactly to the fee.

---

## 11. App compatibility, config and kill switches (G10)

- Every request sends `X-App-Version` and `X-Platform`. `GET /catalog` returns `minSupportedVersion` and
  `latestVersion`. Below the minimum → the app shows a friendly "Please update OPflow" screen with a store link;
  below the latest → a dismissible banner.
- **API changes are additive only within `/v1`** (new optional fields, new endpoints). Removing or changing a field
  means `/v2`, and `/v1` stays live until `minSupportedVersion` passes it. The OpenAPI diff check in CI fails on
  breaking changes.
- **Remote config and kill switches** (in `app_config`, cached 60 s, admin-editable, audited):
  `bookings.enabled` (globally or per doctor/hospital), `payments.provider`, `otp.provider`, `emergency.enabled`,
  `maintenance.message`, `health_tips.enabled`, `push.turn_alerts`. We can switch a broken feature off in one
  minute without shipping an app update.
- **Feature flags** for gradual rollouts (for example, the new prediction model for 10% of sessions).

---

## 12. Service targets (SLOs), monitoring and runbooks

| Service level objective | Target (30 days) |
|---|---|
| API availability (non-5xx) | 99.9% |
| Booking success: hold → confirmed for completed payments | 99.95% (a failure here is money) |
| Live board delivery: doctor tap → patient screen | p95 < 1.5 s |
| Read latency (lists, doctor page) | p95 < 200 ms |
| Refund started after doctor cancel | < 1 min p95 |
| Push "your turn is coming" delivered | p95 < 30 s |

**Dashboards:** bookings per minute, hold→confirm funnel, payment failures by method, WS connections and fan-out lag,
outbox lag, queue backlog, DB slow queries, circuit-breaker state.
**Alerts page someone** when an SLO burns too fast, an invariant fails, or the outbox lags over 5 minutes.

**Runbooks** (in `backend/docs/runbooks/`), one page each with checks and safe commands:
"Patient paid but has no booking", "Doctor says the board is stuck", "Refund failed", "Razorpay outage",
"OTP not arriving", "Deploy went bad (rollback)", "Restore the database to a point in time".

---

## 13. Capacity and scaling path

| Stage | Size | What changes |
|---|---|---|
| Pilot | 1–10 doctors, < 500 bookings/day | 2 API + 1 worker (small machines), one Postgres (2 vCPU) with a standby, one Redis. |
| City | 50–500 doctors, ~20k bookings/day, ~5k live watchers at peak | Autoscale API 2→6; PgBouncer; a read replica for listings and search; board cache TTL tuning. |
| State | 5k+ doctors | Partition `queue_events`, `booking_events` and `notifications` by month; split the live line into its own service (it's already its own module with its own tables); a separate Redis for pub/sub; search moved to a dedicated index if trigram hits limits. |

Load the design is checked against: a morning peak where many OPDs start at 9 AM, each with ~40 watchers, and
5 commands/min per session → about 2,000 WS messages/min per 50 sessions. This is small for one Socket.IO node; the
Redis adapter is there for failover, not for load.

---

## 14. Backups and disaster recovery

- Managed Postgres: continuous WAL archiving, **point-in-time recovery for 7 days** (30 days in prod), daily logical
  dumps to R2 in a second region, encrypted.
- **RPO ≤ 5 minutes, RTO ≤ 1 hour** for the database. Redis holds nothing that cannot be rebuilt.
- A **restore drill every month** into staging, followed by the invariant checks (§10) on the restored copy.
- R2 photos: versioning on; documents bucket with object lock for 1 year (verification evidence).
- Infrastructure as code (Fly/Terraform files in the repo), so the whole stack can be recreated in a new region in hours.

---

## 15. Folder structure

```
backend/
├─ docs/
│  ├─ ARCHITECTURE.md                ← this file
│  └─ runbooks/                      ← one page per incident type (§12)
├─ migrations/                       ← SQL migrations run by dbmate (see migrations/README.md) ✅ written and tested
│  ├─ …000100_extensions_and_helpers.sql … …001400_reference_data.sql
│  └─ README.md
├─ db/schema.sql                     ← full schema dumped by dbmate after each migration (for review)
├─ seed/
│     ├─ catalog.ts                  ← doctor types, problems, emergency kinds (ported from app/lib/mock/data.dart)
│     ├─ first_aid.ts                ← WHO-based first aid per emergency situation (from app/lib/mock/first_aid.dart)
│     └─ demo.ts                     ← sample hospitals, doctors (OPD-10234), sessions, bookings for staging
├─ src/
│  ├─ main.ts                        ← boots the HTTP + WS server
│  ├─ worker.ts                      ← boots BullMQ processors and schedulers (same modules, no HTTP)
│  ├─ app.module.ts
│  ├─ config/
│  │  ├─ env.ts                      ← zod-validated environment (fails fast on a missing secret)
│  │  └─ app-config.service.ts       ← reads app_config (fee %, cutoffs) with caching
│  ├─ common/
│  │  ├─ auth/                       ← jwt.strategy, roles.decorator, current-user.decorator, policy.guard
│  │  ├─ errors/                     ← AppError codes + simple-English messages, exception filter
│  │  ├─ http/                       ← idempotency.interceptor (Postgres-backed), etag.interceptor, app-version.guard, pagination.ts
│  │  ├─ money/                      ← split.ts (the one 10% rounding rule), paise formatting
│  │  ├─ resilience/                 ← circuit-breaker.ts, retry.ts (backoff + jitter), timeouts
│  │  ├─ time/                       ← ist.ts (IST date and hour helpers), clock.ts (injectable, for tests)
│  │  └─ validation/                 ← zod/class-validator pipes
│  ├─ infra/
│  │  ├─ db/                         ← db.service.ts (pool, TLS, `as(identity, fn)`), schema.ts (generated types) ✅ built
│  │  ├─ redis/                      ← redis.service, cache.ts (fail-open: a Redis error falls back to the DB)
│  │  ├─ queue/                      ← bullmq module, queue names, scheduler registrations
│  │  ├─ realtime/                   ← socket.io gateway, redis adapter, room auth
│  │  ├─ outbox/                     ← outbox.writer (inside transactions), outbox.relay (worker)
│  │  ├─ firebase/                   ← admin SDK: verify ID tokens, send FCM
│  │  ├─ razorpay/                   ← client, signature verify, orders, refunds, route transfers
│  │  ├─ storage/                    ← R2 client, presign, image resize
│  │  └─ mail/                       ← Resend client + templates
│  └─ modules/
│     ├─ auth/                       ← patient-exchange, doctor-password, refresh, logout; *.controller/service/dto/spec
│     ├─ users/                      ← me (patient profile), devices, notification prefs, account deletion
│     ├─ catalog/                    ← types, problems, emergency kinds, hospitals, /catalog bundle
│     ├─ doctors/                    ← public cards/search, doctor self-profile, photo, verification state
│     ├─ schedule/                   ← templates, leaves, session generator (+ generate.processor.ts)
│     ├─ availability/               ← days strip, windows, nextFree (read models + cache)
│     ├─ bookings/                   ← hold, confirm, reschedule, provider cancel, move, timeline
│     │  ├─ bookings.controller.ts
│     │  ├─ doctor-bookings.controller.ts
│     │  ├─ bookings.service.ts      ← orchestration only
│     │  ├─ booking.states.ts        ← allowed transitions (the §4.0 table), used by the service and mirrored by a DB trigger
│     │  ├─ booking-rules.ts         ← pure functions: canReschedule, holdLimits (unit- and property-tested)
│     │  ├─ confirm-booking.ts       ← the one shared confirm path for verify + webhook + late payments
│     │  ├─ slots.repository.ts      ← raw SQL: take lowest free slot (SKIP LOCKED), release, block
│     │  ├─ bookings.repository.ts
│     │  ├─ holds.processor.ts       ← expiry jobs
│     │  └─ dto/ , bookings.spec.ts , bookings.e2e-spec.ts , concurrency.e2e-spec.ts
│     ├─ payments/                   ← verify, retry, webhooks, refunds, transfers, reconcile processors
│     ├─ queue/                      ← console commands, live board, predictions, auto no-show
│     │  ├─ console.controller.ts
│     │  ├─ live.controller.ts + live.gateway.ts
│     │  ├─ queue.service.ts         ← command handling under the session row lock + expectedVersion
│     │  ├─ queue-rules.ts           ← pure: next patient, order keys, ETA range
│     │  └─ board.cache.ts
│     ├─ emergency/                  ← doctor status, patient "open now near you", expiry job
│     ├─ notifications/              ← in-app list, push/email senders, reminders and turn-alert processors
│     ├─ content/                    ← first-aid pages per emergency situation; publishing needs a doctor + confirmed WHO source
│     ├─ earnings/                   ← doctor earnings and reports (read models over transfers/queue_events)
│     ├─ support/
│     ├─ admin/                      ← admin controllers (doctor onboarding, refunds, content, config)
│     ├─ audit/                      ← audit writer used by other modules
│     ├─ config/                     ← remote config, kill switches, min app version (admin-editable, audited)
│     └─ health-checks/              ← invariants.processor.ts (§10), reconcile, /health and /ready endpoints
├─ test/
│  ├─ factories/                     ← build users, doctors, sessions quickly
│  ├─ setup.ts                       ← Testcontainers Postgres + Redis, fake Razorpay, fake Firebase, fixed clock
│  └─ e2e/                           ← full flows: book→pay→live→done; reschedule rules; provider cancel refunds
├─ Dockerfile                        ← one image; CMD picks api or worker
├─ fly.toml                          ← api (2 machines) + worker (1) in bom
├─ docker-compose.yml                ← local Postgres 16 + Redis + MinIO (R2 stand-in)
├─ .env.example
└─ package.json
```

**Module rule:** a module talks to another only through that module's exported service, never its repository
or tables. Cross-module side effects (for example "booking confirmed → notify") go through domain events
written to the outbox.

---

## 16. Connecting the Flutter app (without touching the screens)

The screens already read from Riverpod stores (`PatientStore`, `DoctorStore`, `DirectoryStore`, `SessionStore`).
We keep those store APIs and swap what is behind them.

```
app/lib/
├─ data/
│  ├─ api/
│  │  ├─ api_client.dart         ← Dio: base URL, auth + refresh interceptor, Idempotency-Key, retry with backoff, ETag cache
│  │  ├─ generated/              ← Dart models + endpoints generated from the backend's OpenAPI (openapi-generator, dio)
│  │  └─ errors.dart             ← maps error codes to the app's simple-English messages
│  ├─ live/
│  │  └─ live_client.dart        ← socket.io client, rooms, version-gap replay, polling fallback
│  ├─ push/
│  │  └─ push_service.dart       ← FCM token registration, taps open /booking/:id
│  ├─ payments/
│  │  └─ razorpay_checkout.dart  ← wraps razorpay_flutter for the Pay step
│  └─ repositories/
│     ├─ booking_repository.dart     (abstract)  ← MockBookingRepository (today's code) | ApiBookingRepository
│     ├─ doctor_repository.dart, catalog_repository.dart, queue_repository.dart, ...
└─ state/                         ← stores keep their public methods; internally call repositories
```

- **Switch with one flag:** `flutter run --dart-define=BACKEND=mock|staging|prod`. Mock keeps working for demos and
  for the widget tests we already have.
- **Order of migration:** catalog → doctors/availability → auth → bookings + payments → live line → doctor console →
  profile/photo → notifications/push → content. Each step ships behind the flag and is tested on the phone.
- **Resilience in the app:** persisted offline queue for doctor console commands; last-known booking and board
  cached with "Updated at…"; the emergency screen and its hospital list bundled and refreshed when online; automatic
  retry of idempotent writes with the same key; the "Please update OPflow" screen driven by `minSupportedVersion`.
- **What the user feels:** Home and lists appear from cache instantly; the live board moves by push, not
  pull-to-refresh; console taps respond immediately (optimistic) and reconcile quietly; the only full-screen
  OP loaders are payment and hold, exactly as today.

### 16.1 Error handling — the app must never crash

**Already built in the app (UI stage):**
- `main.dart` runs everything inside `runZonedGuarded`, with `FlutterError.onError`, `PlatformDispatcher.onError`
  and a Riverpod `ProviderObserver`. Every error is reported (`lib/core/errors.dart` → Sentry at B11) and none closes the app.
- A widget that fails to build shows a small "This part could not be shown" note, not a red or grey box.
  The rest of the screen keeps working.
- Links to things that don't exist (doctor, hospital, booking, emergency type, unknown address) open a
  friendly "We could not find this…" screen, with a way home.
- `context.popOr(fallback)` replaces `context.pop()`: "Back" on a screen opened directly from a link goes home
  instead of throwing.
- `runWithLoader` never throws. It times out after 30 s, reports the error, shows one calm sentence, and returns null.
- Double taps within 500 ms are ignored on every button and card, so nothing opens twice and nothing is paid twice.
- Broken or missing photos fall back to the monogram portrait.
- Tests open every screen at 1× and 1.5× text, every emergency first-aid page, and the bad links, and fail on any exception.

**When the backend is connected: one error contract, end to end.**

The server always answers errors in one shape, with a message already in the app's simple English:
```json
{ "error": { "code": "WINDOW_FULL", "message": "This time just got full. Please pick another.",
             "retryable": false, "requestId": "req_01J…" } }
```
The app's `api_client.dart` turns every response or exception into either data or an `AppFailure`.
Screens never see raw exceptions, status codes or stack traces.

| Situation | Code(s) | What the app does |
|---|---|---|
| No internet | (socket error) | Keep showing cached data with "Offline. Showing what we had at 10:42". Writes wait in a retry queue (console commands) or show "No internet. Please check your connection and try again." |
| Slow server | timeout (10 s reads, 20 s writes) | Retry idempotent requests twice (backoff 1 s, 3 s) with the same Idempotency-Key, then the calm message. |
| Session expired | 401 | Refresh the token once, silently, then repeat the request. If the refresh fails: go to login with "Please log in again." Parallel requests wait for the one refresh. |
| Not allowed | 403 | "You can't open this." and back to home. Reported (it may be a bug). |
| Gone or wrong id | 404 | The friendly "We could not find this…" screen. |
| Someone got there first | 409 `WINDOW_FULL`, `BOOKING_CHANGED`, `STALE_BOARD` | Refresh that screen's data, then show the server's sentence. For example, the time list reloads with that hour marked Full. |
| A rule says no | 422 `RESCHEDULE_NOT_ALLOWED`, `HOLD_LIMIT`, `IDEMPOTENCY_MISMATCH` | Show the server's sentence next to the button. Nothing else changes. |
| App too old | 426 `UPGRADE_REQUIRED` | The "Please update OPflow" screen with a store link. |
| Too many tries | 429 | "Too many tries. Please wait a minute and try again." Buttons disabled for the `Retry-After` time. |
| Feature switched off | 503 `FEATURE_OFF` (kill switch) | The server's maintenance sentence; the rest of the app works. |
| Server error | 500, 502, 503, 504 | Idempotent: retry as for timeouts. Otherwise: "Something went wrong. Please try again." The error is sent to Sentry with its `requestId`. |
| Payment sheet closed or failed | Razorpay callbacks | "Payment did not go through. No money was taken." + Try again. The hold timer keeps counting. |
| Payment done but verify failed (network) | — | Never show "failed". Show "Checking your payment…" and poll `GET /bookings/:id` for 60 s. The webhook confirms on the server side (§4.1). If still pending: "We are checking your payment. You will get a message in a few minutes." |
| Push or socket lost | — | Silent reconnect and polling (§4.4). No error shown unless offline for over 30 s. |

**Every data screen has four states:** loading (skeleton or OP loader), content, empty (friendly text + next step),
and error (calm sentence + **Try again**). `AsyncValue` in Riverpod maps to these; a shared `AsyncView` widget
renders them the same way everywhere, so no screen can forget one.

**Server side, never crash and never leak:**
- A global Nest exception filter maps every error to the shape above. Unknown errors → 500 with the generic
  sentence; the stack trace goes to logs and Sentry, **never** to the client.
- Input is validated at the edge (zod/class-validator). Bad input → 400 with field-level messages in simple English.
- `process.on('unhandledRejection' | 'uncaughtException')` → log, report, and let the orchestrator restart the instance
  gracefully (other instances keep serving). Workers retry the failed job.
- Every request gets an `X-Request-Id`, returned in errors and logged everywhere, so a patient's "Report a problem"
  can be traced in one search.
- Sentry scrubs personal data (phone, names, notes) before sending.

---

## 17. Testing strategy

| Level | What | Tools |
|---|---|---|
| Unit | `booking-rules.ts`, `queue-rules.ts`, fee maths (paise rounding), IST date helpers, ETA | Jest (fast, no DB) |
| Integration | Repositories and SQL against real Postgres + Redis | Testcontainers |
| **Concurrency** | 200 parallel holds on a window with 8 places → exactly 8 confirmed, 0 oversold; 50 parallel CALL NEXT → consistent order | e2e with `Promise.all` |
| e2e | Every row in the API table; cross-account access attempts (must be 403/404) | supertest |
| Payments | Signature valid/invalid, duplicate webhook, late webhook after expiry, refund flow | Razorpay test mode + recorded payloads |
| Contract | OpenAPI diff in CI; the Flutter generated client must compile | openapi-diff |
| Load | 500 patients watching one session board; 50 bookings/s on hold | k6, before the pilot |
| State machines | Every transition not in the §4.0 table is refused (code and DB trigger) | table-driven tests |
| Property-based | Random sequences of hold / pay / expire / reschedule / cancel / console commands never break the §10 invariants | fast-check |
| Chaos | Kill the worker mid "cancel whole day"; drop Redis during bookings; delay webhooks 10 min; duplicate every webhook; Razorpay 500s | Toxiproxy + scripted scenarios in staging |
| Clock | "2 hours before", hold expiry and auto no-show tested with an injected clock, including across midnight IST | fixed-clock provider |
| App | Existing widget tests with mock repositories; one integration test against staging | flutter test |

---

## 18. Environments & operations

- **local:** `docker compose up` (Postgres, Redis, MinIO) + `dbmate up` + `npm run dev` (api) + `npm run worker`; seeded demo data
  (`OPD-10234 / demo1234`).
- **staging:** Fly.io `bom` + Supabase staging DB + Upstash + Razorpay **test mode**; `deploy.bat` builds the app
  against staging for demos.
- **prod:** same shape, Razorpay live keys, daily backups + point-in-time recovery (7 days), restore drill monthly.
- **Migrations:** `dbmate up` in CI before deploy (then `npm run db:types` to refresh the TypeScript types); expand → migrate data → contract, for zero-downtime changes. Rules in `backend/migrations/README.md`.
- **Alerts:** Sentry errors; uptime on `/health`; queue backlog > 1 min; webhook failures; payment reconcile mismatch;
  p95 latency > 500 ms.

---

## 19. Build order (milestones)

| # | Milestone | Done when |
|---|---|---|
| B1 ✅ | Skeleton: Nest app, checked config, **SQL migrations**, Kysely + generated types, identity-aware DB access, error format, request ids, `/health`, `/ready`, `GET /v1/catalog`, Docker, Fly config, CI — *done 25 Sep 2026; seed of demo doctors moves to B3* | `GET /catalog` returns the same data the app shows today |
| B2 ✅ | Auth: patient exchange, doctor login + forced change, refresh rotation, admin skeleton | The app logs in against staging |
| B3 ✅ | Doctors, hospitals, search, availability (read side) | Home, Find, doctor page and day/time pickers run on real data |
| B4 ✅ | Schedule templates, leaves, session generator | Doctor's "My timings" saves and patients see the new hours |
| B5 ✅ | **Bookings + Razorpay (test mode)**: slots, hold, shared confirm path, webhook, expiry sweeper, late/duplicate payments, reschedule, provider cancel + refunds | Concurrency + property tests green; full book → pay → receipt on the phone; invariants job reports zero issues |
| B6 ✅ | **Live line**: console commands, board cache, WS, gap replay, predictions, offline console queue | Two phones: doctor taps CALL NEXT, the patient board flips within 1 s |
| B7 ✅ | Notifications: outbox relay, FCM, reminders, turn alerts, email receipts | Pushes arrive with the app closed |
| B8 ✅ | Doctor profile + photo upload (R2), emergency status, earnings (Route transfers), reports | The doctor's photo appears on patient cards from the CDN |
| B9 ✅ | First-aid content API + admin publishing with doctor review | Emergency Do's and Don'ts served from the server (the bundled copy stays as offline backup) |
| B10 ✅ | Admin API (all of `admin/docs/ADMIN_PORTAL.md` §5): doctor onboarding (issue login ID), verification, refunds, audit | OPflow staff can onboard a real doctor |
| B11 | Hardening: failure-mode drills (§9), kill switches, min-version screen, SLO dashboards + alerts, runbooks, load test, pen test, DPDP checklist, restore drill, Razorpay live | Every §9 row tested in staging; pilot go-live with one doctor |


**Status (25 Sep 2026): B2–B10 are built** (backend only; the admin website's screens come next). Verified by
26 end-to-end journeys through the real HTTP API, WebSocket and worker (`npm run test:flow`, also in CI against a
throwaway Postgres with every migration), 23 unit tests, and 7 checks against the live Supabase database.
What still needs outside accounts before go-live: Firebase (OTP + push), Razorpay keys (test, then live) and
Route activation, Cloudflare R2, Resend, MSG91 (DLT template), Redis (only for 2+ API machines), Sentry.
Until then each has a local stand-in that is refused outside `APP_ENV=local`.
Deliberate differences from the plan above: background jobs use the Postgres outbox + `job_leases` (no BullMQ);
Redis is optional (rate limits and live signals fall back to in-process); Firebase tokens are verified with
Google's public certificates directly (no firebase-admin SDK).

---

## 20. Decisions to confirm

1. **Hosting:** ~~database~~ **decided: Supabase Postgres (Mumbai)**. Still open: the API/worker host — Fly.io Mumbai (simplest, assumed) or AWS ap-south-1.
2. **Patient OTP:** Firebase Phone Auth for the pilot (assumed), then MSG91 with DLT at scale.
3. **Payout timing:** the doctor's 90% is released **24 h after the OPD session** (assumed). A shorter hold means faster
   money for doctors, but harder refunds on late cancellations.
4. **No-show auto-marking:** after 60 minutes past the window (assumed). The doctor can always undo.
5. **"Move them to another day":** patients get 48 h to pick a new time, else a full refund (assumed).
