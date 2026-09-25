-- migrate:up

-- OPflow has exactly one admin (decided 25 Sep 2026). The database refuses a second active admin, so no bug or
-- script can add one. To hand over to another person, the current admin is switched off first
-- (`npm run admin:create -- --email … --name … --replace`). Two-person approvals are no longer used:
-- `approval_requests` stays (history) but nothing writes to it.
create unique index admin_users_only_one_active on admin_users ((true)) where status = 'active';

comment on table approval_requests is 'Not used since 2026-09-25 (one admin; changes apply at once and are recorded in audit_log).';

-- With one admin there is no "second approval" for large refunds: the limit rule no longer means anything.
delete from app_config where key = 'admin.large_refund_paise';

-- A doctor account can be signed in on at most this many devices. Signing in on one more signs out the device
-- used least recently (so a doctor who lost a phone is never locked out).
insert into app_config (key, value, description) values
  ('doctor.max_devices', '2'::jsonb, 'A doctor account can be signed in on at most this many devices at a time')
on conflict (key) do nothing;

-- Finding a person's live sessions quickly (device limit, "signed-in devices" list).
create index refresh_tokens_live_user_idx on refresh_tokens (user_id, role, family_id) where revoked_at is null;

-- migrate:down

drop index if exists refresh_tokens_live_user_idx;
delete from app_config where key = 'doctor.max_devices';
insert into app_config (key, value, description) values
  ('admin.large_refund_paise', '200000'::jsonb, 'Admin goodwill refunds above this (in paise; 200000 = ₹2,000) need a second admin''s approval')
on conflict (key) do nothing;
comment on table approval_requests is null;
drop index if exists admin_users_only_one_active;
