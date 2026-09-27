-- OPflow · Oncology: a new type of doctor, "Cancer doctor" (user, 2026-09-27).
-- The app shows its own icon for it (Material volunteer_activism_outlined).

-- migrate:up
insert into doctor_types (id, simple_name, proper_name, icon, sort, is_common)
values ('cancer', 'Cancer doctor', 'Oncology', 'volunteer_activism_outlined', 16, false)
on conflict (id) do nothing;

-- migrate:down
delete from doctor_types where id = 'cancer' and not exists (select 1 from doctors where type_id = 'cancer');
