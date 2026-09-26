-- migrate:up
-- Doctors choose which messages reach their phone (they always stay in the app's Messages list).
alter table notification_prefs
  add column new_bookings     boolean not null default true,
  add column booking_changes  boolean not null default true,
  add column evening_summary  boolean not null default true;

-- migrate:down
alter table notification_prefs
  drop column if exists new_bookings,
  drop column if exists booking_changes,
  drop column if exists evening_summary;
