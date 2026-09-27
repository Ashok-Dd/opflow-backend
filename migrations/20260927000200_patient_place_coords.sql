-- OPflow · The patient's area now comes only from the phone's location (no fixed list of places), so the
-- point itself is kept with the profile: "doctors near you" works the same after logging in again.

-- migrate:up
alter table patient_profiles
  add column place_lat double precision check (place_lat between -90 and 90),
  add column place_lng double precision check (place_lng between -180 and 180),
  add constraint patient_place_point_both check ((place_lat is null) = (place_lng is null));

-- migrate:down
alter table patient_profiles drop constraint patient_place_point_both, drop column place_lng, drop column place_lat;
