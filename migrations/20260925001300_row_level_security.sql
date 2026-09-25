-- OPflow · 1300 · Row-level security on patient data (defence in depth, ARCHITECTURE.md §8.1).
--
-- The API sets, at the start of every transaction:
--   set_config('app.role', 'patient' | 'doctor' | 'admin' | 'system', true)
--   set_config('app.user_id', '<users.id>', true)        -- patients and doctors
--   set_config('app.doctor_id', '<doctors.id>', true)    -- doctors
-- Workers and migrations that touch these tables use app.role = 'system'.
-- FORCE makes the rules apply to the table owner too, so even a missed `where` in code cannot leak rows.

-- migrate:up

-- Bookings: a patient sees their own; a doctor sees bookings for their sessions; admin/system see all.
alter table bookings enable row level security;
alter table bookings force row level security;
create policy bookings_patient on bookings
  using (app_role() = 'patient' and patient_user_id = app_user_id())
  with check (app_role() = 'patient' and patient_user_id = app_user_id());
create policy bookings_doctor on bookings
  using (app_role() = 'doctor' and doctor_id = app_doctor_id())
  with check (app_role() = 'doctor' and doctor_id = app_doctor_id());
create policy bookings_staff on bookings
  using (app_role() in ('admin', 'system'))
  with check (app_role() in ('admin', 'system'));

-- Patient profiles: only the patient themselves (doctors see the copy on each booking instead).
alter table patient_profiles enable row level security;
alter table patient_profiles force row level security;
create policy patient_profiles_self on patient_profiles
  using (app_role() = 'patient' and user_id = app_user_id())
  with check (app_role() = 'patient' and user_id = app_user_id());
create policy patient_profiles_staff on patient_profiles
  using (app_role() in ('admin', 'system'))
  with check (app_role() in ('admin', 'system'));

-- Notifications: each account reads its own.
alter table notifications enable row level security;
alter table notifications force row level security;
create policy notifications_self on notifications
  using (app_role() in ('patient', 'doctor') and user_id = app_user_id())
  with check (app_role() in ('patient', 'doctor') and user_id = app_user_id());
create policy notifications_staff on notifications
  using (app_role() in ('admin', 'system'))
  with check (app_role() in ('admin', 'system'));

-- Queue entries: the doctor of the session; a patient only their own entry; staff all.
alter table queue_entries enable row level security;
alter table queue_entries force row level security;
create policy queue_entries_doctor on queue_entries
  using (app_role() = 'doctor'
         and exists (select 1 from opd_sessions s where s.id = queue_entries.session_id and s.doctor_id = app_doctor_id()))
  with check (app_role() = 'doctor'
         and exists (select 1 from opd_sessions s where s.id = queue_entries.session_id and s.doctor_id = app_doctor_id()));
create policy queue_entries_patient on queue_entries for select
  using (app_role() = 'patient'
         and exists (select 1 from bookings b where b.id = queue_entries.booking_id and b.patient_user_id = app_user_id()));
create policy queue_entries_staff on queue_entries
  using (app_role() in ('admin', 'system'))
  with check (app_role() in ('admin', 'system'));

-- migrate:down

drop policy if exists queue_entries_staff on queue_entries;
drop policy if exists queue_entries_patient on queue_entries;
drop policy if exists queue_entries_doctor on queue_entries;
alter table queue_entries no force row level security;
alter table queue_entries disable row level security;
drop policy if exists notifications_staff on notifications;
drop policy if exists notifications_self on notifications;
alter table notifications no force row level security;
alter table notifications disable row level security;
drop policy if exists patient_profiles_staff on patient_profiles;
drop policy if exists patient_profiles_self on patient_profiles;
alter table patient_profiles no force row level security;
alter table patient_profiles disable row level security;
drop policy if exists bookings_staff on bookings;
drop policy if exists bookings_doctor on bookings;
drop policy if exists bookings_patient on bookings;
alter table bookings no force row level security;
alter table bookings disable row level security;
