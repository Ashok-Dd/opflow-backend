-- OPflow · 1100 · Platform: remote config and kill switches, idempotency keys, bulk operations,
-- the transactional outbox, and the audit log.

-- migrate:up

-- Rules and switches shared by API, app and website (fee %, cut-offs, min app version, kill switches).
create table app_config (
  key          varchar(60) primary key check (key ~ '^[a-z0-9_.]+$'),
  value        jsonb not null,
  description  varchar(200),
  updated_by   uuid,
  updated_at   timestamptz not null default now()
);

-- Replay-safe writes: the same Idempotency-Key returns the stored response.
create table idempotency_keys (
  user_id       uuid not null,
  key           varchar(64) not null,
  route         varchar(120) not null,
  request_hash  bytea not null,                             -- same key + different body → 422
  status_code   smallint,
  response      jsonb,
  created_at    timestamptz not null default now(),
  primary key (user_id, key)
);
create index idempotency_keys_age_idx on idempotency_keys (created_at);   -- purged after 24 h

-- "Cancel the whole day", "move everyone": progress shown to the doctor, audited.
create table bulk_operations (
  id          uuid primary key default uuid_generate_v7(),
  doctor_id   uuid not null references doctors(id),
  session_id  uuid references opd_sessions(id),
  kind        bulk_kind not null,
  total       integer not null check (total >= 0),
  done        integer not null default 0 check (done >= 0),
  failed      integer not null default 0 check (failed >= 0),
  status      bulk_status not null default 'running',
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint bulk_counts check (done + failed <= total)
);

-- Side effects (push, email, live board, Razorpay refunds) are written here in the same transaction as the
-- change, and delivered by the worker after commit.
create table outbox (
  id            bigint generated always as identity primary key,
  topic         varchar(60) not null,                       -- 'notify.booked', 'live.board', 'refund.start'…
  payload       jsonb not null,
  dedupe_key    varchar(160) unique,
  available_at  timestamptz not null default now(),
  attempts      smallint not null default 0,
  last_error    text,
  done_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index outbox_pending_idx on outbox (available_at) where done_at is null;

-- Every admin action, money action, doctor locked-field change and login.
create table audit_log (
  id          bigint generated always as identity primary key,
  actor_type  actor_type not null,
  actor_id    uuid,
  action      varchar(80) not null,
  entity      varchar(60) not null,
  entity_id   text,
  before      jsonb,
  after       jsonb,
  ip          inet,
  request_id  varchar(40),
  at          timestamptz not null default now()
);
create index audit_log_entity_idx on audit_log (entity, entity_id);
create index audit_log_actor_idx  on audit_log (actor_id, at desc);

-- migrate:down

drop table if exists audit_log;
drop table if exists outbox;
drop table if exists bulk_operations;
drop table if exists idempotency_keys;
drop table if exists app_config;
