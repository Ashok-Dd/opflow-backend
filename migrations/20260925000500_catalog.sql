-- OPflow · 0500 · Catalog: types of doctor, hospitals, health problems, emergency kinds.
-- Reference rows are loaded by the reference-data migration.

-- migrate:up

create table doctor_types (
  id           text primary key check (id ~ '^[a-z]+$'),      -- 'child'
  simple_name  varchar(40) not null,                         -- "Child doctor" (what patients read)
  proper_name  varchar(60) not null,                         -- "Pediatrics"
  icon         varchar(60) not null,                         -- Material icon name used by the app
  sort         smallint not null default 0,
  is_common    boolean not null default false                -- shown on the Home screen
);

create table hospitals (
  id                uuid primary key default uuid_generate_v7(),
  slug              varchar(80) not null unique check (slug ~ '^[a-z0-9-]+$'),
  name              varchar(120) not null,
  address           varchar(240) not null,
  area              varchar(80) not null,
  city              varchar(60) not null,
  pin               varchar(6) not null check (pin ~ '^[1-9][0-9]{5}$'),
  lat               double precision not null check (lat between -90 and 90),
  lng               double precision not null check (lng between -180 and 180),
  phone             varchar(20) not null,
  opd_timings_text  varchar(120),
  has_emergency     boolean not null default false,
  status            record_status not null default 'active',
  facade_seed       integer not null default floor(random() * 1000)::int,   -- varies the drawn hospital front
  search            tsvector generated always as
                      (to_tsvector('simple', name || ' ' || area || ' ' || city || ' ' || pin)) stored,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index hospitals_near_idx   on hospitals using gist (ll_to_earth(lat, lng)) where status = 'active';
create index hospitals_search_idx on hospitals using gin (search);
create index hospitals_name_trgm  on hospitals using gin (name gin_trgm_ops);

create table hospital_departments (
  hospital_id  uuid not null references hospitals(id) on delete cascade,
  type_id      text not null references doctor_types(id),
  primary key (hospital_id, type_id)
);

create table health_problems (
  id         text primary key check (id ~ '^[a-z]+$'),
  name       varchar(60) not null,
  icon       varchar(60) not null,
  is_danger  boolean not null default false,               -- shows the "This may be an emergency" screen first
  sort       smallint not null default 0
);

-- Which types of doctor can help with a problem, for adults and for children, best first.
create table problem_type_map (
  problem_id  text not null references health_problems(id) on delete cascade,
  type_id     text not null references doctor_types(id),
  audience    audience not null,
  rank        smallint not null default 1,
  primary key (problem_id, type_id, audience)
);

create table emergency_kinds (
  id      text primary key check (id ~ '^[a-z]+$'),
  name    varchar(60) not null,
  detail  varchar(160) not null,
  icon    varchar(60) not null,
  sort    smallint not null default 0
);

create table emergency_kind_types (
  kind_id  text not null references emergency_kinds(id) on delete cascade,
  type_id  text not null references doctor_types(id),
  primary key (kind_id, type_id)
);

-- migrate:down

drop table if exists emergency_kind_types;
drop table if exists emergency_kinds;
drop table if exists problem_type_map;
drop table if exists health_problems;
drop table if exists hospital_departments;
drop table if exists hospitals;
drop table if exists doctor_types;
