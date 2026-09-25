-- migrate:up

-- Patient login codes sent by SMS (MSG91). Only a keyed hash of the code is kept. A code works once, for 5
-- minutes, with at most 5 tries; the API also limits how often a number can ask for a new code.
create table phone_otps (
  id          uuid primary key default uuid_generate_v7(),
  phone       varchar(16) not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  code_hash   text not null,
  attempts    smallint not null default 0,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  ip          inet,
  created_at  timestamptz not null default now()
);
create index phone_otps_phone_idx on phone_otps (phone, created_at desc);

-- Only the API (as the system) reads and writes it; no app role may see codes.
alter table phone_otps enable row level security;
alter table phone_otps force row level security;
create policy phone_otps_system on phone_otps
  using (app_role() = 'system')
  with check (app_role() = 'system');

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'opflow_api') then
    grant select, insert, update, delete on phone_otps to opflow_api;
  end if;
end
$$;

-- migrate:down

drop table if exists phone_otps;
