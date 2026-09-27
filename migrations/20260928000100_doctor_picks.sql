-- OPflow · "Find Your Right Doctor": OPflow's suggested doctors (picked by the admin only), the patients'
-- paid one-time suggestions (₹99, set in app_config), and private visit feedback (seen only by OPflow).
--
-- Rules kept by design: doctors can never pay for, ask for or see a pick (no doctor endpoint, no doctor RLS
-- policy); feedback is never shown to doctors or other patients.

-- migrate:up

-- A doctor OPflow may suggest, with the reasons shown to the patient ("MD Dermatology, 12 years").
create table doctor_picks (
  doctor_id   uuid primary key references doctors(id) on delete cascade,
  rank        smallint not null default 5 check (rank between 1 and 9),       -- 1 = first
  reasons     text[] not null default '{}' check (cardinality(reasons) <= 4),
  active      boolean not null default true,
  created_by  uuid references admin_users(id),
  updated_by  uuid references admin_users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger doctor_picks_set_updated_at before update on doctor_picks for each row execute function set_updated_at();

-- One paid suggestion for one type of doctor near the patient. The result is a snapshot (one-time; never refreshed).
create table pick_purchases (
  id                   uuid primary key default uuid_generate_v7(),
  patient_user_id      uuid not null references users(id),
  type_id              text not null references doctor_types(id),
  near_lat             double precision not null check (near_lat between -90 and 90),
  near_lng             double precision not null check (near_lng between -180 and 180),
  place                varchar(80),
  amount_paise         integer not null check (amount_paise > 0),
  status               text not null default 'pending_payment'
                         check (status in ('pending_payment', 'paid', 'refunded', 'failed')),
  razorpay_order_id    varchar(40) not null unique,
  razorpay_payment_id  varchar(40) unique,
  paid_at              timestamptz,
  result               jsonb,                                              -- [{doctorId, reasons[], distanceM}]
  refund_id            varchar(40),
  refund_reason        text,
  refunded_at          timestamptz,
  consent_at           timestamptz not null,                               -- the patient agreed (DPDP)
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint pick_paid_has_time check (status not in ('paid', 'refunded') or paid_at is not null)
);
create index pick_purchases_patient_idx on pick_purchases (patient_user_id, created_at desc);
create trigger pick_purchases_set_updated_at before update on pick_purchases for each row execute function set_updated_at();

-- How a completed visit went (1–5 and a short note). Only OPflow sees it; it helps choose the picks.
create table visit_feedback (
  booking_id       uuid primary key references bookings(id),
  doctor_id        uuid not null references doctors(id),
  patient_user_id  uuid not null references users(id),
  rating           smallint not null check (rating between 1 and 5),
  note             varchar(300),
  created_at       timestamptz not null default now()
);
create index visit_feedback_doctor_idx on visit_feedback (doctor_id, created_at desc);

-- Who may see what. Picks: the API reads them as the system for patients; only admins change them.
alter table doctor_picks enable row level security;
alter table doctor_picks force row level security;
create policy doctor_picks_staff on doctor_picks
  using (app_role() in ('admin', 'system'))
  with check (app_role() in ('admin', 'system'));

alter table pick_purchases enable row level security;
alter table pick_purchases force row level security;
create policy pick_purchases_patient on pick_purchases
  using (app_role() = 'patient' and patient_user_id = app_user_id())
  with check (app_role() = 'patient' and patient_user_id = app_user_id());
create policy pick_purchases_staff on pick_purchases
  using (app_role() in ('admin', 'system'))
  with check (app_role() in ('admin', 'system'));

-- Feedback: a patient writes (and reads back) only their own; doctors have NO policy, so they never see it.
alter table visit_feedback enable row level security;
alter table visit_feedback force row level security;
create policy visit_feedback_patient on visit_feedback
  using (app_role() = 'patient' and patient_user_id = app_user_id())
  with check (app_role() = 'patient' and patient_user_id = app_user_id());
create policy visit_feedback_staff on visit_feedback
  using (app_role() in ('admin', 'system'))
  with check (app_role() in ('admin', 'system'));

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'opflow_api') then
    grant select, insert, update, delete on doctor_picks, pick_purchases, visit_feedback to opflow_api;
  end if;
end
$$;

-- The admin sets these in Rules & switches.
insert into app_config (key, value, description) values
  ('picks.enabled', 'true'::jsonb, 'Kill switch: "Find Your Right Doctor" (paid doctor suggestions)'),
  ('picks.price_paise', '9900'::jsonb, 'Price of one doctor suggestion, in paise (9900 = ₹99)'),
  ('picks.max_km', '25'::jsonb, 'Suggested doctors must work at a hospital within this many km of the patient'),
  ('picks.criteria', '"We look at each doctor''s qualifications, years of relevant experience, training, areas of practice and feedback from verified OPflow patients. Doctors cannot pay to be suggested. This is a recommendation, not a guarantee of treatment outcome."'::jsonb,
   'The "How we recommend" text patients see before they pay')
on conflict (key) do nothing;

-- migrate:down

delete from app_config where key in ('picks.enabled', 'picks.price_paise', 'picks.max_km', 'picks.criteria');
drop table if exists visit_feedback;
drop table if exists pick_purchases;
drop table if exists doctor_picks;
