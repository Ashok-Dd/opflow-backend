-- OPflow · 1600 · Admin controls (admin/docs/ADMIN_PORTAL.md):
--   1. Only OPflow admins (or system jobs) can create doctors, their logins and hospital links.
--   2. A doctor can change only their own editable fields; locked fields are refused even if the API has a bug.
--   3. Two-person approval ("maker-checker"): the admin who asks can never be the admin who approves.
--   4. Doctor login IDs come from one sequence: OPD-10001, OPD-10002…

-- migrate:up

alter type admin_role add value if not exists 'content';     -- edits health tips; cannot touch doctors or money

alter table doctors
  add column created_by_admin uuid references admin_users(id),
  add column listed_at        timestamptz;                      -- first time the doctor became visible to patients

-- 4. Login IDs.
create sequence doctor_login_seq start 10001;
create or replace function next_doctor_login_id() returns text
language sql volatile as $$ select 'OPD-' || nextval('doctor_login_seq')::text $$;

-- 1. Only admins create doctors, their credentials and their hospital links.
create or replace function require_admin_to_create() returns trigger
language plpgsql as $$
begin
  if app_role() not in ('admin', 'system') then
    raise exception 'Only OPflow admins can add % (current role: %)', tg_table_name, app_role()
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;
create trigger doctors_admin_only_insert before insert on doctors
  for each row execute function require_admin_to_create();
create trigger doctor_credentials_admin_only_insert before insert on doctor_credentials
  for each row execute function require_admin_to_create();
create trigger doctor_hospitals_admin_only_insert before insert on doctor_hospitals
  for each row execute function require_admin_to_create();

-- 2. What a doctor may change on their own profile. Everything else is locked.
create or replace function guard_doctor_self_edit() returns trigger
language plpgsql as $$
begin
  if app_role() = 'doctor' and (
       new.name is distinct from old.name or
       new.type_id is distinct from old.type_id or
       new.degrees is distinct from old.degrees or
       new.reg_council is distinct from old.reg_council or
       new.reg_no is distinct from old.reg_no or
       new.user_id is distinct from old.user_id or
       new.verification is distinct from old.verification or
       new.verification_note is distinct from old.verification_note or
       new.verified_at is distinct from old.verified_at or
       new.verified_by is distinct from old.verified_by or
       new.status is distinct from old.status or
       new.created_by_admin is distinct from old.created_by_admin or
       new.listed_at is distinct from old.listed_at) then
    raise exception 'This detail can only be changed by the OPflow team'
      using errcode = 'insufficient_privilege',
            hint = 'Doctors can edit: gender, years_experience, languages, about, fee_paise, photo_key';
  end if;
  return new;
end
$$;
create trigger doctors_self_edit_guard before update on doctors
  for each row execute function guard_doctor_self_edit();

-- Row-level security on doctors: everyone may read (public profiles are filtered by the API);
-- a doctor updates only their own row; creating and deleting is for admins/system.
alter table doctors enable row level security;
alter table doctors force row level security;
create policy doctors_read on doctors for select using (true);
create policy doctors_self_update on doctors for update
  using (app_role() = 'doctor' and id = app_doctor_id())
  with check (app_role() = 'doctor' and id = app_doctor_id());
create policy doctors_staff_write on doctors
  using (app_role() in ('admin', 'system'))
  with check (app_role() in ('admin', 'system'));

-- 3. Two-person approval for risky actions.
create type approval_kind as enum (
  'verify_doctor',          -- make a doctor visible to patients
  'edit_doctor_locked',     -- name, type, degrees, registration
  'suspend_doctor',
  'refund_large',           -- admin goodwill refund above the limit
  'config_change',          -- fee %, cut-offs, kill switches, min app version
  'admin_user_change'       -- add/remove admins, change roles
);
create type approval_decision as enum ('pending', 'approved', 'rejected', 'expired');

create table approval_requests (
  id            uuid primary key default uuid_generate_v7(),
  kind          approval_kind not null,
  subject_type  varchar(40) not null,                        -- 'doctor', 'refund', 'app_config', 'admin_user'
  subject_id    text not null,
  payload       jsonb not null,                              -- the exact change to apply if approved
  reason        varchar(240) not null check (length(btrim(reason)) >= 5),
  requested_by  uuid not null references admin_users(id),
  requested_at  timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '72 hours',
  decision      approval_decision not null default 'pending',
  decided_by    uuid references admin_users(id),
  decided_at    timestamptz,
  decision_note varchar(240),
  constraint approvals_maker_is_not_checker check (decided_by is null or decided_by <> requested_by),
  constraint approvals_decided_consistent check ((decision in ('approved', 'rejected')) = (decided_by is not null and decided_at is not null))
);
-- At most one open request per subject and kind (no duplicate asks).
create unique index approvals_one_open on approval_requests (kind, subject_type, subject_id) where decision = 'pending';
create index approvals_pending_idx on approval_requests (requested_at) where decision = 'pending';

insert into allowed_transitions (entity, from_state, to_state) values
  ('approval_requests.decision', 'pending', 'approved'),
  ('approval_requests.decision', 'pending', 'rejected'),
  ('approval_requests.decision', 'pending', 'expired');
create trigger approval_requests_decision_transition before update of decision on approval_requests
  for each row execute function enforce_transition('decision');

-- The API login gets rights on the new objects (default privileges cover the table; the sequence needs this).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'opflow_api') then
    grant usage on sequence doctor_login_seq to opflow_api;
    grant execute on function next_doctor_login_id() to opflow_api;
  end if;
end
$$;

-- migrate:down

drop trigger if exists approval_requests_decision_transition on approval_requests;
delete from allowed_transitions where entity = 'approval_requests.decision';
drop table if exists approval_requests;
drop type if exists approval_decision;
drop type if exists approval_kind;
drop policy if exists doctors_staff_write on doctors;
drop policy if exists doctors_self_update on doctors;
drop policy if exists doctors_read on doctors;
alter table doctors no force row level security;
alter table doctors disable row level security;
drop trigger if exists doctors_self_edit_guard on doctors;
drop function if exists guard_doctor_self_edit();
drop trigger if exists doctor_hospitals_admin_only_insert on doctor_hospitals;
drop trigger if exists doctor_credentials_admin_only_insert on doctor_credentials;
drop trigger if exists doctors_admin_only_insert on doctors;
drop function if exists require_admin_to_create();
drop function if exists next_doctor_login_id();
drop sequence if exists doctor_login_seq;
alter table doctors drop column if exists listed_at, drop column if exists created_by_admin;
-- The 'content' admin role value stays: Postgres cannot remove an enum value.
