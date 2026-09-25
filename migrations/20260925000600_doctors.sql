-- OPflow · 0600 · Doctors: public profile, hospitals they work at, documents, payouts, emergency status.

-- migrate:up

create table doctors (
  id                 uuid primary key default uuid_generate_v7(),
  user_id            uuid not null unique references users(id),
  -- Locked fields: only OPflow admins change these (audited, two-person approval).
  name               varchar(80) not null,
  type_id            text not null references doctor_types(id),
  degrees            varchar(120) not null,
  reg_council        varchar(60) not null,
  reg_no             varchar(40) not null,
  -- Editable by the doctor ("Edit profile" in the app).
  gender             gender not null,
  years_experience   smallint not null default 0 check (years_experience between 0 and 70),
  languages          text[] not null default '{}',
  about              varchar(240) not null default '',
  fee_paise          integer not null check (fee_paise between 5000 and 300000),   -- ₹50 – ₹3,000
  photo_key          text,                                  -- R2 object key; CDN URLs are built from it
  -- Verification and status.
  verification       doctor_verification not null default 'pending',
  verification_note  varchar(240),
  verified_at        timestamptz,
  verified_by        uuid references admin_users(id),
  status             doctor_status not null default 'active',
  search_vector      tsvector generated always as (to_tsvector('simple', name || ' ' || degrees)) stored,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint doctors_registration_unique unique (reg_council, reg_no),
  constraint doctors_verified_has_time check (verification <> 'verified' or verified_at is not null)
);
-- Public listings only show verified + active doctors.
create index doctors_public_type_idx on doctors (type_id) where verification = 'verified' and status = 'active';
create index doctors_search_idx      on doctors using gin (search_vector);
create index doctors_name_trgm       on doctors using gin (name gin_trgm_ops);

create table doctor_hospitals (
  doctor_id           uuid not null references doctors(id) on delete cascade,
  hospital_id         uuid not null references hospitals(id),
  fee_paise_override  integer check (fee_paise_override between 5000 and 300000),
  is_primary          boolean not null default false,
  status              record_status not null default 'active',
  created_at          timestamptz not null default now(),
  primary key (doctor_id, hospital_id)
);
create unique index doctor_hospitals_one_primary on doctor_hospitals (doctor_id) where is_primary;
create index doctor_hospitals_hospital_idx on doctor_hospitals (hospital_id);

create table doctor_documents (
  id           uuid primary key default uuid_generate_v7(),
  doctor_id    uuid not null references doctors(id) on delete cascade,
  kind         document_kind not null,
  file_key     text not null,                               -- private bucket; 5-minute signed reads only
  status       review_status not null default 'pending',
  reviewed_by  uuid references admin_users(id),
  reviewed_at  timestamptz,
  note         varchar(240),
  created_at   timestamptz not null default now(),
  constraint doctor_documents_review_consistent check ((status = 'pending') = (reviewed_at is null))
);
create index doctor_documents_doctor_idx on doctor_documents (doctor_id);

-- Where the doctor's 90% goes (Razorpay Route linked account).
create table payout_accounts (
  doctor_id            uuid primary key references doctors(id) on delete cascade,
  razorpay_account_id  varchar(40) unique,
  status               payout_status not null default 'pending',
  bank_last4           char(4) check (bank_last4 ~ '^[0-9]{4}$'),
  ifsc                 varchar(11) check (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- What patients see in "Emergency help". A job switches `available_till` off when the time passes.
create table emergency_status (
  doctor_id    uuid primary key references doctors(id) on delete cascade,
  hospital_id  uuid references hospitals(id),
  status       emergency_state not null default 'off',
  mode         emergency_mode not null default 'at_hospital',
  until_at     timestamptz,
  updated_at   timestamptz not null default now(),
  constraint emergency_till_has_time check (status <> 'available_till' or until_at is not null),
  constraint emergency_on_has_place check (status = 'off' or hospital_id is not null)
);
create index emergency_status_on_idx on emergency_status (status) where status <> 'off';

-- migrate:down

drop table if exists emergency_status;
drop table if exists payout_accounts;
drop table if exists doctor_documents;
drop table if exists doctor_hospitals;
drop table if exists doctors;
