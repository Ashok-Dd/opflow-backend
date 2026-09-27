-- OPflow · switch-over to Cashfree: removes every payment record made BEFORE Cashfree (all were test-mode
-- payments with no real money), together with the bookings they paid for, so no old payment company's ids remain.
--
-- Run ONCE, only after the owner confirms, AFTER migration 20260929000100_cashfree.sql, with the database owner
-- login (DIRECT_URL), from a UTF-8 file:
--   psql "$DIRECT_URL" -v ON_ERROR_STOP=1 -f scripts/cutover-clear-test-payments.sql
-- Take a backup first (Supabase → Database → Backups, or pg_dump).
--
-- What patients see: anyone with an upcoming test booking gets one message saying it was a test booking and
-- has been removed, and that no real money was taken.

begin;

-- History tables are append-only by trigger; this switch-over is the one planned exception (test data only).
-- Replica mode turns triggers (and FK actions) off for THIS transaction, so every dependent row is removed by hand.
set local session_replication_role = replica;

create temp table test_bookings on commit drop as
  select distinct p.booking_id as id from payments p;

create temp table told on commit drop as
  select distinct b.patient_user_id as user_id
    from bookings b join test_bookings t on t.id = b.id
   where b.patient_user_id is not null
     and b.status in ('pending_payment', 'confirmed')
     and b.session_date >= (now() at time zone 'Asia/Kolkata')::date;

-- The places they held are free again.
update window_slots set state = 'free', booking_id = null, held_until = null, version = version + 1
 where booking_id in (select id from test_bookings);

-- Everything that hangs off those bookings and payments.
delete from visit_feedback  where booking_id in (select id from test_bookings);
delete from queue_entries   where booking_id in (select id from test_bookings);
delete from queue_events    where booking_id in (select id from test_bookings);
delete from booking_events  where booking_id in (select id from test_bookings);
update notifications set booking_id = null where booking_id in (select id from test_bookings);
delete from outbox          where payload->>'bookingId' in (select id::text from test_bookings)
                               or topic = 'refund.start';
delete from refunds         where payment_id in (select id from payments);
delete from transfers       where payment_id in (select id from payments);
delete from payments;
delete from bookings        where id in (select id from test_bookings);

-- The ₹99 doctor suggestions bought in test mode, and every stored webhook from before.
delete from pick_purchases;
delete from webhook_events;

-- One message to each patient whose upcoming test booking was removed.
insert into notifications (user_id, kind, title, body, dedupe_key)
select user_id, 'system', 'Test booking removed',
       'Your earlier booking was a test booking and has been removed. No real money was taken. You can book again any time.',
       'cutover:test-bookings-removed'
  from told
on conflict (user_id, dedupe_key) do nothing;

-- Checks: nothing from before is left.
do $$
begin
  if exists (select 1 from payments) or exists (select 1 from refunds) or exists (select 1 from transfers)
     or exists (select 1 from pick_purchases) then
    raise exception 'Old payment records are still there';
  end if;
end
$$;

commit;

select 'removed test bookings and payments; messages sent: ' || (select count(*) from notifications where dedupe_key = 'cutover:test-bookings-removed') as done;
