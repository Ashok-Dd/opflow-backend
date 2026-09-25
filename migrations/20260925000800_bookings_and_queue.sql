-- OPflow · 0800 · Bookings, the live line (queue entries) and their append-only histories.

-- migrate:up

create table bookings (
  id                  uuid primary key default uuid_generate_v7(),
  code                varchar(10) not null unique check (code ~ '^OPF[0-9A-Z]{5,7}$'),   -- on receipts
  -- Who. Online bookings belong to a patient account; direct/emergency patients may have none.
  patient_user_id     uuid references users(id),
  patient_name        varchar(80) not null,                -- copy at booking time (no family members)
  patient_age         smallint check (patient_age between 0 and 120),
  patient_gender      gender,
  walk_in_phone       varchar(15) check (walk_in_phone ~ '^\+[1-9][0-9]{7,14}$'),
  -- Where and when.
  doctor_id           uuid not null references doctors(id),
  hospital_id         uuid not null references hospitals(id),
  session_id          uuid not null references opd_sessions(id),
  session_date        date not null,                       -- denormalised for "one booking per doctor per day"
  window_id           uuid references opd_windows(id),     -- the hour (direct/emergency: the hour they came)
  source              booking_source not null,
  token               integer not null check (token >= 1), -- online: slot token; direct: D-number; emergency: E-number
  slot_token          integer generated always as (case when source = 'online' then token end) stored,
  -- State and money.
  status              booking_status not null,
  hold_expires_at     timestamptz,
  fee_paise           integer not null check (fee_paise >= 0),                      -- price locked at hold time
  platform_fee_paise  integer not null default 0
                        check (platform_fee_paise >= 0 and platform_fee_paise <= fee_paise), -- OPflow's 10%
  note                varchar(140) not null default '',
  reschedule_count    smallint not null default 0 check (reschedule_count between 0 and 1),
  rescheduled_at      timestamptz,
  confirmed_at        timestamptz,
  completed_at        timestamptz,
  cancelled_at        timestamptz,
  cancelled_by        uuid,
  cancelled_reason    varchar(120),
  idempotency_key     varchar(64),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint bookings_online_has_patient check (source <> 'online' or patient_user_id is not null),
  constraint bookings_online_has_window  check (source <> 'online' or window_id is not null),
  constraint bookings_hold_has_expiry    check (status <> 'pending_payment' or hold_expires_at is not null),
  constraint bookings_pending_is_online  check (status <> 'pending_payment' or source = 'online'),
  constraint bookings_fee_split_online   check (source <> 'online' or platform_fee_paise = floor(fee_paise * 10 / 100)),
  constraint bookings_cancel_consistent  check ((status = 'cancelled_by_provider') = (cancelled_at is not null)),
  constraint bookings_idempotency_unique unique (patient_user_id, idempotency_key),
  -- An online booking points at exactly one place. Deferred so a booking and its slot can change in one transaction.
  constraint bookings_slot_fk foreign key (window_id, slot_token)
    references window_slots (window_id, token) deferrable initially deferred
);
-- Two live bookings can never share a token in the same series (online 11, D11 and E11 can coexist).
create unique index bookings_live_token_unique on bookings (session_id, source, token)
  where status in ('pending_payment', 'confirmed', 'completed', 'no_show');
-- Anti-hoarding: one live online booking per patient per doctor per day.
create unique index bookings_one_per_doctor_day on bookings (patient_user_id, doctor_id, session_date)
  where source = 'online' and status in ('pending_payment', 'confirmed');
create index bookings_patient_idx      on bookings (patient_user_id, created_at desc);
create index bookings_session_idx      on bookings (session_id, status);
create index bookings_doctor_date_idx  on bookings (doctor_id, session_date);
create index bookings_holds_idx        on bookings (hold_expires_at) where status = 'pending_payment';

-- Now that bookings exist, slots can point back at them.
alter table window_slots
  add constraint window_slots_booking_fk foreign key (booking_id)
  references bookings (id) deferrable initially deferred;
create unique index window_slots_one_per_booking on window_slots (booking_id) where booking_id is not null;

-- The live line: one entry per booking on the day.
create table queue_entries (
  booking_id   uuid primary key references bookings(id) on delete cascade,
  session_id   uuid not null references opd_sessions(id) on delete cascade,
  state        queue_state not null default 'not_come',
  order_key    numeric not null,        -- emergency = min − 1, skip/put-back = max + 1; never renumbered
  reached_at   timestamptz,
  called_at    timestamptz,
  done_at      timestamptz,
  updated_at   timestamptz not null default now(),
  constraint queue_called_has_time check (state not in ('with_doctor', 'done') or called_at is not null)
);
create index queue_entries_line_idx on queue_entries (session_id, state, order_key);
-- Only one patient can be with the doctor at a time.
create unique index queue_one_with_doctor on queue_entries (session_id) where state = 'with_doctor';

-- Append-only histories. Never updated or deleted (see the triggers migration).
create table booking_events (
  id          bigint generated always as identity primary key,
  booking_id  uuid not null references bookings(id) on delete cascade,
  type        varchar(40) not null,     -- held, confirmed, expired, rescheduled, cancelled_by_provider, refund_started…
  actor_type  actor_type not null,
  actor_id    uuid,
  data        jsonb not null default '{}',
  at          timestamptz not null default now()
);
create index booking_events_booking_idx on booking_events (booking_id, at);

create table queue_events (
  id          bigint generated always as identity primary key,
  session_id  uuid not null references opd_sessions(id) on delete cascade,
  version     integer not null check (version >= 1),
  type        varchar(40) not null,     -- start, call_next, done, skip, late, pause, add_direct…
  booking_id  uuid references bookings(id) on delete set null,
  actor_id    uuid,
  data        jsonb not null default '{}',
  at          timestamptz not null default now(),
  constraint queue_events_version_unique unique (session_id, version)   -- gap-free replay for phones
);

-- migrate:down

drop table if exists queue_events;
drop table if exists booking_events;
drop table if exists queue_entries;
drop index if exists window_slots_one_per_booking;
alter table if exists window_slots drop constraint if exists window_slots_booking_fk;
drop table if exists bookings;
