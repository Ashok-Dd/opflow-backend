-- OPflow · 1500 · Supabase lock-down and the API's own database login.
--
-- 1. Supabase exposes the `public` schema through its auto-generated REST/GraphQL API (PostgREST) to the
--    `anon` and `authenticated` roles. OPflow does not use that API: the NestJS server is the only way in.
--    So those roles get no access at all. (Also switch the Data API off in the dashboard:
--    Project Settings → API → "Enable Data API" = off, and keep the anon key out of every app.)
-- 2. The API connects as `opflow_api`: a normal login WITHOUT BYPASSRLS, so the row-level security
--    policies in …001300 really apply to it. Supabase's `postgres` role can bypass RLS; the API must never use it.
--    Set its password once, by hand, in the Supabase SQL editor (never in a migration or in git):
--      alter role opflow_api with login password '<long random password>';
-- Safe to run on a plain PostgreSQL too: every Supabase-specific step checks the role exists first.

-- migrate:up

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables    in schema public from anon, authenticated;
    revoke all on all sequences in schema public from anon, authenticated;
    revoke all on all functions in schema public from anon, authenticated;
    revoke usage on schema public from anon, authenticated;
    -- Tables created by later migrations must not be granted to them either.
    alter default privileges in schema public revoke all on tables    from anon, authenticated;
    alter default privileges in schema public revoke all on sequences from anon, authenticated;
    alter default privileges in schema public revoke all on functions from anon, authenticated;
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'opflow_api') then
    create role opflow_api nologin noinherit nobypassrls;   -- login + password are set by hand (see above)
  end if;
end
$$;

grant usage on schema public to opflow_api;
grant select, insert, update, delete on all tables in schema public to opflow_api;
grant usage, select on all sequences in schema public to opflow_api;
grant execute on all functions in schema public to opflow_api;
alter default privileges in schema public grant select, insert, update, delete on tables to opflow_api;
alter default privileges in schema public grant usage, select on sequences to opflow_api;
alter default privileges in schema public grant execute on functions to opflow_api;

-- History tables: the API may add rows, never change or remove them (the triggers also refuse it).
revoke update, delete, truncate on booking_events, queue_events, audit_log from opflow_api;
-- Reference data and the rulebook are changed by migrations and the admin API only.
revoke insert, update, delete on allowed_transitions from opflow_api;

-- migrate:down

alter default privileges in schema public revoke all on tables    from opflow_api;
alter default privileges in schema public revoke all on sequences from opflow_api;
alter default privileges in schema public revoke all on functions from opflow_api;
revoke all on all tables    in schema public from opflow_api;
revoke all on all sequences in schema public from opflow_api;
revoke all on all functions in schema public from opflow_api;
revoke usage on schema public from opflow_api;
drop role if exists opflow_api;
-- The anon/authenticated revokes are not re-granted on purpose: exposing the schema again must be a
-- deliberate, manual decision.
