-- OPflow · 1200 · Triggers: state machines (ARCHITECTURE.md §4.0), updated_at, and append-only tables.
-- The API already enforces these rules; the database refuses anything else as a safety net
-- (for example, a mistaken manual SQL update).

-- migrate:up

-- The only allowed status moves. Same table as `*.states.ts` in the API.
create table allowed_transitions (
  entity      text not null,   -- '<table>.<column>'
  from_state  text not null,
  to_state    text not null,
  primary key (entity, from_state, to_state)
);

insert into allowed_transitions (entity, from_state, to_state) values
  -- Bookings
  ('bookings.status', 'pending_payment', 'confirmed'),
  ('bookings.status', 'pending_payment', 'expired'),
  ('bookings.status', 'expired',         'confirmed'),              -- late payment, place still free
  ('bookings.status', 'confirmed',       'completed'),
  ('bookings.status', 'confirmed',       'no_show'),
  ('bookings.status', 'no_show',         'confirmed'),              -- doctor undoes "did not come"
  ('bookings.status', 'no_show',         'completed'),
  ('bookings.status', 'confirmed',       'cancelled_by_provider'),
  -- Places
  ('window_slots.state', 'free',    'held'),
  ('window_slots.state', 'held',    'booked'),
  ('window_slots.state', 'held',    'free'),                        -- hold expired
  ('window_slots.state', 'booked',  'free'),                        -- cancelled or rescheduled away
  ('window_slots.state', 'free',    'blocked'),                     -- doctor lowered places per hour
  ('window_slots.state', 'blocked', 'free'),
  -- Live line
  ('queue_entries.state', 'not_come',     'waiting'),
  ('queue_entries.state', 'not_come',     'with_doctor'),           -- "Call in now"
  ('queue_entries.state', 'waiting',      'with_doctor'),
  ('queue_entries.state', 'with_doctor',  'done'),
  ('queue_entries.state', 'with_doctor',  'waiting'),               -- "Skip for now"
  ('queue_entries.state', 'with_doctor',  'did_not_come'),
  ('queue_entries.state', 'waiting',      'did_not_come'),
  ('queue_entries.state', 'not_come',     'did_not_come'),
  ('queue_entries.state', 'did_not_come', 'waiting'),               -- "Put back in line"
  ('queue_entries.state', 'done',         'waiting'),               -- "Put back in line"
  ('queue_entries.state', 'not_come',     'cancelled'),
  ('queue_entries.state', 'waiting',      'cancelled'),
  ('queue_entries.state', 'with_doctor',  'cancelled'),
  ('queue_entries.state', 'not_come',     'moved'),
  ('queue_entries.state', 'waiting',      'moved'),
  -- OPD sessions
  ('opd_sessions.status', 'scheduled', 'running'),
  ('opd_sessions.status', 'running',   'paused'),
  ('opd_sessions.status', 'paused',    'running'),
  ('opd_sessions.status', 'running',   'ended'),
  ('opd_sessions.status', 'paused',    'ended'),
  ('opd_sessions.status', 'scheduled', 'cancelled'),
  ('opd_sessions.status', 'running',   'cancelled'),
  ('opd_sessions.status', 'paused',    'cancelled'),
  -- Payments, refunds, transfers
  ('payments.status', 'created',    'authorized'),
  ('payments.status', 'created',    'captured'),                    -- auto-capture
  ('payments.status', 'authorized', 'captured'),
  ('payments.status', 'created',    'failed'),
  ('payments.status', 'authorized', 'failed'),
  ('refunds.status', 'pending', 'processed'),
  ('refunds.status', 'pending', 'failed'),
  ('refunds.status', 'failed',  'pending'),                         -- retry
  ('transfers.status', 'on_hold',  'released'),
  ('transfers.status', 'on_hold',  'reversed'),
  ('transfers.status', 'released', 'reversed'),
  ('transfers.status', 'on_hold',  'failed'),
  ('transfers.status', 'failed',   'on_hold');                      -- retry

