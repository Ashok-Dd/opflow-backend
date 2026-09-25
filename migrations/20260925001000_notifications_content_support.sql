-- OPflow · 1000 · In-app notifications, health tips content, and support tickets.

-- migrate:up

create table notifications (
  id          uuid primary key default uuid_generate_v7(),
  user_id     uuid not null references users(id) on delete cascade,
  kind        notification_kind not null,
  title       varchar(120) not null,
  body        varchar(500) not null,
  booking_id  uuid references bookings(id) on delete set null,
  data        jsonb not null default '{}',
  dedupe_key  varchar(160),                                 -- the same event never notifies twice
  read_at     timestamptz,
  created_at  timestamptz not null default now(),
  constraint notifications_dedupe unique (user_id, dedupe_key)
);
create index notifications_user_idx   on notifications (user_id, created_at desc);
create index notifications_unread_idx on notifications (user_id) where read_at is null;

create table health_topics (
  id    text primary key check (id ~ '^[a-z]+$'),
  name  varchar(60) not null,
  icon  varchar(60) not null,
  sort  smallint not null default 0
);

create table health_articles (
  id                  text primary key check (id ~ '^[a-z0-9-]+$'),   -- slug, e.g. 'fever-child'
  topic_id            text not null references health_topics(id),
  title               varchar(120) not null,
  summary             varchar(300) not null,
  minutes             smallint not null check (minutes between 1 and 30),
  sections            jsonb not null check (jsonb_typeof(sections) = 'array'),   -- [{heading, points[]}]
  see_doctor          text[] not null default '{}',
  go_now              text[] not null default '{}',
  doctor_type_id      text not null references doctor_types(id),
  helpline            jsonb,                                -- {name, number}
  locale              varchar(5) not null default 'en',
  status              article_status not null default 'draft',
  reviewed_by_doctor  varchar(80),
  reviewed_at         timestamptz,
  published_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- Health content cannot go live without a named doctor's review.
  constraint articles_published_reviewed
    check (status <> 'published' or (reviewed_by_doctor is not null and reviewed_at is not null and published_at is not null))
);
create index health_articles_topic_idx on health_articles (topic_id) where status = 'published';

create table article_feedback (
  id          bigint generated always as identity primary key,
  article_id  text not null references health_articles(id) on delete cascade,
  user_id     uuid references users(id) on delete set null,
  helpful     boolean not null,
  created_at  timestamptz not null default now()
);
create index article_feedback_article_idx on article_feedback (article_id);

create table daily_tips (
  id      smallint generated always as identity primary key,
  text    varchar(200) not null,
  locale  varchar(5) not null default 'en',
  active  boolean not null default true
);

create table support_tickets (
  id           uuid primary key default uuid_generate_v7(),
  user_id      uuid references users(id) on delete set null,
  message      text not null check (length(btrim(message)) between 5 and 2000),
  status       ticket_status not null default 'open',
  assigned_to  uuid references admin_users(id),
  request_id   varchar(40),                                 -- links the ticket to server logs
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index support_tickets_open_idx on support_tickets (created_at) where status = 'open';

-- migrate:down

drop table if exists support_tickets;
drop table if exists daily_tips;
drop table if exists article_feedback;
drop table if exists health_articles;
drop table if exists health_topics;
drop table if exists notifications;
