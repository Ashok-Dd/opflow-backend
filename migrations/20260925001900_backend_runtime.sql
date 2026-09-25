-- migrate:up

-- What the full backend (B2–B10) needs on top of the schema so far. Small, additive changes only.

-- 1. Admin sign-in: lockout after 5 wrong tries, last login, and TOTP replay protection
--    (a 6-digit code is accepted once, never twice).
alter table admin_users
  add column failed_attempts  smallint not null default 0 check (failed_attempts >= 0),
  add column locked_until     timestamptz,
  add column last_login_at    timestamptz,
  add column totp_last_step   bigint;

-- One-time setup links for new admins (valid 24 h). The link holds only a hash; the new TOTP secret waits
-- here (encrypted) until the admin proves they scanned it.
create table admin_setup_tokens (
  token_hash       bytea primary key,                       -- sha256 of the link token
  admin_id         uuid not null references admin_users(id) on delete cascade,
  totp_secret_enc  bytea not null,
  expires_at       timestamptz not null,
  used_at          timestamptz,
  created_at       timestamptz not null default now()
);
create index admin_setup_tokens_admin_idx on admin_setup_tokens (admin_id);

-- 2. A refresh token remembers which app login it belongs to (the same person can be a patient and a doctor).
alter table refresh_tokens
  add column role user_role,
  add constraint refresh_tokens_role_matches check ((user_id is null) = (role is null));

-- 3. Each session keeps its own booking cut-off, so later timing changes don't move it.
alter table opd_sessions
  add column close_minutes_before smallint not null default 30 check (close_minutes_before between 0 and 240);

-- 4. "Move them to another day": the booking stays paid and confirmed, and the patient picks a new time.
--    Not picked within 48 h → full refund (worker).
alter table bookings add column needs_new_time_since timestamptz;
create index bookings_needs_new_time_idx on bookings (needs_new_time_since) where needs_new_time_since is not null;

-- 5. Refunds paid by hand (bank transfer with a UTR number) when the Razorpay route keeps failing.
alter table refunds add column manual_reference varchar(40);

-- 6. Background jobs: one runner at a time per job, across any number of worker machines.
create table job_leases (
  name              varchar(60) primary key,
  locked_until      timestamptz not null default '-infinity',
  last_started_at   timestamptz,
  last_finished_at  timestamptz,
  last_error        text
);

-- The API login may use the new tables (default privileges already cover them; stated for clarity).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'opflow_api') then
    grant select, insert, update, delete on admin_setup_tokens, job_leases to opflow_api;
  end if;
end
$$;

-- migrate:down

drop table if exists job_leases;
alter table refunds drop column if exists manual_reference;
drop index if exists bookings_needs_new_time_idx;
alter table bookings drop column if exists needs_new_time_since;
alter table opd_sessions drop column if exists close_minutes_before;
alter table refresh_tokens drop constraint if exists refresh_tokens_role_matches, drop column if exists role;
drop table if exists admin_setup_tokens;
alter table admin_users
  drop column if exists failed_attempts,
  drop column if exists locked_until,
  drop column if exists last_login_at,
  drop column if exists totp_last_step;
