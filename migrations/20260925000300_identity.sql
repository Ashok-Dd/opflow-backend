-- OPflow · 0300 · Identity: accounts, roles, doctor passwords, admins, devices, refresh tokens.

-- migrate:up

create table users (
  id             uuid primary key default uuid_generate_v7(),
  phone          varchar(15) unique check (phone ~ '^\+[1-9][0-9]{7,14}$'),   -- E.164, patients log in with it
  email          citext unique,
  status         user_status not null default 'active',
  last_login_at  timestamptz,
  deleted_at     timestamptz,                                                -- DPDP deletion; PII scrubbed by a job
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint users_contact_present check (phone is not null or email is not null or status = 'deleted'),
  constraint users_deleted_consistent check ((status = 'deleted') = (deleted_at is not null))
);

create table user_roles (
  user_id     uuid not null references users(id) on delete cascade,
  role        user_role not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, role)
);

-- Doctors log in with an ID and password issued by OPflow ("OPD-10234"); first login forces a change.
create table doctor_credentials (
  user_id              uuid primary key references users(id) on delete cascade,
  login_id             varchar(16) not null unique check (login_id ~ '^OPD-[0-9]{4,8}$'),
  password_hash        text not null,                     -- argon2id
  must_change          boolean not null default true,
  failed_attempts      smallint not null default 0 check (failed_attempts >= 0),
  locked_until         timestamptz,                       -- 5 wrong tries → 15 min lock (enforced by the API)
  password_changed_at  timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table admin_users (
  id               uuid primary key default uuid_generate_v7(),
  email            citext not null unique,
  name             varchar(80) not null,
  password_hash    text not null,                         -- argon2id
  totp_secret_enc  bytea,                                 -- encrypted with pgp_sym_encrypt; key lives in the secrets manager
  role             admin_role not null,
  status           user_status not null default 'active',
  allowed_ips      inet[] not null default '{}',          -- empty = any IP (staging only)
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table devices (
  id            uuid primary key default uuid_generate_v7(),
  user_id       uuid not null references users(id) on delete cascade,
  platform      device_platform not null,
  fcm_token     text unique,
  app_version   varchar(20),
  locale        varchar(10),
  last_seen_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index devices_user_idx on devices (user_id);

-- Opaque refresh tokens, stored hashed, rotated on every use; reuse of an old one revokes the whole family.
create table refresh_tokens (
  id           uuid primary key default uuid_generate_v7(),
  user_id      uuid references users(id) on delete cascade,
  admin_id     uuid references admin_users(id) on delete cascade,
  family_id    uuid not null,
  token_hash   bytea not null unique,                     -- sha256 of the token
  device_id    uuid references devices(id) on delete set null,
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  replaced_by  uuid,
  ip           inet,
  user_agent   text,
  created_at   timestamptz not null default now(),
  constraint refresh_tokens_one_owner check (num_nonnulls(user_id, admin_id) = 1)
);
create index refresh_tokens_family_idx on refresh_tokens (family_id);
create index refresh_tokens_user_idx on refresh_tokens (user_id) where revoked_at is null;

-- migrate:down

drop table if exists refresh_tokens;
drop table if exists devices;
drop table if exists admin_users;
drop table if exists doctor_credentials;
drop table if exists user_roles;
drop table if exists users;
