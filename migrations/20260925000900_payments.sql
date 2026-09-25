-- OPflow · 0900 · Payments, refunds, the doctor's 90% transfer, and stored webhooks.
-- All money is integer paise. Amounts always come from the server, never from the app.

-- migrate:up

create table payments (
  id                   uuid primary key default uuid_generate_v7(),
  booking_id           uuid not null references bookings(id),
  razorpay_order_id    varchar(40) not null unique,
  razorpay_payment_id  varchar(40) unique,
  amount_paise         integer not null check (amount_paise > 0),
  currency             char(3) not null default 'INR',
  status               payment_status not null default 'created',
  method               varchar(20),                         -- upi, card, netbanking
  failure_reason       text,
  abandoned            boolean not null default false,      -- replaced by a newer order ("Try again")
  raw                  jsonb,                               -- last Razorpay payload, for support
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint payments_captured_has_id check (status <> 'captured' or razorpay_payment_id is not null)
);
create index payments_booking_idx on payments (booking_id);
-- Only one open order per booking at a time.
create unique index payments_one_open_order on payments (booking_id)
  where status in ('created', 'authorized') and not abandoned;

create table refunds (
  id                   uuid primary key default uuid_generate_v7(),
  payment_id           uuid not null references payments(id),
  razorpay_refund_id   varchar(40) unique,
  amount_paise         integer not null check (amount_paise > 0),
  reason               refund_reason not null,
  status               refund_status not null default 'pending',
  attempts             smallint not null default 0 check (attempts >= 0),
  next_attempt_at      timestamptz,
  failure_reason       text,
  initiated_by_type    actor_type not null,
  initiated_by         uuid,
  approved_by          uuid references admin_users(id),     -- second person for large admin refunds
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index refunds_payment_idx on refunds (payment_id);
create index refunds_retry_idx   on refunds (next_attempt_at) where status in ('pending', 'failed');

-- Refunds can never add up to more than was paid.
create or replace function check_refund_total() returns trigger
language plpgsql as $$
declare
  paid     integer;
  refunded integer;
begin
  select amount_paise into paid from payments where id = new.payment_id for update;
  select coalesce(sum(amount_paise), 0) into refunded
    from refunds where payment_id = new.payment_id and id <> new.id and status <> 'failed';
  if refunded + new.amount_paise > paid then
    raise exception 'Refunds (% paise) would exceed the payment (% paise)', refunded + new.amount_paise, paid
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;
create trigger refunds_total_check before insert or update of amount_paise, status on refunds
  for each row execute function check_refund_total();

-- The doctor's 90% (Razorpay Route), on hold until 24 h after the OPD session.
create table transfers (
  id                    uuid primary key default uuid_generate_v7(),
  payment_id            uuid not null unique references payments(id),
  doctor_id             uuid not null references doctors(id),
  razorpay_transfer_id  varchar(40) unique,
  amount_paise          integer not null check (amount_paise > 0),
  status                transfer_status not null default 'on_hold',
  release_at            timestamptz not null,
  released_at           timestamptz,
  reversed_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint transfers_released_time check (status <> 'released' or released_at is not null),
  constraint transfers_reversed_time check (status <> 'reversed' or reversed_at is not null)
);
create index transfers_due_idx    on transfers (release_at) where status = 'on_hold';
create index transfers_doctor_idx on transfers (doctor_id, created_at desc);

-- Every Razorpay webhook is stored once (dedupe by event id), then processed.
create table webhook_events (
  id            varchar(64) primary key,                    -- provider event id
  provider      varchar(20) not null default 'razorpay',
  type          varchar(60) not null,
  payload       jsonb not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  error         text
);
create index webhook_events_pending_idx on webhook_events (received_at) where processed_at is null;

-- migrate:down

drop table if exists webhook_events;
drop table if exists transfers;
drop trigger if exists refunds_total_check on refunds;
drop function if exists check_refund_total();
drop table if exists refunds;
drop table if exists payments;
