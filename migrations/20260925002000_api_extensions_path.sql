-- migrate:up

-- On Supabase, pgcrypto (and other pre-installed extensions) live in the `extensions` schema. The API login
-- must find pgp_sym_encrypt / pgp_sym_decrypt (admin authenticator secrets) there. Plain Postgres (local,
-- CI) keeps them in `public` and has no `extensions` schema: then nothing changes.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'extensions')
     and exists (select 1 from pg_roles where rolname = 'opflow_api') then
    grant usage on schema extensions to opflow_api;
    grant execute on all functions in schema extensions to opflow_api;
    alter role opflow_api set search_path = public, extensions;
  end if;
end
$$;

-- migrate:down

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'opflow_api') then
    alter role opflow_api reset search_path;
  end if;
end
$$;
