-- OPflow · 0400 · Patients. One phone account = one patient. No family members:
-- every booking is for the logged-in patient (bookings keep their own copy of name/age/gender).

-- migrate:up

create table patient_profiles (
  user_id     uuid primary key references users(id) on delete cascade,
  name        varchar(80) not null check (length(btrim(name)) >= 2),
  birth_year  smallint not null check (birth_year between 1900 and 2100),   -- store the year, show the age
  gender      gender not null,
  place       varchar(60),                                                    -- "Guntur"; used for nearby lists
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table notification_prefs (
  user_id         uuid primary key references users(id) on delete cascade,
  reminders       boolean not null default true,
  late_alerts     boolean not null default true,
  turn_alerts     boolean not null default true,
  email_receipts  boolean not null default true,
  updated_at      timestamptz not null default now()
);

-- migrate:down

drop table if exists notification_prefs;
drop table if exists patient_profiles;
