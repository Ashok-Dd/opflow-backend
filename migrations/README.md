# OPflow database migrations

Plain PostgreSQL (16+) SQL, run in filename order by **[dbmate](https://github.com/amacneil/dbmate)**.
Each file has a `-- migrate:up` part and a `-- migrate:down` part. The schema is explained in
[`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) §3.

| File | What it creates |
|---|---|
| `…000100_extensions_and_helpers` | pgcrypto, citext, pg_trgm, btree_gist, cube + earthdistance; `uuid_generate_v7()`, `set_updated_at()`, `app_user_id()` / `app_doctor_id()` / `app_role()` |
| `…000200_enums` | Every status type (bookings, slots, line, sessions, payments, refunds, transfers…) |
| `…000300_identity` | `users`, `user_roles`, `doctor_credentials` (OPD-10234 + password), `admin_users`, `devices`, `refresh_tokens` |
| `…000400_patients` | `patient_profiles` (one account = one patient, no family), `notification_prefs` |
| `…000500_catalog` | `doctor_types`, `hospitals` (lat/lng + earthdistance index), `hospital_departments`, `health_problems`, `problem_type_map`, `emergency_kinds`, `emergency_kind_types` |
| `…000600_doctors` | `doctors` (locked + editable fields, verification), `doctor_hospitals`, `doctor_documents`, `payout_accounts`, `emergency_status` |
| `…000700_schedule` | `schedule_templates` (no overlaps across hospitals), `doctor_leaves`, `opd_sessions` (doctor can't be in two places), `opd_windows`, **`window_slots`** (one row per place) |
| `…000800_bookings_and_queue` | `bookings` (patient details copied in, fee split checked), `queue_entries` (one patient with the doctor at a time), `booking_events`, `queue_events` |
| `…000900_payments` | `payments` (one open order per booking), `refunds` (can never exceed the payment), `transfers` (doctor's 90%), `webhook_events` |
| `…001000_notifications_content_support` | `notifications` (dedupe), `health_topics`, `health_articles` (removed again in …001700; can't publish without a doctor's review), `article_feedback`, `daily_tips`, `support_tickets` |
| `…001100_platform` | `app_config` (rules + kill switches), `idempotency_keys`, `bulk_operations`, `outbox`, `audit_log` |
| `…001200_triggers_and_state_machines` | `allowed_transitions` + triggers that refuse any other status change; append-only history tables; `updated_at` triggers |
| `…001300_row_level_security` | RLS on `bookings`, `patient_profiles`, `notifications`, `queue_entries` |
| `…001400_reference_data` | Types of doctor, problems, emergency kinds, topics, daily tips, default rules (generated from the app's catalog) |
| `…001500_supabase_lockdown` | Locks Supabase's public REST roles (`anon`, `authenticated`) out of everything; creates the `opflow_api` login (no RLS bypass) with exactly the rights the API needs |
| `…001600_admin_controls` | Only admins can add doctors, logins and hospital links; doctors can't change locked fields; RLS on `doctors`; `approval_requests` (maker ≠ checker); `OPD-10001…` login IDs; `content` admin role |
| `…001700_first_aid_replaces_health_tips` | Removes the health-tips tables; 14 emergency situations; `first_aid_guides` (WHO-based Do's/Don'ts; publish needs a doctor + confirmed source) — generated from the app |
| `…001800_pause_bookings_and_emergency_consult` | Doctors can pause bookings; paid emergency consultations (fee + emergency charge, charge all OPflow's); payment = fee + charge and doctor transfer = 90% of fee enforced by triggers; no walk-in (direct) bookings; no "on call" status; `emergency_charge_percent` = 20 |
| `…001900_backend_runtime` | Admin lockout + TOTP replay guard, one-time admin setup links, refresh tokens remember the app role, per-session booking cut-off, "move to another day" marker, manual refund reference (UTR), `job_leases` for the worker |
| `…002000_api_extensions_path` | On Supabase, lets the API login use the `extensions` schema (pgcrypto); no-op on plain Postgres |
| `…002100_money_rls_and_rules` | Row-level security on payments, refunds, transfers and devices (each follows its booking / doctor / owner); `admin.large_refund_paise` rule (₹2,000) visible in `app_config`; index for admin sessions |
| `…002200_one_admin_and_doctor_devices` | Exactly one active admin (unique index); `approval_requests` no longer used; `doctor.max_devices` = 2; removes the unused large-refund limit; index for live sessions |

## Running

```bash
# Local database (docker compose in backend/ starts Postgres 16)
export DATABASE_URL="postgres://opflow:opflow@localhost:5432/opflow?sslmode=disable"

dbmate --migrations-dir backend/migrations up        # apply everything new
dbmate --migrations-dir backend/migrations rollback  # undo the last one
dbmate --migrations-dir backend/migrations status
```

dbmate records applied files in `schema_migrations` and writes `db/schema.sql` (commit it; reviewers read the
whole schema there). Without dbmate, each file's `migrate:up` part can also be run with `psql` in order.

## On Supabase (production database)

1. Create the project in region **Mumbai (ap-south-1)**.
2. **Project Settings → API → switch the Data API off.** OPflow never uses Supabase's REST/GraphQL API, and
   migration `…001500` also removes all access for its `anon` / `authenticated` roles.
3. Run the migrations with the **direct / session connection (port 5432) as `postgres`** (`DIRECT_URL` in `.env`):
   `DATABASE_URL="$DIRECT_URL" dbmate --migrations-dir backend/migrations up`.
4. Once, in the SQL editor: `alter role opflow_api with login password '<long random password>';`
5. The running API uses `DATABASE_URL`: the **transaction pooler (port 6543) as `opflow_api.<project-ref>`**.
   Never the `postgres` user: it can bypass row-level security.
6. Turn on point-in-time recovery (Pro plan) and check backups in Database → Backups.

## Rules for new migrations

1. **Never edit a migration that has run anywhere shared** (staging/prod). Add a new file with a later timestamp.
2. **Zero-downtime changes:** expand → backfill → switch code → contract, in separate migrations. For example,
   add a nullable column, fill it, deploy the code that uses it, and only then add `not null` or drop the old column.
3. Big indexes on live tables: `create index concurrently` in its own file. dbmate runs it outside a transaction
   when the file starts with `-- migrate:up transaction:false`.
4. New enum values: `alter type … add value` in its own file. Never rename or remove values.
5. A new status column needs rows in `allowed_transitions` and an `enforce_transition` trigger.
6. A new table with `updated_at` needs its own `set_updated_at` trigger.
7. A new table with patient data needs row-level security policies (copy the pattern in `…001300`).

## Row-level security: what the API must do

Every transaction starts with:

```sql
select set_config('app.role', 'patient', true),          -- patient | doctor | admin | system
       set_config('app.user_id', '<users.id>', true),
       set_config('app.doctor_id', '<doctors.id>', true); -- doctors only
```

The policies use `FORCE ROW LEVEL SECURITY`, so they also apply to the table owner. Workers, data fixes and
seed scripts that touch `bookings`, `patient_profiles`, `notifications` or `queue_entries` must set
`app.role = 'system'` first, or they will see no rows.

## Why earthdistance, not PostGIS

"Hospitals near you" only needs distance from a point. `cube` + `earthdistance` ship with every PostgreSQL
(including Supabase, RDS and a plain Windows install) and handle this well at OPflow's scale. If maps with areas
or routes are ever needed, PostGIS can be added in a new migration without changing these tables (`lat`, `lng` stay).
