-- migrate:up

-- 1. Row-level security on money and devices (defence in depth, like bookings in …001300).
--    The API already filters these; now the database also refuses to show one person's payments,
--    refunds, payouts or phone push tokens to another, even if a query forgets a "where".
--    Payments and refunds follow their booking: whoever can see the booking (its patient, its doctor,
--    staff) can see its money. Doctors see only their own payouts.

alter table payments enable row level security;
alter table payments force row level security;
create policy payments_owner on payments
  using (app_role() in ('patient', 'doctor') and exists (select 1 from bookings b where b.id = payments.booking_id))
  with check (app_role() in ('patient', 'doctor') and exists (select 1 from bookings b where b.id = payments.booking_id));
create policy payments_staff on payments
  using (app_role() in ('admin', 'system'))
  with check (app_role() in ('admin', 'system'));

alter table refunds enable row level security;
alter table refunds force row level security;
create policy refunds_owner on refunds
  using (app_role() in ('patient', 'doctor') and exists (select 1 from payments p where p.id = refunds.payment_id))
  with check (app_role() in ('patient', 'doctor') and exists (select 1 from payments p where p.id = refunds.payment_id));
create policy refunds_staff on refunds
  using (app_role() in ('admin', 'system'))
  with check (app_role() in ('admin', 'system'));

alter table transfers enable row level security;
alter table transfers force row level security;
create policy transfers_doctor on transfers
  using (app_role() = 'doctor' and doctor_id = app_doctor_id())
  with check (app_role() = 'doctor' and doctor_id = app_doctor_id());
-- A patient's change of time moves the payout date of their own booking's transfer.
create policy transfers_patient on transfers
  using (app_role() = 'patient' and exists (select 1 from payments p where p.id = transfers.payment_id))
  with check (app_role() = 'patient' and exists (select 1 from payments p where p.id = transfers.payment_id));
create policy transfers_staff on transfers
  using (app_role() in ('admin', 'system'))
  with check (app_role() in ('admin', 'system'));

alter table devices enable row level security;
alter table devices force row level security;
create policy devices_self on devices
  using (app_role() in ('patient', 'doctor') and user_id = app_user_id())
  with check (app_role() in ('patient', 'doctor') and user_id = app_user_id());
create policy devices_staff on devices
  using (app_role() in ('admin', 'system'))
  with check (app_role() in ('admin', 'system'));

-- 2. The goodwill-refund limit becomes a visible rule (admins change it through approval).
insert into app_config (key, value, description) values
  ('admin.large_refund_paise', '200000'::jsonb, 'Admin goodwill refunds above this (in paise; 200000 = ₹2,000) need a second admin''s approval')
on conflict (key) do nothing;

-- 3. Signing an admin out everywhere / checking their live sessions.
create index refresh_tokens_admin_idx on refresh_tokens (admin_id) where revoked_at is null;

-- migrate:down

drop index if exists refresh_tokens_admin_idx;
delete from app_config where key = 'admin.large_refund_paise';
drop policy if exists devices_staff on devices;
drop policy if exists devices_self on devices;
alter table devices no force row level security;
alter table devices disable row level security;
drop policy if exists transfers_staff on transfers;
drop policy if exists transfers_patient on transfers;
drop policy if exists transfers_doctor on transfers;
alter table transfers no force row level security;
alter table transfers disable row level security;
drop policy if exists refunds_staff on refunds;
drop policy if exists refunds_owner on refunds;
alter table refunds no force row level security;
alter table refunds disable row level security;
drop policy if exists payments_staff on payments;
drop policy if exists payments_owner on payments;
alter table payments no force row level security;
alter table payments disable row level security;
