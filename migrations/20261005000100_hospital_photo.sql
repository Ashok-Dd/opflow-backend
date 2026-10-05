-- OPflow · A real photo for each hospital (landscape, added by the admin). Until one is added the app keeps
-- drawing the hospital front from facade_seed.

-- migrate:up
alter table hospitals add column photo_key text;
comment on column hospitals.photo_key is 'Storage key prefix of the 3 landscape WebP sizes (-s, -m, -l); null = no photo yet';

-- migrate:down
alter table hospitals drop column photo_key;