-- TG_ARGV[0] = column name. Reads old/new values generically through jsonb.
create or replace function enforce_transition() returns trigger
language plpgsql as $$
declare
  col       text := tg_argv[0];
  old_state text := to_jsonb(old) ->> col;
  new_state text := to_jsonb(new) ->> col;
begin
  if old_state is distinct from new_state and not exists (
       select 1 from allowed_transitions
       where entity = tg_table_name || '.' || col and from_state = old_state and to_state = new_state) then
    raise exception 'Not allowed: %.% from "%" to "%"', tg_table_name, col, old_state, new_state
      using errcode = 'check_violation', hint = 'See allowed_transitions and ARCHITECTURE.md §4.0';
  end if;
  return new;
end
$$;

create trigger bookings_status_transition      before update of status on bookings
  for each row execute function enforce_transition('status');
create trigger window_slots_state_transition   before update of state on window_slots
  for each row execute function enforce_transition('state');
create trigger queue_entries_state_transition  before update of state on queue_entries
  for each row execute function enforce_transition('state');
create trigger opd_sessions_status_transition  before update of status on opd_sessions
  for each row execute function enforce_transition('status');
create trigger payments_status_transition      before update of status on payments
  for each row execute function enforce_transition('status');
create trigger refunds_status_transition       before update of status on refunds
  for each row execute function enforce_transition('status');
create trigger transfers_status_transition     before update of status on transfers
  for each row execute function enforce_transition('status');

-- New bookings can only start as pending_payment (online) or confirmed (direct / emergency at the desk).
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
create trigger bookings_initial_status before insert on bookings
  for each row execute function check_booking_initial_status();

-- History tables are append-only.
create or replace function refuse_change() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'insufficient_privilege';
end
$$;
create trigger booking_events_append_only before update or delete on booking_events
  for each row execute function refuse_change();
create trigger queue_events_append_only before update or delete on queue_events
  for each row execute function refuse_change();
create trigger audit_log_append_only before update or delete on audit_log
  for each row execute function refuse_change();
-- TRUNCATE skips row triggers, so block it separately.
create trigger booking_events_no_truncate before truncate on booking_events
  for each statement execute function refuse_change();
create trigger queue_events_no_truncate before truncate on queue_events
  for each statement execute function refuse_change();
create trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function refuse_change();

-- updated_at on every table that has the column. (New tables in later migrations add their own trigger.)
do $$
declare
  t text;
begin
  for t in
    select c.table_name from information_schema.columns c
    join information_schema.tables tb on tb.table_name = c.table_name and tb.table_schema = c.table_schema
    where c.table_schema = 'public' and c.column_name = 'updated_at' and tb.table_type = 'BASE TABLE'
  loop
    execute format('create trigger %I before update on %I for each row execute function set_updated_at()',
                   t || '_set_updated_at', t);
  end loop;
end
$$;

-- migrate:down

do $$
declare
  t text;
begin
  for t in
    select event_object_table from information_schema.triggers
    where trigger_schema = 'public' and trigger_name = event_object_table || '_set_updated_at'
    group by event_object_table
  loop
    execute format('drop trigger if exists %I on %I', t || '_set_updated_at', t);
  end loop;
end
$$;
drop trigger if exists audit_log_no_truncate on audit_log;
drop trigger if exists queue_events_no_truncate on queue_events;
drop trigger if exists booking_events_no_truncate on booking_events;
drop trigger if exists audit_log_append_only on audit_log;
drop trigger if exists queue_events_append_only on queue_events;
drop trigger if exists booking_events_append_only on booking_events;
drop function if exists refuse_change();
drop trigger if exists bookings_initial_status on bookings;
drop function if exists check_booking_initial_status();
drop trigger if exists transfers_status_transition on transfers;
drop trigger if exists refunds_status_transition on refunds;
drop trigger if exists payments_status_transition on payments;
drop trigger if exists opd_sessions_status_transition on opd_sessions;
drop trigger if exists queue_entries_state_transition on queue_entries;
drop trigger if exists window_slots_state_transition on window_slots;
drop trigger if exists bookings_status_transition on bookings;
drop function if exists enforce_transition();
drop table if exists allowed_transitions;
