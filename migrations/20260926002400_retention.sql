-- migrate:up

-- Keep the database small: live-line events are needed only while an OPD runs (and a little after, for
-- questions). They stay append-only, except that the housekeeping job may delete events older than 30 days.
create or replace function queue_events_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and old.at < now() - interval '30 days' then
    return old;
  end if;
  raise exception '% is append-only', tg_table_name using errcode = 'insufficient_privilege';
end
$$;

drop trigger if exists queue_events_append_only on queue_events;
create trigger queue_events_append_only before update or delete on queue_events
  for each row execute function queue_events_guard();

-- The API login may delete old rows (row-level security still decides which).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'opflow_api') then
    grant delete on queue_events, notifications, devices, phone_otps to opflow_api;
  end if;
end
$$;

-- The clean-up finds old rows by time.
create index if not exists queue_events_at_idx on queue_events (at);
create index if not exists notifications_created_idx on notifications (created_at);

-- migrate:down

drop index if exists notifications_created_idx;
drop index if exists queue_events_at_idx;
drop trigger if exists queue_events_append_only on queue_events;
create trigger queue_events_append_only before update or delete on queue_events
  for each row execute function refuse_change();
drop function if exists queue_events_guard();
