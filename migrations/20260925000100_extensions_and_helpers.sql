-- OPflow · 0100 · Extensions and shared helper functions.
-- Runner: dbmate (https://github.com/amacneil/dbmate). Plain PostgreSQL 16+.

-- migrate:up

create extension if not exists pgcrypto;      -- gen_random_uuid(), column encryption (pgp_sym_encrypt)
create extension if not exists citext;        -- case-insensitive emails
create extension if not exists pg_trgm;       -- typo-tolerant search on names ("peadiatric")
create extension if not exists btree_gist;    -- exclusion constraints mixing "=" and range overlap
create extension if not exists cube;          -- needed by earthdistance
create extension if not exists earthdistance; -- "hospitals near you" (ll_to_earth / earth_distance)

-- Time-ordered UUIDs (version 7): new rows land at the end of indexes, which keeps inserts fast.
create or replace function uuid_generate_v7() returns uuid
language plpgsql volatile as $$
declare
  ts_ms bytea;
  b     bytea;
begin
  ts_ms := substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3);
  b := uuid_send(gen_random_uuid());
  b := overlay(b placing ts_ms from 1 for 6);
  b := set_byte(b, 6, (b'0111' || get_byte(b, 6)::bit(4))::bit(8)::int);  -- version 7
  return encode(b, 'hex')::uuid;
end
$$;

-- Keeps updated_at current. Attached to every table that has the column (see the triggers migration).
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- Who is calling, set by the API at the start of every transaction:
--   select set_config('app.user_id', '<uuid>', true), set_config('app.doctor_id', '<uuid>', true),
--          set_config('app.role', 'patient|doctor|admin|system', true);
-- Used by row-level security. Unset values read as null / 'none' (never an error).
create or replace function app_user_id() returns uuid
language sql stable as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create or replace function app_doctor_id() returns uuid
language sql stable as $$ select nullif(current_setting('app.doctor_id', true), '')::uuid $$;

create or replace function app_role() returns text
language sql stable as $$ select coalesce(nullif(current_setting('app.role', true), ''), 'none') $$;

-- migrate:down

drop function if exists app_role();
drop function if exists app_doctor_id();
drop function if exists app_user_id();
drop function if exists set_updated_at();
drop function if exists uuid_generate_v7();
drop extension if exists earthdistance;
drop extension if exists cube;
drop extension if exists btree_gist;
drop extension if exists pg_trgm;
drop extension if exists citext;
drop extension if exists pgcrypto;
