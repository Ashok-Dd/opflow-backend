-- OPflow · 0700 · Schedule: weekly templates, leave days, OPD sessions, hour windows and ONE ROW PER PLACE.
-- window_slots is what makes overbooking impossible (see ARCHITECTURE.md §3.5).

-- migrate:up

-- The doctor's weekly plan per hospital ("My timings" in the app). Times are IST wall-clock.
create table schedule_templates (
  id                    uuid primary key default uuid_generate_v7(),
  doctor_id             uuid not null,
  hospital_id           uuid not null,
  weekday               smallint not null check (weekday between 1 and 7),        -- 1 = Monday
  start_time            time not null,
  end_time              time not null,
  start_minute          smallint generated always as
                          ((extract(hour from start_time) * 60 + extract(minute from start_time))::smallint) stored,
  end_minute            smallint generated always as
                          ((extract(hour from end_time) * 60 + extract(minute from end_time))::smallint) stored,
  window_minutes        smallint not null default 60 check (window_minutes in (30, 60)),
  online_per_window     smallint not null check (online_per_window between 1 and 20),   -- "Patients per hour"
  direct_places         smallint not null default 10 check (direct_places between 0 and 60),
  take_emergency        boolean not null default true,
  avg_consult_minutes   smallint not null default 7 check (avg_consult_minutes between 1 and 60),
  open_days_ahead       smallint not null default 14 check (open_days_ahead between 1 and 60),
  close_minutes_before  smallint not null default 30 check (close_minutes_before between 0 and 240),
  valid_from            date not null default current_date,
  valid_to              date,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  foreign key (doctor_id, hospital_id) references doctor_hospitals (doctor_id, hospital_id) on delete cascade,
  constraint schedule_end_after_start check (end_time > start_time),
  constraint schedule_whole_windows
    check (extract(epoch from (end_time - start_time))::int % (window_minutes * 60) = 0),
  constraint schedule_valid_range check (valid_to is null or valid_to >= valid_from),
  -- One doctor cannot have two overlapping blocks on the same weekday, at ANY hospital.
  constraint schedule_no_overlap exclude using gist (
    doctor_id with =,
    weekday with =,
    int4range(start_minute, end_minute) with &&,
    daterange(valid_from, valid_to, '[]') with &&
  )
);

create table doctor_leaves (
  id           uuid primary key default uuid_generate_v7(),
  doctor_id    uuid not null references doctors(id) on delete cascade,
  hospital_id  uuid references hospitals(id),               -- null = on leave at every hospital
  date         date not null,
  reason       varchar(120),
  created_by   uuid,                                        -- doctor's user id or admin id
  created_at   timestamptz not null default now()
);
create unique index doctor_leaves_unique on doctor_leaves
  (doctor_id, coalesce(hospital_id, '00000000-0000-0000-0000-000000000000'::uuid), date);

-- One real OPD on one date, generated from a template.
create table opd_sessions (
  id                    uuid primary key default uuid_generate_v7(),
  doctor_id             uuid not null,
  hospital_id           uuid not null,
  template_id           uuid references schedule_templates(id) on delete set null,
  date                  date not null,                      -- IST date
  starts_at             timestamptz not null,
  ends_at               timestamptz not null,
  status                session_status not null default 'scheduled',
  late_minutes          smallint not null default 0 check (late_minutes between 0 and 600),
  started_at            timestamptz,
  ended_at              timestamptz,
  avg_consult_sec       integer not null default 420 check (avg_consult_sec > 0),   -- EWMA, starts at 7 min
  now_seeing_token      integer,
  next_direct_token     integer not null default 1 check (next_direct_token >= 1),     -- D1, D2…
  next_emergency_token  integer not null default 1 check (next_emergency_token >= 1),  -- E1, E2…
  direct_places         smallint not null default 10 check (direct_places >= 0),
  version               integer not null default 0 check (version >= 0),   -- bumps on every live change
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  foreign key (doctor_id, hospital_id) references doctor_hospitals (doctor_id, hospital_id),
  constraint sessions_end_after_start check (ends_at > starts_at),
  constraint sessions_started_consistent check (status = 'scheduled' or status = 'cancelled' or started_at is not null),
  constraint sessions_unique unique (doctor_id, hospital_id, date, starts_at),
  -- One doctor, one place at a time, across all hospitals.
  constraint sessions_no_overlap exclude using gist (
    doctor_id with =,
    tstzrange(starts_at, ends_at) with &&
  ) where (status <> 'cancelled')
);
create index opd_sessions_hospital_date_idx on opd_sessions (hospital_id, date);
create index opd_sessions_doctor_date_idx   on opd_sessions (doctor_id, date);
create index opd_sessions_live_idx          on opd_sessions (status) where status in ('running', 'paused');

-- One hour inside a session. Owns a fixed token range sized for 20 places:
-- window k → tokens (20k + 1) … (20k + 20); only `capacity` of them exist as slots at first.
create table opd_windows (
  id           uuid primary key default uuid_generate_v7(),
  session_id   uuid not null references opd_sessions(id) on delete cascade,
  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  capacity     smallint not null check (capacity between 0 and 20),
  token_start  integer not null check (token_start >= 1 and (token_start - 1) % 20 = 0),
  status       window_status not null default 'open',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint windows_end_after_start check (ends_at > starts_at),
  constraint windows_unique_start unique (session_id, starts_at),
  constraint windows_unique_tokens unique (session_id, token_start),
  constraint windows_session_token_unique unique (id, token_start)      -- lets slots check their range
);
create index opd_windows_open_idx on opd_windows (starts_at) where status = 'open';

-- ONE ROW PER PLACE. The token is the place. Taking a place:
--   update window_slots set state='held', … where (window_id, token) = (
--     select window_id, token from window_slots where window_id=$1 and state='free'
--     order by token limit 1 for update skip locked) returning token;
create table window_slots (
  window_id    uuid not null references opd_windows(id) on delete cascade,
  token        integer not null check (token >= 1),
  state        slot_state not null default 'free',
  booking_id   uuid,                                        -- FK added in the bookings migration
  held_until   timestamptz,
  version      integer not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (window_id, token),
  constraint slots_booking_matches_state check ((state in ('free', 'blocked')) = (booking_id is null)),
  constraint slots_hold_has_expiry check (state <> 'held' or held_until is not null)
);
create index window_slots_free_idx on window_slots (window_id, token) where state = 'free';
create index window_slots_held_idx on window_slots (held_until) where state = 'held';

-- A slot's token must fall inside its window's range (token_start … token_start + 19).
create or replace function check_slot_in_range() returns trigger
language plpgsql as $$
declare
  ts integer;
begin
  select token_start into ts from opd_windows where id = new.window_id;
  if new.token < ts or new.token > ts + 19 then
    raise exception 'Token % is outside the range of window % (% – %)', new.token, new.window_id, ts, ts + 19
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger window_slots_in_range before insert or update of token, window_id on window_slots
  for each row execute function check_slot_in_range();

-- migrate:down

drop trigger if exists window_slots_in_range on window_slots;
drop function if exists check_slot_in_range();
drop table if exists window_slots;
drop table if exists opd_windows;
drop table if exists opd_sessions;
drop table if exists doctor_leaves;
drop table if exists schedule_templates;
