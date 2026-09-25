-- OPflow · 1800 · App changes of 25 Sep 2026:
--   1. Doctors can pause new bookings (patients can't book until they resume; existing bookings stay).
--   2. Emergency consultation: the patient pays the doctor's fee + an emergency charge. The charge is all
--      OPflow's; the fee is split as usual (90% doctor, 10% OPflow). Emergency bookings are paid online like
--      normal ones and get E-tokens.
--   3. Doctors cannot add patients: no more "direct" (walk-in) bookings.
--   4. The "on call" emergency status is no longer used.
-- The database enforces the money: payment = fee + charge; doctor's transfer = 90% of the fee only.

-- migrate:up

-- 1. Pause bookings (editable by the doctor: not one of the locked fields in the …001600 guard).
alter table doctors
  add column bookings_paused    boolean not null default false,
  add column bookings_paused_at timestamptz,
  add constraint doctors_paused_time check (bookings_paused = (bookings_paused_at is not null));

-- 2. Emergency consultation.
alter table bookings
  add column emergency_charge_paise integer not null default 0 check (emergency_charge_paise >= 0),
  add constraint bookings_emergency_charge_only_emergency
    check ((source = 'emergency') = (emergency_charge_paise > 0));

-- Every booking is now paid in the app, so every booking has a patient account and starts unpaid.
alter table bookings
  drop constraint bookings_online_has_patient,
  add constraint bookings_has_patient check (patient_user_id is not null),
  drop constraint bookings_pending_is_online,
  -- 10% of the doctor's fee for every booking (the emergency charge is separate and all OPflow's).
  drop constraint bookings_fee_split_online,
  add constraint bookings_fee_split check (platform_fee_paise = floor(fee_paise * 10 / 100));

-- One live emergency consultation per patient per doctor per day (like the rule for normal bookings).
create unique index bookings_one_emergency_per_doctor_day on bookings (patient_user_id, doctor_id, session_date)
  where source = 'emergency' and status in ('pending_payment', 'confirmed');

create or replace function check_booking_initial_status() returns trigger
language plpgsql as $$
begin
  if new.source not in ('online', 'emergency') then
    raise exception 'Doctors cannot add patients: every booking comes from the app (source "%")', new.source
      using errcode = 'check_violation';
  end if;
  if new.status <> 'pending_payment' then
    raise exception 'A new booking must start unpaid (pending_payment), not "%"', new.status using errcode = 'check_violation';
  end if;
  return new;
end
$$;

-- Payment amount = what the patient owes: doctor's fee + emergency charge.
create or replace function check_payment_amount() returns trigger
language plpgsql as $$
declare
  owed integer;
begin
  select fee_paise + emergency_charge_paise into owed from bookings where id = new.booking_id;
  if new.amount_paise <> owed then
    raise exception 'Payment of % paise does not match the booking total of % paise', new.amount_paise, owed
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger payments_amount_matches_booking before insert or update of amount_paise, booking_id on payments
  for each row execute function check_payment_amount();

-- Doctor's transfer = fee − OPflow's 10%. Never includes the emergency charge.
create or replace function check_transfer_amount() returns trigger
language plpgsql as $$
declare
  share integer;
begin
  select b.fee_paise - b.platform_fee_paise into share
    from payments p join bookings b on b.id = p.booking_id where p.id = new.payment_id;
  if new.amount_paise <> share then
    raise exception 'Doctor transfer of % paise must be exactly % paise (90%% of the fee, without the emergency charge)',
      new.amount_paise, share using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger transfers_amount_is_doctor_share before insert or update of amount_paise, payment_id on transfers
  for each row execute function check_transfer_amount();

-- 3. No walk-ins: their places and counters go. (The enum value 'direct' stays; Postgres can't remove it,
--    and the insert trigger above refuses it.)
alter table schedule_templates drop column direct_places;
alter table opd_sessions drop column direct_places, drop column next_direct_token;

-- 4. No "on call". (The enum value stays; this constraint refuses it.)
update emergency_status set status = 'off', until_at = null where status = 'on_call';
alter table emergency_status add constraint emergency_no_on_call check (status <> 'on_call');

-- Rules and kill switch.
insert into app_config (key, value, description) values
  ('emergency_charge_percent', '20'::jsonb,
   'Emergency consultation: charge added on top of the doctor''s fee, as % of the fee. All of it is OPflow''s.'),
  ('emergency_consult.enabled', 'true'::jsonb, 'Kill switch: paid emergency consultations');

-- migrate:down

delete from app_config where key in ('emergency_charge_percent', 'emergency_consult.enabled');
alter table emergency_status drop constraint emergency_no_on_call;
alter table opd_sessions
  add column direct_places smallint not null default 10 check (direct_places >= 0),
  add column next_direct_token integer not null default 1 check (next_direct_token >= 1);
alter table schedule_templates
  add column direct_places smallint not null default 10 check (direct_places between 0 and 60);
drop trigger if exists transfers_amount_is_doctor_share on transfers;
drop function if exists check_transfer_amount();
drop trigger if exists payments_amount_matches_booking on payments;
drop function if exists check_payment_amount();
create or replace function check_booking_initial_status() returns trigger
language plpgsql as $$
begin
  if not ((new.source = 'online' and new.status = 'pending_payment')
       or (new.source <> 'online' and new.status = 'confirmed')) then
    raise exception 'A new % booking cannot start as "%"', new.source, new.status using errcode = 'check_violation';
  end if;
  return new;
end
$$;
drop index if exists bookings_one_emergency_per_doctor_day;
alter table bookings
  drop constraint bookings_fee_split,
  add constraint bookings_fee_split_online check (source <> 'online' or platform_fee_paise = floor(fee_paise * 10 / 100)),
  add constraint bookings_pending_is_online check (status <> 'pending_payment' or source = 'online'),
  drop constraint bookings_has_patient,
  add constraint bookings_online_has_patient check (source <> 'online' or patient_user_id is not null),
  drop constraint bookings_emergency_charge_only_emergency,
  drop column emergency_charge_paise;
alter table doctors
  drop constraint doctors_paused_time,
  drop column bookings_paused_at,
  drop column bookings_paused;
