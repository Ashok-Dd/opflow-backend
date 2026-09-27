-- OPflow · A stable id per app install / browser, so the same device signing in again is recognised even without a
-- push token (doctor accounts: at most 2 phones + 1 website; a NEW device is refused when those are in use).

-- migrate:up
alter table devices add column install_id varchar(64) check (install_id ~ '^[A-Za-z0-9-]{16,64}$');
create index devices_install_idx on devices (install_id) where install_id is not null;

-- migrate:down
drop index devices_install_idx;
alter table devices drop column install_id;
