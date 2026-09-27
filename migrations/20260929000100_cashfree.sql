-- OPflow · Payments move to Cashfree (Payment Gateway to collect, Payouts to pay doctors).
-- Column names become provider-neutral; the doctor's 90% is sent as one bank payout per doctor per run
-- (a `payouts` row), and money to take back after a payout is deducted from the doctor's next payout.

-- migrate:up

-- 1. Neutral names for the payment company's ids.
alter table payments       rename column razorpay_order_id   to gateway_order_id;
alter table payments       rename column razorpay_payment_id to gateway_payment_id;
alter table refunds        rename column razorpay_refund_id  to gateway_refund_id;
alter table pick_purchases rename column razorpay_order_id   to gateway_order_id;
alter table pick_purchases rename column razorpay_payment_id to gateway_payment_id;
alter table payout_accounts rename column razorpay_account_id to beneficiary_id;
alter table payout_accounts alter column beneficiary_id type varchar(50);
alter table payments       alter column gateway_order_id   type varchar(45);
alter table pick_purchases alter column gateway_order_id   type varchar(45);
alter table payments       alter column gateway_payment_id type varchar(45);
alter table pick_purchases alter column gateway_payment_id type varchar(45);
comment on column payments.raw is 'last payment-company payload, for support';

-- Constraint and index names that still carry the old company's name.
do $$
declare r record;
begin
  for r in select conrelid::regclass as tbl, conname from pg_constraint
            where connamespace = 'public'::regnamespace and conname like '%razorpay%' loop
    execute format('alter table %s rename constraint %I to %I', r.tbl, r.conname, replace(r.conname, 'razorpay', 'gateway'));
  end loop;
  for r in select indexname from pg_indexes where schemaname = 'public' and indexname like '%razorpay%' loop
    execute format('alter index %I rename to %I', r.indexname, replace(r.indexname, 'razorpay', 'gateway'));
  end loop;
end
$$;

-- 2. Doctor payouts: one bank transfer per doctor per run, covering many visits.
create table payouts (
  id              uuid primary key default uuid_generate_v7(),
  doctor_id       uuid not null references doctors(id),
  amount_paise    integer not null check (amount_paise > 0),
  visits_paise    integer not null check (visits_paise > 0),          -- the visits' 90% before any deduction
  deducted_paise  integer not null default 0 check (deducted_paise >= 0),
  status          text not null default 'pending' check (status in ('pending', 'success', 'failed')),
  cf_transfer_id  varchar(40),
  utr             varchar(40),                                        -- the bank's reference
  failure_reason  text,
  settled_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint payouts_amount_adds_up check (amount_paise = visits_paise - deducted_paise),
  constraint payouts_settled_time check (status = 'pending' or settled_at is not null)
);
create index payouts_doctor_idx  on payouts (doctor_id, created_at desc);
create index payouts_pending_idx on payouts (created_at) where status = 'pending';
create trigger payouts_set_updated_at before update on payouts for each row execute function set_updated_at();

alter table transfers drop column razorpay_transfer_id;
alter table transfers add column payout_id uuid references payouts(id);
-- Money to take back (the visit was refunded after the doctor was paid), and the payout it came out of.
alter table transfers add column recover_paise integer not null default 0 check (recover_paise >= 0 and recover_paise <= amount_paise);
alter table transfers add column recovered_in uuid references payouts(id);
create index transfers_payout_idx  on transfers (payout_id);
create index transfers_recover_idx on transfers (doctor_id) where recover_paise > 0;

-- A payout the bank refused puts its visits back on hold, to be paid in a later run.
insert into allowed_transitions (entity, from_state, to_state) values ('transfers.status', 'released', 'on_hold')
  on conflict do nothing;

alter table payouts enable row level security;
alter table payouts force row level security;
create policy payouts_doctor on payouts
  using (app_role() = 'doctor' and doctor_id = app_doctor_id());
create policy payouts_staff on payouts
  using (app_role() in ('admin', 'system'))
  with check (app_role() in ('admin', 'system'));

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'opflow_api') then
    grant select, insert, update on payouts to opflow_api;
  end if;
end
$$;

-- 3. Webhooks now come from Cashfree.
alter table webhook_events alter column provider set default 'cashfree';

-- 4. Rules.
update app_config set value = '"cashfree"'::jsonb where key = 'payments.provider';
-- Apps older than 1.1.0 still carry the old payment screen: they are asked to update.
update app_config set value = '"1.1.0"'::jsonb where key = 'min_supported_app_version';
insert into app_config (key, value, description) values
  ('payouts.min_paise', '10000'::jsonb, 'Smallest bank payout to a doctor, in paise (10000 = ₹100); smaller amounts wait for the next run')
  on conflict (key) do nothing;

-- migrate:down

delete from app_config where key = 'payouts.min_paise';
update app_config set value = '"razorpay"'::jsonb where key = 'payments.provider';
update app_config set value = '"1.0.0"'::jsonb where key = 'min_supported_app_version';
alter table webhook_events alter column provider set default 'razorpay';
delete from allowed_transitions where entity = 'transfers.status' and from_state = 'released' and to_state = 'on_hold';
drop index if exists transfers_recover_idx;
drop index if exists transfers_payout_idx;
alter table transfers drop column if exists recovered_in;
alter table transfers drop column if exists recover_paise;
alter table transfers drop column if exists payout_id;
alter table transfers add column razorpay_transfer_id varchar(40) unique;
drop table if exists payouts;
do $$
declare r record;
begin
  for r in select conrelid::regclass as tbl, conname from pg_constraint
            where connamespace = 'public'::regnamespace and conname like '%gateway%' loop
    execute format('alter table %s rename constraint %I to %I', r.tbl, r.conname, replace(r.conname, 'gateway', 'razorpay'));
  end loop;
end
$$;
alter table payout_accounts rename column beneficiary_id to razorpay_account_id;
alter table pick_purchases rename column gateway_payment_id to razorpay_payment_id;
alter table pick_purchases rename column gateway_order_id   to razorpay_order_id;
alter table refunds        rename column gateway_refund_id  to razorpay_refund_id;
alter table payments       rename column gateway_payment_id to razorpay_payment_id;
alter table payments       rename column gateway_order_id   to razorpay_order_id;
