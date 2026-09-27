--
-- PostgreSQL database dump
--

\restrict JtOAc79kGTxG37ji0SeKfR2LLMoIR4mwaVOllDXRPilRiw2me8ACrwa9Ny0ggY0

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: btree_gist; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;


--
-- Name: EXTENSION btree_gist; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION btree_gist IS 'support for indexing common datatypes in GiST';


--
-- Name: citext; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;


--
-- Name: EXTENSION citext; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION citext IS 'data type for case-insensitive character strings';


--
-- Name: cube; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS cube WITH SCHEMA public;


--
-- Name: EXTENSION cube; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION cube IS 'data type for multidimensional cubes';


--
-- Name: earthdistance; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS earthdistance WITH SCHEMA public;


--
-- Name: EXTENSION earthdistance; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION earthdistance IS 'calculate great-circle distances on the surface of the Earth';


--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: actor_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.actor_type AS ENUM (
    'patient',
    'doctor',
    'admin',
    'system'
);


--
-- Name: admin_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.admin_role AS ENUM (
    'super',
    'ops',
    'finance',
    'support',
    'content'
);


--
-- Name: approval_decision; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.approval_decision AS ENUM (
    'pending',
    'approved',
    'rejected',
    'expired'
);


--
-- Name: approval_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.approval_kind AS ENUM (
    'verify_doctor',
    'edit_doctor_locked',
    'suspend_doctor',
    'refund_large',
    'config_change',
    'admin_user_change'
);


--
-- Name: article_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.article_status AS ENUM (
    'draft',
    'in_review',
    'published'
);


--
-- Name: audience; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.audience AS ENUM (
    'adult',
    'child'
);


--
-- Name: booking_source; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.booking_source AS ENUM (
    'online',
    'direct',
    'emergency'
);


--
-- Name: booking_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.booking_status AS ENUM (
    'pending_payment',
    'confirmed',
    'completed',
    'no_show',
    'cancelled_by_provider',
    'expired'
);


--
-- Name: bulk_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.bulk_kind AS ENUM (
    'cancel_day',
    'move_day',
    'end_opd_cancel',
    'end_opd_move'
);


--
-- Name: bulk_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.bulk_status AS ENUM (
    'running',
    'finished',
    'needs_attention'
);


--
-- Name: device_platform; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.device_platform AS ENUM (
    'android',
    'ios',
    'web'
);


--
-- Name: doctor_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.doctor_status AS ENUM (
    'active',
    'suspended'
);


--
-- Name: doctor_verification; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.doctor_verification AS ENUM (
    'pending',
    'verified',
    'needs_correction',
    'rejected'
);


--
-- Name: document_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.document_kind AS ENUM (
    'degree',
    'registration',
    'id_proof',
    'other'
);


--
-- Name: emergency_mode; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.emergency_mode AS ENUM (
    'at_hospital',
    'phone_first'
);


--
-- Name: emergency_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.emergency_state AS ENUM (
    'off',
    'available_now',
    'available_till',
    'on_call'
);


--
-- Name: gender; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.gender AS ENUM (
    'male',
    'female',
    'other'
);


--
-- Name: notification_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.notification_kind AS ENUM (
    'booked',
    'reminder',
    'late',
    'turn',
    'cancelled',
    'changed',
    'refund',
    'system'
);


--
-- Name: payment_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payment_status AS ENUM (
    'created',
    'authorized',
    'captured',
    'failed'
);


--
-- Name: payout_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.payout_status AS ENUM (
    'pending',
    'active',
    'suspended'
);


--
-- Name: queue_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.queue_state AS ENUM (
    'not_come',
    'waiting',
    'with_doctor',
    'done',
    'did_not_come',
    'cancelled',
    'moved'
);


--
-- Name: record_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.record_status AS ENUM (
    'active',
    'hidden'
);


--
-- Name: refund_reason; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.refund_reason AS ENUM (
    'provider_cancelled',
    'late_payment',
    'duplicate',
    'admin_goodwill'
);


--
-- Name: refund_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.refund_status AS ENUM (
    'pending',
    'processed',
    'failed'
);


--
-- Name: review_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.review_status AS ENUM (
    'pending',
    'approved',
    'rejected'
);


--
-- Name: session_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.session_status AS ENUM (
    'scheduled',
    'running',
    'paused',
    'ended',
    'cancelled'
);


--
-- Name: slot_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.slot_state AS ENUM (
    'free',
    'held',
    'booked',
    'blocked'
);


--
-- Name: ticket_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.ticket_status AS ENUM (
    'open',
    'answered',
    'closed'
);


--
-- Name: transfer_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.transfer_status AS ENUM (
    'on_hold',
    'released',
    'reversed',
    'failed'
);


--
-- Name: user_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_role AS ENUM (
    'patient',
    'doctor',
    'admin'
);


--
-- Name: user_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.user_status AS ENUM (
    'active',
    'suspended',
    'deleted'
);


--
-- Name: window_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.window_status AS ENUM (
    'open',
    'closed'
);


--
-- Name: app_doctor_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.app_doctor_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ select nullif(current_setting('app.doctor_id', true), '')::uuid $$;


--
-- Name: app_role(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.app_role() RETURNS text
    LANGUAGE sql STABLE
    AS $$ select coalesce(nullif(current_setting('app.role', true), ''), 'none') $$;


--
-- Name: app_user_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.app_user_id() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;


--
-- Name: check_booking_initial_status(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_booking_initial_status() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.source not in ('online', 'emergency') then
    raise exception 'Doctors cannot add patients: every booking comes from the app (source "%")', new.source
      using errcode = 'check_violation';
  end if;
  if new.status <> 'pending_payment' then
    raise exception 'A new booking must start unpaid (pending_payment), not "%"', new.status using errcode = 'check_violation';
  end if;
  return new;
end
$$;


--
-- Name: check_payment_amount(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_payment_amount() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  owed integer;
begin
  select fee_paise + emergency_charge_paise into owed from bookings where id = new.booking_id;
  if new.amount_paise <> owed then
    raise exception 'Payment of % paise does not match the booking total of % paise', new.amount_paise, owed
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;


--
-- Name: check_refund_total(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_refund_total() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  paid     integer;
  refunded integer;
begin
  select amount_paise into paid from payments where id = new.payment_id for update;
  select coalesce(sum(amount_paise), 0) into refunded
    from refunds where payment_id = new.payment_id and id <> new.id and status <> 'failed';
  if refunded + new.amount_paise > paid then
    raise exception 'Refunds (% paise) would exceed the payment (% paise)', refunded + new.amount_paise, paid
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;


--
-- Name: check_slot_in_range(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_slot_in_range() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  ts integer;
begin
  select token_start into ts from opd_windows where id = new.window_id;
  if new.token < ts or new.token > ts + 19 then
    raise exception 'Token % is outside the range of window % (% – %)', new.token, new.window_id, ts, ts + 19
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;


--
-- Name: check_transfer_amount(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_transfer_amount() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  share integer;
begin
  select b.fee_paise - b.platform_fee_paise into share
    from payments p join bookings b on b.id = p.booking_id where p.id = new.payment_id;
  if new.amount_paise <> share then
    raise exception 'Doctor transfer of % paise must be exactly % paise (90%% of the fee, without the emergency charge)',
      new.amount_paise, share using errcode = 'check_violation';
  end if;
  return new;
end
$$;


--
-- Name: enforce_transition(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_transition() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  col       text := tg_argv[0];
  old_state text := to_jsonb(old) ->> col;
  new_state text := to_jsonb(new) ->> col;
begin
  if old_state is distinct from new_state and not exists (
       select 1 from allowed_transitions
       where entity = tg_table_name || '.' || col and from_state = old_state and to_state = new_state) then
    raise exception 'Not allowed: %.% from "%" to "%"', tg_table_name, col, old_state, new_state
      using errcode = 'check_violation', hint = 'See allowed_transitions and ARCHITECTURE.md §4.0';
  end if;
  return new;
end
$$;


--
-- Name: guard_doctor_self_edit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.guard_doctor_self_edit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if app_role() = 'doctor' and (
       new.name is distinct from old.name or
       new.type_id is distinct from old.type_id or
       new.degrees is distinct from old.degrees or
       new.reg_council is distinct from old.reg_council or
       new.reg_no is distinct from old.reg_no or
       new.user_id is distinct from old.user_id or
       new.verification is distinct from old.verification or
       new.verification_note is distinct from old.verification_note or
       new.verified_at is distinct from old.verified_at or
       new.verified_by is distinct from old.verified_by or
       new.status is distinct from old.status or
       new.created_by_admin is distinct from old.created_by_admin or
       new.listed_at is distinct from old.listed_at) then
    raise exception 'This detail can only be changed by the OPflow team'
      using errcode = 'insufficient_privilege',
            hint = 'Doctors can edit: gender, years_experience, languages, about, fee_paise, photo_key';
  end if;
  return new;
end
$$;


--
-- Name: next_doctor_login_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_doctor_login_id() RETURNS text
    LANGUAGE sql
    AS $$ select 'OPD-' || nextval('doctor_login_seq')::text $$;


--
-- Name: queue_events_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.queue_events_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'DELETE' and old.at < now() - interval '30 days' then
    return old;
  end if;
  raise exception '% is append-only', tg_table_name using errcode = 'insufficient_privilege';
end
$$;


--
-- Name: refuse_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refuse_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'insufficient_privilege';
end
$$;


--
-- Name: require_admin_to_create(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.require_admin_to_create() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if app_role() not in ('admin', 'system') then
    raise exception 'Only OPflow admins can add % (current role: %)', tg_table_name, app_role()
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at := now();
  return new;
end
$$;


--
-- Name: uuid_generate_v7(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.uuid_generate_v7() RETURNS uuid
    LANGUAGE plpgsql
    AS $$
declare
  ts_ms bytea;
  b     bytea;
begin
  ts_ms := substring(int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint) from 3);
  b := uuid_send(gen_random_uuid());
  b := overlay(b placing ts_ms from 1 for 6);
  b := set_byte(b, 6, (b'0111' || get_byte(b, 6)::bit(4))::bit(8)::int);  -- version 7
  return encode(b, 'hex')::uuid;
end
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_setup_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_setup_tokens (
    token_hash bytea NOT NULL,
    admin_id uuid NOT NULL,
    totp_secret_enc bytea NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_users (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    email public.citext NOT NULL,
    name character varying(80) NOT NULL,
    password_hash text NOT NULL,
    totp_secret_enc bytea,
    role public.admin_role NOT NULL,
    status public.user_status DEFAULT 'active'::public.user_status NOT NULL,
    allowed_ips inet[] DEFAULT '{}'::inet[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    failed_attempts smallint DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    last_login_at timestamp with time zone,
    totp_last_step bigint,
    CONSTRAINT admin_users_failed_attempts_check CHECK ((failed_attempts >= 0))
);


--
-- Name: allowed_transitions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.allowed_transitions (
    entity text NOT NULL,
    from_state text NOT NULL,
    to_state text NOT NULL
);


--
-- Name: app_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_config (
    key character varying(60) NOT NULL,
    value jsonb NOT NULL,
    description character varying(200),
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT app_config_key_check CHECK (((key)::text ~ '^[a-z0-9_.]+$'::text))
);


--
-- Name: approval_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approval_requests (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    kind public.approval_kind NOT NULL,
    subject_type character varying(40) NOT NULL,
    subject_id text NOT NULL,
    payload jsonb NOT NULL,
    reason character varying(240) NOT NULL,
    requested_by uuid NOT NULL,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '72:00:00'::interval) NOT NULL,
    decision public.approval_decision DEFAULT 'pending'::public.approval_decision NOT NULL,
    decided_by uuid,
    decided_at timestamp with time zone,
    decision_note character varying(240),
    CONSTRAINT approval_requests_reason_check CHECK ((length(btrim((reason)::text)) >= 5)),
    CONSTRAINT approvals_decided_consistent CHECK (((decision = ANY (ARRAY['approved'::public.approval_decision, 'rejected'::public.approval_decision])) = ((decided_by IS NOT NULL) AND (decided_at IS NOT NULL)))),
    CONSTRAINT approvals_maker_is_not_checker CHECK (((decided_by IS NULL) OR (decided_by <> requested_by)))
);


--
-- Name: TABLE approval_requests; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.approval_requests IS 'Not used since 2026-09-25 (one admin; changes apply at once and are recorded in audit_log).';


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id bigint NOT NULL,
    actor_type public.actor_type NOT NULL,
    actor_id uuid,
    action character varying(80) NOT NULL,
    entity character varying(60) NOT NULL,
    entity_id text,
    before jsonb,
    after jsonb,
    ip inet,
    request_id character varying(40),
    at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.audit_log ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: booking_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.booking_events (
    id bigint NOT NULL,
    booking_id uuid NOT NULL,
    type character varying(40) NOT NULL,
    actor_type public.actor_type NOT NULL,
    actor_id uuid,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: booking_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.booking_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.booking_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: bookings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bookings (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    code character varying(10) NOT NULL,
    patient_user_id uuid,
    patient_name character varying(80) NOT NULL,
    patient_age smallint,
    patient_gender public.gender,
    walk_in_phone character varying(15),
    doctor_id uuid NOT NULL,
    hospital_id uuid NOT NULL,
    session_id uuid NOT NULL,
    session_date date NOT NULL,
    window_id uuid,
    source public.booking_source NOT NULL,
    token integer NOT NULL,
    slot_token integer GENERATED ALWAYS AS (
CASE
    WHEN (source = 'online'::public.booking_source) THEN token
    ELSE NULL::integer
END) STORED,
    status public.booking_status NOT NULL,
    hold_expires_at timestamp with time zone,
    fee_paise integer NOT NULL,
    platform_fee_paise integer DEFAULT 0 NOT NULL,
    note character varying(140) DEFAULT ''::character varying NOT NULL,
    reschedule_count smallint DEFAULT 0 NOT NULL,
    rescheduled_at timestamp with time zone,
    confirmed_at timestamp with time zone,
    completed_at timestamp with time zone,
    cancelled_at timestamp with time zone,
    cancelled_by uuid,
    cancelled_reason character varying(120),
    idempotency_key character varying(64),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    emergency_charge_paise integer DEFAULT 0 NOT NULL,
    needs_new_time_since timestamp with time zone,
    CONSTRAINT bookings_cancel_consistent CHECK (((status = 'cancelled_by_provider'::public.booking_status) = (cancelled_at IS NOT NULL))),
    CONSTRAINT bookings_check CHECK (((platform_fee_paise >= 0) AND (platform_fee_paise <= fee_paise))),
    CONSTRAINT bookings_code_check CHECK (((code)::text ~ '^OPF[0-9A-Z]{5,7}$'::text)),
    CONSTRAINT bookings_emergency_charge_only_emergency CHECK (((source = 'emergency'::public.booking_source) = (emergency_charge_paise > 0))),
    CONSTRAINT bookings_emergency_charge_paise_check CHECK ((emergency_charge_paise >= 0)),
    CONSTRAINT bookings_fee_paise_check CHECK ((fee_paise >= 0)),
    CONSTRAINT bookings_fee_split CHECK (((platform_fee_paise)::double precision = floor((((fee_paise * 10) / 100))::double precision))),
    CONSTRAINT bookings_has_patient CHECK ((patient_user_id IS NOT NULL)),
    CONSTRAINT bookings_hold_has_expiry CHECK (((status <> 'pending_payment'::public.booking_status) OR (hold_expires_at IS NOT NULL))),
    CONSTRAINT bookings_online_has_window CHECK (((source <> 'online'::public.booking_source) OR (window_id IS NOT NULL))),
    CONSTRAINT bookings_patient_age_check CHECK (((patient_age >= 0) AND (patient_age <= 120))),
    CONSTRAINT bookings_reschedule_count_check CHECK (((reschedule_count >= 0) AND (reschedule_count <= 1))),
    CONSTRAINT bookings_token_check CHECK ((token >= 1)),
    CONSTRAINT bookings_walk_in_phone_check CHECK (((walk_in_phone)::text ~ '^\+[1-9][0-9]{7,14}$'::text))
);

ALTER TABLE ONLY public.bookings FORCE ROW LEVEL SECURITY;


--
-- Name: bulk_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bulk_operations (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    doctor_id uuid NOT NULL,
    session_id uuid,
    kind public.bulk_kind NOT NULL,
    total integer NOT NULL,
    done integer DEFAULT 0 NOT NULL,
    failed integer DEFAULT 0 NOT NULL,
    status public.bulk_status DEFAULT 'running'::public.bulk_status NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT bulk_counts CHECK (((done + failed) <= total)),
    CONSTRAINT bulk_operations_done_check CHECK ((done >= 0)),
    CONSTRAINT bulk_operations_failed_check CHECK ((failed >= 0)),
    CONSTRAINT bulk_operations_total_check CHECK ((total >= 0))
);


--
-- Name: devices; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.devices (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    user_id uuid NOT NULL,
    platform public.device_platform NOT NULL,
    fcm_token text,
    app_version character varying(20),
    locale character varying(10),
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    install_id character varying(64),
    CONSTRAINT devices_install_id_check CHECK (((install_id)::text ~ '^[A-Za-z0-9-]{16,64}$'::text))
);

ALTER TABLE ONLY public.devices FORCE ROW LEVEL SECURITY;


--
-- Name: doctor_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.doctor_credentials (
    user_id uuid NOT NULL,
    login_id character varying(16) NOT NULL,
    password_hash text NOT NULL,
    must_change boolean DEFAULT true NOT NULL,
    failed_attempts smallint DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    password_changed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT doctor_credentials_failed_attempts_check CHECK ((failed_attempts >= 0)),
    CONSTRAINT doctor_credentials_login_id_check CHECK (((login_id)::text ~ '^OPD-[0-9]{4,8}$'::text))
);


--
-- Name: doctor_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.doctor_documents (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    doctor_id uuid NOT NULL,
    kind public.document_kind NOT NULL,
    file_key text NOT NULL,
    status public.review_status DEFAULT 'pending'::public.review_status NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    note character varying(240),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT doctor_documents_review_consistent CHECK (((status = 'pending'::public.review_status) = (reviewed_at IS NULL)))
);


--
-- Name: doctor_hospitals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.doctor_hospitals (
    doctor_id uuid NOT NULL,
    hospital_id uuid NOT NULL,
    fee_paise_override integer,
    is_primary boolean DEFAULT false NOT NULL,
    status public.record_status DEFAULT 'active'::public.record_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT doctor_hospitals_fee_paise_override_check CHECK (((fee_paise_override >= 5000) AND (fee_paise_override <= 300000)))
);


--
-- Name: doctor_leaves; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.doctor_leaves (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    doctor_id uuid NOT NULL,
    hospital_id uuid,
    date date NOT NULL,
    reason character varying(120),
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: doctor_login_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.doctor_login_seq
    START WITH 10001
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: doctor_picks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.doctor_picks (
    doctor_id uuid NOT NULL,
    rank smallint DEFAULT 5 NOT NULL,
    reasons text[] DEFAULT '{}'::text[] NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_by uuid,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT doctor_picks_rank_check CHECK (((rank >= 1) AND (rank <= 9))),
    CONSTRAINT doctor_picks_reasons_check CHECK ((cardinality(reasons) <= 4))
);

ALTER TABLE ONLY public.doctor_picks FORCE ROW LEVEL SECURITY;


--
-- Name: doctor_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.doctor_types (
    id text NOT NULL,
    simple_name character varying(40) NOT NULL,
    proper_name character varying(60) NOT NULL,
    icon character varying(60) NOT NULL,
    sort smallint DEFAULT 0 NOT NULL,
    is_common boolean DEFAULT false NOT NULL,
    CONSTRAINT doctor_types_id_check CHECK ((id ~ '^[a-z]+$'::text))
);


--
-- Name: doctors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.doctors (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    user_id uuid NOT NULL,
    name character varying(80) NOT NULL,
    type_id text NOT NULL,
    degrees character varying(120) NOT NULL,
    reg_council character varying(60) NOT NULL,
    reg_no character varying(40) NOT NULL,
    gender public.gender NOT NULL,
    years_experience smallint DEFAULT 0 NOT NULL,
    languages text[] DEFAULT '{}'::text[] NOT NULL,
    about character varying(240) DEFAULT ''::character varying NOT NULL,
    fee_paise integer NOT NULL,
    photo_key text,
    verification public.doctor_verification DEFAULT 'pending'::public.doctor_verification NOT NULL,
    verification_note character varying(240),
    verified_at timestamp with time zone,
    verified_by uuid,
    status public.doctor_status DEFAULT 'active'::public.doctor_status NOT NULL,
    search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, (((name)::text || ' '::text) || (degrees)::text))) STORED,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by_admin uuid,
    listed_at timestamp with time zone,
    bookings_paused boolean DEFAULT false NOT NULL,
    bookings_paused_at timestamp with time zone,
    CONSTRAINT doctors_fee_paise_check CHECK (((fee_paise >= 5000) AND (fee_paise <= 300000))),
    CONSTRAINT doctors_paused_time CHECK ((bookings_paused = (bookings_paused_at IS NOT NULL))),
    CONSTRAINT doctors_verified_has_time CHECK (((verification <> 'verified'::public.doctor_verification) OR (verified_at IS NOT NULL))),
    CONSTRAINT doctors_years_experience_check CHECK (((years_experience >= 0) AND (years_experience <= 70)))
);

ALTER TABLE ONLY public.doctors FORCE ROW LEVEL SECURITY;


--
-- Name: emergency_kind_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.emergency_kind_types (
    kind_id text NOT NULL,
    type_id text NOT NULL
);


--
-- Name: emergency_kinds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.emergency_kinds (
    id text NOT NULL,
    name character varying(60) NOT NULL,
    detail character varying(160) NOT NULL,
    icon character varying(60) NOT NULL,
    sort smallint DEFAULT 0 NOT NULL,
    CONSTRAINT emergency_kinds_id_check CHECK ((id ~ '^[a-z]+$'::text))
);


--
-- Name: emergency_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.emergency_status (
    doctor_id uuid NOT NULL,
    hospital_id uuid,
    status public.emergency_state DEFAULT 'off'::public.emergency_state NOT NULL,
    mode public.emergency_mode DEFAULT 'at_hospital'::public.emergency_mode NOT NULL,
    until_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT emergency_no_on_call CHECK ((status <> 'on_call'::public.emergency_state)),
    CONSTRAINT emergency_on_has_place CHECK (((status = 'off'::public.emergency_state) OR (hospital_id IS NOT NULL))),
    CONSTRAINT emergency_till_has_time CHECK (((status <> 'available_till'::public.emergency_state) OR (until_at IS NOT NULL)))
);


--
-- Name: first_aid_guides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.first_aid_guides (
    kind_id text NOT NULL,
    intro text,
    signs text[] DEFAULT '{}'::text[] NOT NULL,
    call_now_if text[] NOT NULL,
    dos text[] NOT NULL,
    donts text[] NOT NULL,
    sources jsonb NOT NULL,
    source_to_confirm boolean DEFAULT false NOT NULL,
    locale character varying(5) DEFAULT 'en'::character varying NOT NULL,
    status public.article_status DEFAULT 'in_review'::public.article_status NOT NULL,
    reviewed_by_doctor character varying(80),
    reviewed_at timestamp with time zone,
    published_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT first_aid_guides_call_now_if_check CHECK ((cardinality(call_now_if) > 0)),
    CONSTRAINT first_aid_guides_donts_check CHECK ((cardinality(donts) > 0)),
    CONSTRAINT first_aid_guides_dos_check CHECK ((cardinality(dos) > 0)),
    CONSTRAINT first_aid_guides_sources_check CHECK (((jsonb_typeof(sources) = 'array'::text) AND (jsonb_array_length(sources) > 0))),
    CONSTRAINT first_aid_published_reviewed CHECK (((status <> 'published'::public.article_status) OR ((reviewed_by_doctor IS NOT NULL) AND (reviewed_at IS NOT NULL) AND (published_at IS NOT NULL) AND (NOT source_to_confirm))))
);


--
-- Name: health_problems; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.health_problems (
    id text NOT NULL,
    name character varying(60) NOT NULL,
    icon character varying(60) NOT NULL,
    is_danger boolean DEFAULT false NOT NULL,
    sort smallint DEFAULT 0 NOT NULL,
    CONSTRAINT health_problems_id_check CHECK ((id ~ '^[a-z]+$'::text))
);


--
-- Name: hospital_departments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hospital_departments (
    hospital_id uuid NOT NULL,
    type_id text NOT NULL
);


--
-- Name: hospitals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hospitals (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    slug character varying(80) NOT NULL,
    name character varying(120) NOT NULL,
    address character varying(240) NOT NULL,
    area character varying(80) NOT NULL,
    city character varying(60) NOT NULL,
    pin character varying(6) NOT NULL,
    lat double precision NOT NULL,
    lng double precision NOT NULL,
    phone character varying(20) NOT NULL,
    opd_timings_text character varying(120),
    has_emergency boolean DEFAULT false NOT NULL,
    status public.record_status DEFAULT 'active'::public.record_status NOT NULL,
    facade_seed integer DEFAULT (floor((random() * (1000)::double precision)))::integer NOT NULL,
    search tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, (((((((name)::text || ' '::text) || (area)::text) || ' '::text) || (city)::text) || ' '::text) || (pin)::text))) STORED,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hospitals_lat_check CHECK (((lat >= ('-90'::integer)::double precision) AND (lat <= (90)::double precision))),
    CONSTRAINT hospitals_lng_check CHECK (((lng >= ('-180'::integer)::double precision) AND (lng <= (180)::double precision))),
    CONSTRAINT hospitals_pin_check CHECK (((pin)::text ~ '^[1-9][0-9]{5}$'::text)),
    CONSTRAINT hospitals_slug_check CHECK (((slug)::text ~ '^[a-z0-9-]+$'::text))
);


--
-- Name: idempotency_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.idempotency_keys (
    user_id uuid NOT NULL,
    key character varying(64) NOT NULL,
    route character varying(120) NOT NULL,
    request_hash bytea NOT NULL,
    status_code smallint,
    response jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: job_leases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.job_leases (
    name character varying(60) NOT NULL,
    locked_until timestamp with time zone DEFAULT '-infinity'::timestamp with time zone NOT NULL,
    last_started_at timestamp with time zone,
    last_finished_at timestamp with time zone,
    last_error text
);


--
-- Name: notification_prefs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_prefs (
    user_id uuid NOT NULL,
    reminders boolean DEFAULT true NOT NULL,
    late_alerts boolean DEFAULT true NOT NULL,
    turn_alerts boolean DEFAULT true NOT NULL,
    email_receipts boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    new_bookings boolean DEFAULT true NOT NULL,
    booking_changes boolean DEFAULT true NOT NULL,
    evening_summary boolean DEFAULT true NOT NULL
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    user_id uuid NOT NULL,
    kind public.notification_kind NOT NULL,
    title character varying(120) NOT NULL,
    body character varying(500) NOT NULL,
    booking_id uuid,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    dedupe_key character varying(160),
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE ONLY public.notifications FORCE ROW LEVEL SECURITY;


--
-- Name: opd_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.opd_sessions (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    doctor_id uuid NOT NULL,
    hospital_id uuid NOT NULL,
    template_id uuid,
    date date NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    status public.session_status DEFAULT 'scheduled'::public.session_status NOT NULL,
    late_minutes smallint DEFAULT 0 NOT NULL,
    started_at timestamp with time zone,
    ended_at timestamp with time zone,
    avg_consult_sec integer DEFAULT 420 NOT NULL,
    now_seeing_token integer,
    next_emergency_token integer DEFAULT 1 NOT NULL,
    version integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    close_minutes_before smallint DEFAULT 30 NOT NULL,
    CONSTRAINT opd_sessions_avg_consult_sec_check CHECK ((avg_consult_sec > 0)),
    CONSTRAINT opd_sessions_close_minutes_before_check CHECK (((close_minutes_before >= 0) AND (close_minutes_before <= 240))),
    CONSTRAINT opd_sessions_late_minutes_check CHECK (((late_minutes >= 0) AND (late_minutes <= 600))),
    CONSTRAINT opd_sessions_next_emergency_token_check CHECK ((next_emergency_token >= 1)),
    CONSTRAINT opd_sessions_version_check CHECK ((version >= 0)),
    CONSTRAINT sessions_end_after_start CHECK ((ends_at > starts_at)),
    CONSTRAINT sessions_started_consistent CHECK (((status = 'scheduled'::public.session_status) OR (status = 'cancelled'::public.session_status) OR (started_at IS NOT NULL)))
);


--
-- Name: opd_windows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.opd_windows (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    session_id uuid NOT NULL,
    starts_at timestamp with time zone NOT NULL,
    ends_at timestamp with time zone NOT NULL,
    capacity smallint NOT NULL,
    token_start integer NOT NULL,
    status public.window_status DEFAULT 'open'::public.window_status NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT opd_windows_capacity_check CHECK (((capacity >= 0) AND (capacity <= 20))),
    CONSTRAINT opd_windows_token_start_check CHECK (((token_start >= 1) AND (((token_start - 1) % 20) = 0))),
    CONSTRAINT windows_end_after_start CHECK ((ends_at > starts_at))
);


--
-- Name: outbox; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox (
    id bigint NOT NULL,
    topic character varying(60) NOT NULL,
    payload jsonb NOT NULL,
    dedupe_key character varying(160),
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    attempts smallint DEFAULT 0 NOT NULL,
    last_error text,
    done_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: outbox_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.outbox ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.outbox_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: patient_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.patient_profiles (
    user_id uuid NOT NULL,
    name character varying(80) NOT NULL,
    birth_year smallint NOT NULL,
    gender public.gender NOT NULL,
    place character varying(60),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    place_lat double precision,
    place_lng double precision,
    CONSTRAINT patient_place_point_both CHECK (((place_lat IS NULL) = (place_lng IS NULL))),
    CONSTRAINT patient_profiles_birth_year_check CHECK (((birth_year >= 1900) AND (birth_year <= 2100))),
    CONSTRAINT patient_profiles_name_check CHECK ((length(btrim((name)::text)) >= 2)),
    CONSTRAINT patient_profiles_place_lat_check CHECK (((place_lat >= ('-90'::integer)::double precision) AND (place_lat <= (90)::double precision))),
    CONSTRAINT patient_profiles_place_lng_check CHECK (((place_lng >= ('-180'::integer)::double precision) AND (place_lng <= (180)::double precision)))
);

ALTER TABLE ONLY public.patient_profiles FORCE ROW LEVEL SECURITY;


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    booking_id uuid NOT NULL,
    gateway_order_id character varying(45) NOT NULL,
    gateway_payment_id character varying(45),
    amount_paise integer NOT NULL,
    currency character(3) DEFAULT 'INR'::bpchar NOT NULL,
    status public.payment_status DEFAULT 'created'::public.payment_status NOT NULL,
    method character varying(20),
    failure_reason text,
    abandoned boolean DEFAULT false NOT NULL,
    raw jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payments_amount_paise_check CHECK ((amount_paise > 0)),
    CONSTRAINT payments_captured_has_id CHECK (((status <> 'captured'::public.payment_status) OR (gateway_payment_id IS NOT NULL)))
);

ALTER TABLE ONLY public.payments FORCE ROW LEVEL SECURITY;


--
-- Name: COLUMN payments.raw; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payments.raw IS 'last payment-company payload, for support';


--
-- Name: payout_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payout_accounts (
    doctor_id uuid NOT NULL,
    beneficiary_id character varying(50),
    status public.payout_status DEFAULT 'pending'::public.payout_status NOT NULL,
    bank_last4 character(4),
    ifsc character varying(11),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payout_accounts_bank_last4_check CHECK ((bank_last4 ~ '^[0-9]{4}$'::text)),
    CONSTRAINT payout_accounts_ifsc_check CHECK (((ifsc)::text ~ '^[A-Z]{4}0[A-Z0-9]{6}$'::text))
);


--
-- Name: payouts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payouts (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    doctor_id uuid NOT NULL,
    amount_paise integer NOT NULL,
    visits_paise integer NOT NULL,
    deducted_paise integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    cf_transfer_id character varying(40),
    utr character varying(40),
    failure_reason text,
    settled_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT payouts_amount_adds_up CHECK ((amount_paise = (visits_paise - deducted_paise))),
    CONSTRAINT payouts_amount_paise_check CHECK ((amount_paise > 0)),
    CONSTRAINT payouts_deducted_paise_check CHECK ((deducted_paise >= 0)),
    CONSTRAINT payouts_settled_time CHECK (((status = 'pending'::text) OR (settled_at IS NOT NULL))),
    CONSTRAINT payouts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'success'::text, 'failed'::text]))),
    CONSTRAINT payouts_visits_paise_check CHECK ((visits_paise > 0))
);

ALTER TABLE ONLY public.payouts FORCE ROW LEVEL SECURITY;


--
-- Name: phone_otps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.phone_otps (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    phone character varying(16) NOT NULL,
    code_hash text NOT NULL,
    attempts smallint DEFAULT 0 NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    ip inet,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT phone_otps_phone_check CHECK (((phone)::text ~ '^\+[1-9][0-9]{7,14}$'::text))
);

ALTER TABLE ONLY public.phone_otps FORCE ROW LEVEL SECURITY;


--
-- Name: pick_purchases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pick_purchases (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    patient_user_id uuid NOT NULL,
    type_id text NOT NULL,
    near_lat double precision NOT NULL,
    near_lng double precision NOT NULL,
    place character varying(80),
    amount_paise integer NOT NULL,
    status text DEFAULT 'pending_payment'::text NOT NULL,
    gateway_order_id character varying(45) NOT NULL,
    gateway_payment_id character varying(45),
    paid_at timestamp with time zone,
    result jsonb,
    refund_id character varying(40),
    refund_reason text,
    refunded_at timestamp with time zone,
    consent_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pick_paid_has_time CHECK (((status <> ALL (ARRAY['paid'::text, 'refunded'::text])) OR (paid_at IS NOT NULL))),
    CONSTRAINT pick_purchases_amount_paise_check CHECK ((amount_paise > 0)),
    CONSTRAINT pick_purchases_near_lat_check CHECK (((near_lat >= ('-90'::integer)::double precision) AND (near_lat <= (90)::double precision))),
    CONSTRAINT pick_purchases_near_lng_check CHECK (((near_lng >= ('-180'::integer)::double precision) AND (near_lng <= (180)::double precision))),
    CONSTRAINT pick_purchases_status_check CHECK ((status = ANY (ARRAY['pending_payment'::text, 'paid'::text, 'refunded'::text, 'failed'::text])))
);

ALTER TABLE ONLY public.pick_purchases FORCE ROW LEVEL SECURITY;


--
-- Name: problem_type_map; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.problem_type_map (
    problem_id text NOT NULL,
    type_id text NOT NULL,
    audience public.audience NOT NULL,
    rank smallint DEFAULT 1 NOT NULL
);


--
-- Name: queue_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.queue_entries (
    booking_id uuid NOT NULL,
    session_id uuid NOT NULL,
    state public.queue_state DEFAULT 'not_come'::public.queue_state NOT NULL,
    order_key numeric NOT NULL,
    reached_at timestamp with time zone,
    called_at timestamp with time zone,
    done_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT queue_called_has_time CHECK (((state <> ALL (ARRAY['with_doctor'::public.queue_state, 'done'::public.queue_state])) OR (called_at IS NOT NULL)))
);

ALTER TABLE ONLY public.queue_entries FORCE ROW LEVEL SECURITY;


--
-- Name: queue_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.queue_events (
    id bigint NOT NULL,
    session_id uuid NOT NULL,
    version integer NOT NULL,
    type character varying(40) NOT NULL,
    booking_id uuid,
    actor_id uuid,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT queue_events_version_check CHECK ((version >= 1))
);


--
-- Name: queue_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.queue_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.queue_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: refresh_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.refresh_tokens (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    user_id uuid,
    admin_id uuid,
    family_id uuid NOT NULL,
    token_hash bytea NOT NULL,
    device_id uuid,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    replaced_by uuid,
    ip inet,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    role public.user_role,
    CONSTRAINT refresh_tokens_one_owner CHECK ((num_nonnulls(user_id, admin_id) = 1)),
    CONSTRAINT refresh_tokens_role_matches CHECK (((user_id IS NULL) = (role IS NULL)))
);


--
-- Name: refunds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.refunds (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    payment_id uuid NOT NULL,
    gateway_refund_id character varying(40),
    amount_paise integer NOT NULL,
    reason public.refund_reason NOT NULL,
    status public.refund_status DEFAULT 'pending'::public.refund_status NOT NULL,
    attempts smallint DEFAULT 0 NOT NULL,
    next_attempt_at timestamp with time zone,
    failure_reason text,
    initiated_by_type public.actor_type NOT NULL,
    initiated_by uuid,
    approved_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    manual_reference character varying(40),
    CONSTRAINT refunds_amount_paise_check CHECK ((amount_paise > 0)),
    CONSTRAINT refunds_attempts_check CHECK ((attempts >= 0))
);

ALTER TABLE ONLY public.refunds FORCE ROW LEVEL SECURITY;


--
-- Name: schedule_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedule_templates (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    doctor_id uuid NOT NULL,
    hospital_id uuid NOT NULL,
    weekday smallint NOT NULL,
    start_time time without time zone NOT NULL,
    end_time time without time zone NOT NULL,
    start_minute smallint GENERATED ALWAYS AS ((((EXTRACT(hour FROM start_time) * (60)::numeric) + EXTRACT(minute FROM start_time)))::smallint) STORED,
    end_minute smallint GENERATED ALWAYS AS ((((EXTRACT(hour FROM end_time) * (60)::numeric) + EXTRACT(minute FROM end_time)))::smallint) STORED,
    window_minutes smallint DEFAULT 60 NOT NULL,
    online_per_window smallint NOT NULL,
    take_emergency boolean DEFAULT true NOT NULL,
    avg_consult_minutes smallint DEFAULT 7 NOT NULL,
    open_days_ahead smallint DEFAULT 14 NOT NULL,
    close_minutes_before smallint DEFAULT 30 NOT NULL,
    valid_from date DEFAULT CURRENT_DATE NOT NULL,
    valid_to date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT schedule_end_after_start CHECK ((end_time > start_time)),
    CONSTRAINT schedule_templates_avg_consult_minutes_check CHECK (((avg_consult_minutes >= 1) AND (avg_consult_minutes <= 60))),
    CONSTRAINT schedule_templates_close_minutes_before_check CHECK (((close_minutes_before >= 0) AND (close_minutes_before <= 240))),
    CONSTRAINT schedule_templates_online_per_window_check CHECK (((online_per_window >= 1) AND (online_per_window <= 20))),
    CONSTRAINT schedule_templates_open_days_ahead_check CHECK (((open_days_ahead >= 1) AND (open_days_ahead <= 60))),
    CONSTRAINT schedule_templates_weekday_check CHECK (((weekday >= 1) AND (weekday <= 7))),
    CONSTRAINT schedule_templates_window_minutes_check CHECK ((window_minutes = ANY (ARRAY[30, 60]))),
    CONSTRAINT schedule_valid_range CHECK (((valid_to IS NULL) OR (valid_to >= valid_from))),
    CONSTRAINT schedule_whole_windows CHECK ((((EXTRACT(epoch FROM (end_time - start_time)))::integer % (window_minutes * 60)) = 0))
);


--
-- Name: support_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_tickets (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    user_id uuid,
    message text NOT NULL,
    status public.ticket_status DEFAULT 'open'::public.ticket_status NOT NULL,
    assigned_to uuid,
    request_id character varying(40),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT support_tickets_message_check CHECK (((length(btrim(message)) >= 5) AND (length(btrim(message)) <= 2000)))
);


--
-- Name: transfers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transfers (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    payment_id uuid NOT NULL,
    doctor_id uuid NOT NULL,
    amount_paise integer NOT NULL,
    status public.transfer_status DEFAULT 'on_hold'::public.transfer_status NOT NULL,
    release_at timestamp with time zone NOT NULL,
    released_at timestamp with time zone,
    reversed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    payout_id uuid,
    recover_paise integer DEFAULT 0 NOT NULL,
    recovered_in uuid,
    CONSTRAINT transfers_amount_paise_check CHECK ((amount_paise > 0)),
    CONSTRAINT transfers_check CHECK (((recover_paise >= 0) AND (recover_paise <= amount_paise))),
    CONSTRAINT transfers_released_time CHECK (((status <> 'released'::public.transfer_status) OR (released_at IS NOT NULL))),
    CONSTRAINT transfers_reversed_time CHECK (((status <> 'reversed'::public.transfer_status) OR (reversed_at IS NOT NULL)))
);

ALTER TABLE ONLY public.transfers FORCE ROW LEVEL SECURITY;


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_roles (
    user_id uuid NOT NULL,
    role public.user_role NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT public.uuid_generate_v7() NOT NULL,
    phone character varying(15),
    email public.citext,
    status public.user_status DEFAULT 'active'::public.user_status NOT NULL,
    last_login_at timestamp with time zone,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_contact_present CHECK (((phone IS NOT NULL) OR (email IS NOT NULL) OR (status = 'deleted'::public.user_status))),
    CONSTRAINT users_deleted_consistent CHECK (((status = 'deleted'::public.user_status) = (deleted_at IS NOT NULL))),
    CONSTRAINT users_phone_check CHECK (((phone)::text ~ '^\+[1-9][0-9]{7,14}$'::text))
);


--
-- Name: visit_feedback; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.visit_feedback (
    booking_id uuid NOT NULL,
    doctor_id uuid NOT NULL,
    patient_user_id uuid NOT NULL,
    rating smallint NOT NULL,
    note character varying(300),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT visit_feedback_rating_check CHECK (((rating >= 1) AND (rating <= 5)))
);

ALTER TABLE ONLY public.visit_feedback FORCE ROW LEVEL SECURITY;


--
-- Name: webhook_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_events (
    id character varying(64) NOT NULL,
    provider character varying(20) DEFAULT 'cashfree'::character varying NOT NULL,
    type character varying(60) NOT NULL,
    payload jsonb NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    error text
);


--
-- Name: window_slots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.window_slots (
    window_id uuid NOT NULL,
    token integer NOT NULL,
    state public.slot_state DEFAULT 'free'::public.slot_state NOT NULL,
    booking_id uuid,
    held_until timestamp with time zone,
    version integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT slots_booking_matches_state CHECK (((state = ANY (ARRAY['free'::public.slot_state, 'blocked'::public.slot_state])) = (booking_id IS NULL))),
    CONSTRAINT slots_hold_has_expiry CHECK (((state <> 'held'::public.slot_state) OR (held_until IS NOT NULL))),
    CONSTRAINT window_slots_token_check CHECK ((token >= 1))
);


--
-- Name: admin_setup_tokens admin_setup_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_setup_tokens
    ADD CONSTRAINT admin_setup_tokens_pkey PRIMARY KEY (token_hash);


--
-- Name: admin_users admin_users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_email_key UNIQUE (email);


--
-- Name: admin_users admin_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_users
    ADD CONSTRAINT admin_users_pkey PRIMARY KEY (id);


--
-- Name: allowed_transitions allowed_transitions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.allowed_transitions
    ADD CONSTRAINT allowed_transitions_pkey PRIMARY KEY (entity, from_state, to_state);


--
-- Name: app_config app_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_config
    ADD CONSTRAINT app_config_pkey PRIMARY KEY (key);


--
-- Name: approval_requests approval_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: booking_events booking_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_events
    ADD CONSTRAINT booking_events_pkey PRIMARY KEY (id);


--
-- Name: bookings bookings_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_code_key UNIQUE (code);


--
-- Name: bookings bookings_idempotency_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_idempotency_unique UNIQUE (patient_user_id, idempotency_key);


--
-- Name: bookings bookings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_pkey PRIMARY KEY (id);


--
-- Name: bulk_operations bulk_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulk_operations
    ADD CONSTRAINT bulk_operations_pkey PRIMARY KEY (id);


--
-- Name: devices devices_fcm_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_fcm_token_key UNIQUE (fcm_token);


--
-- Name: devices devices_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_pkey PRIMARY KEY (id);


--
-- Name: doctor_credentials doctor_credentials_login_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_credentials
    ADD CONSTRAINT doctor_credentials_login_id_key UNIQUE (login_id);


--
-- Name: doctor_credentials doctor_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_credentials
    ADD CONSTRAINT doctor_credentials_pkey PRIMARY KEY (user_id);


--
-- Name: doctor_documents doctor_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_documents
    ADD CONSTRAINT doctor_documents_pkey PRIMARY KEY (id);


--
-- Name: doctor_hospitals doctor_hospitals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_hospitals
    ADD CONSTRAINT doctor_hospitals_pkey PRIMARY KEY (doctor_id, hospital_id);


--
-- Name: doctor_leaves doctor_leaves_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_leaves
    ADD CONSTRAINT doctor_leaves_pkey PRIMARY KEY (id);


--
-- Name: doctor_picks doctor_picks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_picks
    ADD CONSTRAINT doctor_picks_pkey PRIMARY KEY (doctor_id);


--
-- Name: doctor_types doctor_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_types
    ADD CONSTRAINT doctor_types_pkey PRIMARY KEY (id);


--
-- Name: doctors doctors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctors
    ADD CONSTRAINT doctors_pkey PRIMARY KEY (id);


--
-- Name: doctors doctors_registration_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctors
    ADD CONSTRAINT doctors_registration_unique UNIQUE (reg_council, reg_no);


--
-- Name: doctors doctors_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctors
    ADD CONSTRAINT doctors_user_id_key UNIQUE (user_id);


--
-- Name: emergency_kind_types emergency_kind_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emergency_kind_types
    ADD CONSTRAINT emergency_kind_types_pkey PRIMARY KEY (kind_id, type_id);


--
-- Name: emergency_kinds emergency_kinds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emergency_kinds
    ADD CONSTRAINT emergency_kinds_pkey PRIMARY KEY (id);


--
-- Name: emergency_status emergency_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emergency_status
    ADD CONSTRAINT emergency_status_pkey PRIMARY KEY (doctor_id);


--
-- Name: first_aid_guides first_aid_guides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.first_aid_guides
    ADD CONSTRAINT first_aid_guides_pkey PRIMARY KEY (kind_id);


--
-- Name: health_problems health_problems_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.health_problems
    ADD CONSTRAINT health_problems_pkey PRIMARY KEY (id);


--
-- Name: hospital_departments hospital_departments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hospital_departments
    ADD CONSTRAINT hospital_departments_pkey PRIMARY KEY (hospital_id, type_id);


--
-- Name: hospitals hospitals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hospitals
    ADD CONSTRAINT hospitals_pkey PRIMARY KEY (id);


--
-- Name: hospitals hospitals_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hospitals
    ADD CONSTRAINT hospitals_slug_key UNIQUE (slug);


--
-- Name: idempotency_keys idempotency_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (user_id, key);


--
-- Name: job_leases job_leases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.job_leases
    ADD CONSTRAINT job_leases_pkey PRIMARY KEY (name);


--
-- Name: notification_prefs notification_prefs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_prefs
    ADD CONSTRAINT notification_prefs_pkey PRIMARY KEY (user_id);


--
-- Name: notifications notifications_dedupe; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_dedupe UNIQUE (user_id, dedupe_key);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: opd_sessions opd_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.opd_sessions
    ADD CONSTRAINT opd_sessions_pkey PRIMARY KEY (id);


--
-- Name: opd_windows opd_windows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.opd_windows
    ADD CONSTRAINT opd_windows_pkey PRIMARY KEY (id);


--
-- Name: outbox outbox_dedupe_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox
    ADD CONSTRAINT outbox_dedupe_key_key UNIQUE (dedupe_key);


--
-- Name: outbox outbox_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox
    ADD CONSTRAINT outbox_pkey PRIMARY KEY (id);


--
-- Name: patient_profiles patient_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_profiles
    ADD CONSTRAINT patient_profiles_pkey PRIMARY KEY (user_id);


--
-- Name: payments payments_gateway_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_gateway_order_id_key UNIQUE (gateway_order_id);


--
-- Name: payments payments_gateway_payment_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_gateway_payment_id_key UNIQUE (gateway_payment_id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: payout_accounts payout_accounts_gateway_account_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payout_accounts
    ADD CONSTRAINT payout_accounts_gateway_account_id_key UNIQUE (beneficiary_id);


--
-- Name: payout_accounts payout_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payout_accounts
    ADD CONSTRAINT payout_accounts_pkey PRIMARY KEY (doctor_id);


--
-- Name: payouts payouts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payouts
    ADD CONSTRAINT payouts_pkey PRIMARY KEY (id);


--
-- Name: phone_otps phone_otps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phone_otps
    ADD CONSTRAINT phone_otps_pkey PRIMARY KEY (id);


--
-- Name: pick_purchases pick_purchases_gateway_order_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pick_purchases
    ADD CONSTRAINT pick_purchases_gateway_order_id_key UNIQUE (gateway_order_id);


--
-- Name: pick_purchases pick_purchases_gateway_payment_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pick_purchases
    ADD CONSTRAINT pick_purchases_gateway_payment_id_key UNIQUE (gateway_payment_id);


--
-- Name: pick_purchases pick_purchases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pick_purchases
    ADD CONSTRAINT pick_purchases_pkey PRIMARY KEY (id);


--
-- Name: problem_type_map problem_type_map_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.problem_type_map
    ADD CONSTRAINT problem_type_map_pkey PRIMARY KEY (problem_id, type_id, audience);


--
-- Name: queue_entries queue_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.queue_entries
    ADD CONSTRAINT queue_entries_pkey PRIMARY KEY (booking_id);


--
-- Name: queue_events queue_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.queue_events
    ADD CONSTRAINT queue_events_pkey PRIMARY KEY (id);


--
-- Name: queue_events queue_events_version_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.queue_events
    ADD CONSTRAINT queue_events_version_unique UNIQUE (session_id, version);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: refunds refunds_gateway_refund_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refunds
    ADD CONSTRAINT refunds_gateway_refund_id_key UNIQUE (gateway_refund_id);


--
-- Name: refunds refunds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refunds
    ADD CONSTRAINT refunds_pkey PRIMARY KEY (id);


--
-- Name: schedule_templates schedule_no_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_templates
    ADD CONSTRAINT schedule_no_overlap EXCLUDE USING gist (doctor_id WITH =, weekday WITH =, int4range((start_minute)::integer, (end_minute)::integer) WITH &&, daterange(valid_from, valid_to, '[]'::text) WITH &&);


--
-- Name: schedule_templates schedule_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_templates
    ADD CONSTRAINT schedule_templates_pkey PRIMARY KEY (id);


--
-- Name: opd_sessions sessions_no_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.opd_sessions
    ADD CONSTRAINT sessions_no_overlap EXCLUDE USING gist (doctor_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE ((status <> 'cancelled'::public.session_status));


--
-- Name: opd_sessions sessions_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.opd_sessions
    ADD CONSTRAINT sessions_unique UNIQUE (doctor_id, hospital_id, date, starts_at);


--
-- Name: support_tickets support_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_pkey PRIMARY KEY (id);


--
-- Name: transfers transfers_payment_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_payment_id_key UNIQUE (payment_id);


--
-- Name: transfers transfers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_pkey PRIMARY KEY (id);


--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (user_id, role);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_phone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_phone_key UNIQUE (phone);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: visit_feedback visit_feedback_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visit_feedback
    ADD CONSTRAINT visit_feedback_pkey PRIMARY KEY (booking_id);


--
-- Name: webhook_events webhook_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_events
    ADD CONSTRAINT webhook_events_pkey PRIMARY KEY (id);


--
-- Name: window_slots window_slots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.window_slots
    ADD CONSTRAINT window_slots_pkey PRIMARY KEY (window_id, token);


--
-- Name: opd_windows windows_session_token_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.opd_windows
    ADD CONSTRAINT windows_session_token_unique UNIQUE (id, token_start);


--
-- Name: opd_windows windows_unique_start; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.opd_windows
    ADD CONSTRAINT windows_unique_start UNIQUE (session_id, starts_at);


--
-- Name: opd_windows windows_unique_tokens; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.opd_windows
    ADD CONSTRAINT windows_unique_tokens UNIQUE (session_id, token_start);


--
-- Name: admin_setup_tokens_admin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_setup_tokens_admin_idx ON public.admin_setup_tokens USING btree (admin_id);


--
-- Name: admin_users_only_one_active; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX admin_users_only_one_active ON public.admin_users USING btree ((true)) WHERE (status = 'active'::public.user_status);


--
-- Name: approvals_one_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX approvals_one_open ON public.approval_requests USING btree (kind, subject_type, subject_id) WHERE (decision = 'pending'::public.approval_decision);


--
-- Name: approvals_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approvals_pending_idx ON public.approval_requests USING btree (requested_at) WHERE (decision = 'pending'::public.approval_decision);


--
-- Name: audit_log_actor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_actor_idx ON public.audit_log USING btree (actor_id, at DESC);


--
-- Name: audit_log_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_log_entity_idx ON public.audit_log USING btree (entity, entity_id);


--
-- Name: booking_events_booking_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX booking_events_booking_idx ON public.booking_events USING btree (booking_id, at);


--
-- Name: bookings_doctor_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bookings_doctor_date_idx ON public.bookings USING btree (doctor_id, session_date);


--
-- Name: bookings_holds_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bookings_holds_idx ON public.bookings USING btree (hold_expires_at) WHERE (status = 'pending_payment'::public.booking_status);


--
-- Name: bookings_live_token_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX bookings_live_token_unique ON public.bookings USING btree (session_id, source, token) WHERE (status = ANY (ARRAY['pending_payment'::public.booking_status, 'confirmed'::public.booking_status, 'completed'::public.booking_status, 'no_show'::public.booking_status]));


--
-- Name: bookings_needs_new_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bookings_needs_new_time_idx ON public.bookings USING btree (needs_new_time_since) WHERE (needs_new_time_since IS NOT NULL);


--
-- Name: bookings_one_emergency_per_doctor_day; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX bookings_one_emergency_per_doctor_day ON public.bookings USING btree (patient_user_id, doctor_id, session_date) WHERE ((source = 'emergency'::public.booking_source) AND (status = ANY (ARRAY['pending_payment'::public.booking_status, 'confirmed'::public.booking_status])));


--
-- Name: bookings_one_per_doctor_day; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX bookings_one_per_doctor_day ON public.bookings USING btree (patient_user_id, doctor_id, session_date) WHERE ((source = 'online'::public.booking_source) AND (status = ANY (ARRAY['pending_payment'::public.booking_status, 'confirmed'::public.booking_status])));


--
-- Name: bookings_patient_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bookings_patient_idx ON public.bookings USING btree (patient_user_id, created_at DESC);


--
-- Name: bookings_session_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bookings_session_idx ON public.bookings USING btree (session_id, status);


--
-- Name: devices_install_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX devices_install_idx ON public.devices USING btree (install_id) WHERE (install_id IS NOT NULL);


--
-- Name: devices_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX devices_user_idx ON public.devices USING btree (user_id);


--
-- Name: doctor_documents_doctor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX doctor_documents_doctor_idx ON public.doctor_documents USING btree (doctor_id);


--
-- Name: doctor_hospitals_hospital_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX doctor_hospitals_hospital_idx ON public.doctor_hospitals USING btree (hospital_id);


--
-- Name: doctor_hospitals_one_primary; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX doctor_hospitals_one_primary ON public.doctor_hospitals USING btree (doctor_id) WHERE is_primary;


--
-- Name: doctor_leaves_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX doctor_leaves_unique ON public.doctor_leaves USING btree (doctor_id, COALESCE(hospital_id, '00000000-0000-0000-0000-000000000000'::uuid), date);


--
-- Name: doctors_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX doctors_name_trgm ON public.doctors USING gin (name public.gin_trgm_ops);


--
-- Name: doctors_public_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX doctors_public_type_idx ON public.doctors USING btree (type_id) WHERE ((verification = 'verified'::public.doctor_verification) AND (status = 'active'::public.doctor_status));


--
-- Name: doctors_search_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX doctors_search_idx ON public.doctors USING gin (search_vector);


--
-- Name: emergency_status_on_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX emergency_status_on_idx ON public.emergency_status USING btree (status) WHERE (status <> 'off'::public.emergency_state);


--
-- Name: hospitals_name_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hospitals_name_trgm ON public.hospitals USING gin (name public.gin_trgm_ops);


--
-- Name: hospitals_near_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hospitals_near_idx ON public.hospitals USING gist (public.ll_to_earth(lat, lng)) WHERE (status = 'active'::public.record_status);


--
-- Name: hospitals_search_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX hospitals_search_idx ON public.hospitals USING gin (search);


--
-- Name: idempotency_keys_age_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idempotency_keys_age_idx ON public.idempotency_keys USING btree (created_at);


--
-- Name: notifications_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_created_idx ON public.notifications USING btree (created_at);


--
-- Name: notifications_unread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_unread_idx ON public.notifications USING btree (user_id) WHERE (read_at IS NULL);


--
-- Name: notifications_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_user_idx ON public.notifications USING btree (user_id, created_at DESC);


--
-- Name: opd_sessions_doctor_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX opd_sessions_doctor_date_idx ON public.opd_sessions USING btree (doctor_id, date);


--
-- Name: opd_sessions_hospital_date_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX opd_sessions_hospital_date_idx ON public.opd_sessions USING btree (hospital_id, date);


--
-- Name: opd_sessions_live_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX opd_sessions_live_idx ON public.opd_sessions USING btree (status) WHERE (status = ANY (ARRAY['running'::public.session_status, 'paused'::public.session_status]));


--
-- Name: opd_windows_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX opd_windows_open_idx ON public.opd_windows USING btree (starts_at) WHERE (status = 'open'::public.window_status);


--
-- Name: outbox_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX outbox_pending_idx ON public.outbox USING btree (available_at) WHERE (done_at IS NULL);


--
-- Name: payments_booking_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payments_booking_idx ON public.payments USING btree (booking_id);


--
-- Name: payments_one_open_order; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payments_one_open_order ON public.payments USING btree (booking_id) WHERE ((status = ANY (ARRAY['created'::public.payment_status, 'authorized'::public.payment_status])) AND (NOT abandoned));


--
-- Name: payouts_doctor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payouts_doctor_idx ON public.payouts USING btree (doctor_id, created_at DESC);


--
-- Name: payouts_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payouts_pending_idx ON public.payouts USING btree (created_at) WHERE (status = 'pending'::text);


--
-- Name: phone_otps_phone_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX phone_otps_phone_idx ON public.phone_otps USING btree (phone, created_at DESC);


--
-- Name: pick_purchases_patient_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX pick_purchases_patient_idx ON public.pick_purchases USING btree (patient_user_id, created_at DESC);


--
-- Name: queue_entries_line_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX queue_entries_line_idx ON public.queue_entries USING btree (session_id, state, order_key);


--
-- Name: queue_events_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX queue_events_at_idx ON public.queue_events USING btree (at);


--
-- Name: queue_one_with_doctor; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX queue_one_with_doctor ON public.queue_entries USING btree (session_id) WHERE (state = 'with_doctor'::public.queue_state);


--
-- Name: refresh_tokens_admin_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX refresh_tokens_admin_idx ON public.refresh_tokens USING btree (admin_id) WHERE (revoked_at IS NULL);


--
-- Name: refresh_tokens_family_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX refresh_tokens_family_idx ON public.refresh_tokens USING btree (family_id);


--
-- Name: refresh_tokens_live_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX refresh_tokens_live_user_idx ON public.refresh_tokens USING btree (user_id, role, family_id) WHERE (revoked_at IS NULL);


--
-- Name: refresh_tokens_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX refresh_tokens_user_idx ON public.refresh_tokens USING btree (user_id) WHERE (revoked_at IS NULL);


--
-- Name: refunds_payment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX refunds_payment_idx ON public.refunds USING btree (payment_id);


--
-- Name: refunds_retry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX refunds_retry_idx ON public.refunds USING btree (next_attempt_at) WHERE (status = ANY (ARRAY['pending'::public.refund_status, 'failed'::public.refund_status]));


--
-- Name: support_tickets_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_tickets_open_idx ON public.support_tickets USING btree (created_at) WHERE (status = 'open'::public.ticket_status);


--
-- Name: transfers_doctor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transfers_doctor_idx ON public.transfers USING btree (doctor_id, created_at DESC);


--
-- Name: transfers_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transfers_due_idx ON public.transfers USING btree (release_at) WHERE (status = 'on_hold'::public.transfer_status);


--
-- Name: transfers_payout_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transfers_payout_idx ON public.transfers USING btree (payout_id);


--
-- Name: transfers_recover_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX transfers_recover_idx ON public.transfers USING btree (doctor_id) WHERE (recover_paise > 0);


--
-- Name: visit_feedback_doctor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX visit_feedback_doctor_idx ON public.visit_feedback USING btree (doctor_id, created_at DESC);


--
-- Name: webhook_events_pending_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX webhook_events_pending_idx ON public.webhook_events USING btree (received_at) WHERE (processed_at IS NULL);


--
-- Name: window_slots_free_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX window_slots_free_idx ON public.window_slots USING btree (window_id, token) WHERE (state = 'free'::public.slot_state);


--
-- Name: window_slots_held_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX window_slots_held_idx ON public.window_slots USING btree (held_until) WHERE (state = 'held'::public.slot_state);


--
-- Name: window_slots_one_per_booking; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX window_slots_one_per_booking ON public.window_slots USING btree (booking_id) WHERE (booking_id IS NOT NULL);


--
-- Name: admin_users admin_users_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER admin_users_set_updated_at BEFORE UPDATE ON public.admin_users FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: app_config app_config_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER app_config_set_updated_at BEFORE UPDATE ON public.app_config FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: approval_requests approval_requests_decision_transition; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER approval_requests_decision_transition BEFORE UPDATE OF decision ON public.approval_requests FOR EACH ROW EXECUTE FUNCTION public.enforce_transition('decision');


--
-- Name: audit_log audit_log_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_log_append_only BEFORE DELETE OR UPDATE ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.refuse_change();


--
-- Name: audit_log audit_log_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON public.audit_log FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_change();


--
-- Name: booking_events booking_events_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER booking_events_append_only BEFORE DELETE OR UPDATE ON public.booking_events FOR EACH ROW EXECUTE FUNCTION public.refuse_change();


--
-- Name: booking_events booking_events_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER booking_events_no_truncate BEFORE TRUNCATE ON public.booking_events FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_change();


--
-- Name: bookings bookings_initial_status; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER bookings_initial_status BEFORE INSERT ON public.bookings FOR EACH ROW EXECUTE FUNCTION public.check_booking_initial_status();


--
-- Name: bookings bookings_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER bookings_set_updated_at BEFORE UPDATE ON public.bookings FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: bookings bookings_status_transition; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER bookings_status_transition BEFORE UPDATE OF status ON public.bookings FOR EACH ROW EXECUTE FUNCTION public.enforce_transition('status');


--
-- Name: bulk_operations bulk_operations_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER bulk_operations_set_updated_at BEFORE UPDATE ON public.bulk_operations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: devices devices_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER devices_set_updated_at BEFORE UPDATE ON public.devices FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: doctor_credentials doctor_credentials_admin_only_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER doctor_credentials_admin_only_insert BEFORE INSERT ON public.doctor_credentials FOR EACH ROW EXECUTE FUNCTION public.require_admin_to_create();


--
-- Name: doctor_credentials doctor_credentials_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER doctor_credentials_set_updated_at BEFORE UPDATE ON public.doctor_credentials FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: doctor_hospitals doctor_hospitals_admin_only_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER doctor_hospitals_admin_only_insert BEFORE INSERT ON public.doctor_hospitals FOR EACH ROW EXECUTE FUNCTION public.require_admin_to_create();


--
-- Name: doctor_picks doctor_picks_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER doctor_picks_set_updated_at BEFORE UPDATE ON public.doctor_picks FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: doctors doctors_admin_only_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER doctors_admin_only_insert BEFORE INSERT ON public.doctors FOR EACH ROW EXECUTE FUNCTION public.require_admin_to_create();


--
-- Name: doctors doctors_self_edit_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER doctors_self_edit_guard BEFORE UPDATE ON public.doctors FOR EACH ROW EXECUTE FUNCTION public.guard_doctor_self_edit();


--
-- Name: doctors doctors_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER doctors_set_updated_at BEFORE UPDATE ON public.doctors FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: emergency_status emergency_status_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER emergency_status_set_updated_at BEFORE UPDATE ON public.emergency_status FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: first_aid_guides first_aid_guides_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER first_aid_guides_set_updated_at BEFORE UPDATE ON public.first_aid_guides FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: hospitals hospitals_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER hospitals_set_updated_at BEFORE UPDATE ON public.hospitals FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: notification_prefs notification_prefs_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notification_prefs_set_updated_at BEFORE UPDATE ON public.notification_prefs FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: opd_sessions opd_sessions_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER opd_sessions_set_updated_at BEFORE UPDATE ON public.opd_sessions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: opd_sessions opd_sessions_status_transition; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER opd_sessions_status_transition BEFORE UPDATE OF status ON public.opd_sessions FOR EACH ROW EXECUTE FUNCTION public.enforce_transition('status');


--
-- Name: opd_windows opd_windows_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER opd_windows_set_updated_at BEFORE UPDATE ON public.opd_windows FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: patient_profiles patient_profiles_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER patient_profiles_set_updated_at BEFORE UPDATE ON public.patient_profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: payments payments_amount_matches_booking; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER payments_amount_matches_booking BEFORE INSERT OR UPDATE OF amount_paise, booking_id ON public.payments FOR EACH ROW EXECUTE FUNCTION public.check_payment_amount();


--
-- Name: payments payments_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER payments_set_updated_at BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: payments payments_status_transition; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER payments_status_transition BEFORE UPDATE OF status ON public.payments FOR EACH ROW EXECUTE FUNCTION public.enforce_transition('status');


--
-- Name: payout_accounts payout_accounts_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER payout_accounts_set_updated_at BEFORE UPDATE ON public.payout_accounts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: payouts payouts_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER payouts_set_updated_at BEFORE UPDATE ON public.payouts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: pick_purchases pick_purchases_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER pick_purchases_set_updated_at BEFORE UPDATE ON public.pick_purchases FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: queue_entries queue_entries_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER queue_entries_set_updated_at BEFORE UPDATE ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: queue_entries queue_entries_state_transition; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER queue_entries_state_transition BEFORE UPDATE OF state ON public.queue_entries FOR EACH ROW EXECUTE FUNCTION public.enforce_transition('state');


--
-- Name: queue_events queue_events_append_only; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER queue_events_append_only BEFORE DELETE OR UPDATE ON public.queue_events FOR EACH ROW EXECUTE FUNCTION public.queue_events_guard();


--
-- Name: queue_events queue_events_no_truncate; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER queue_events_no_truncate BEFORE TRUNCATE ON public.queue_events FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_change();


--
-- Name: refunds refunds_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER refunds_set_updated_at BEFORE UPDATE ON public.refunds FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: refunds refunds_status_transition; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER refunds_status_transition BEFORE UPDATE OF status ON public.refunds FOR EACH ROW EXECUTE FUNCTION public.enforce_transition('status');


--
-- Name: refunds refunds_total_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER refunds_total_check BEFORE INSERT OR UPDATE OF amount_paise, status ON public.refunds FOR EACH ROW EXECUTE FUNCTION public.check_refund_total();


--
-- Name: schedule_templates schedule_templates_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER schedule_templates_set_updated_at BEFORE UPDATE ON public.schedule_templates FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: support_tickets support_tickets_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER support_tickets_set_updated_at BEFORE UPDATE ON public.support_tickets FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: transfers transfers_amount_is_doctor_share; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER transfers_amount_is_doctor_share BEFORE INSERT OR UPDATE OF amount_paise, payment_id ON public.transfers FOR EACH ROW EXECUTE FUNCTION public.check_transfer_amount();


--
-- Name: transfers transfers_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER transfers_set_updated_at BEFORE UPDATE ON public.transfers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: transfers transfers_status_transition; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER transfers_status_transition BEFORE UPDATE OF status ON public.transfers FOR EACH ROW EXECUTE FUNCTION public.enforce_transition('status');


--
-- Name: users users_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: window_slots window_slots_in_range; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER window_slots_in_range BEFORE INSERT OR UPDATE OF token, window_id ON public.window_slots FOR EACH ROW EXECUTE FUNCTION public.check_slot_in_range();


--
-- Name: window_slots window_slots_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER window_slots_set_updated_at BEFORE UPDATE ON public.window_slots FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: window_slots window_slots_state_transition; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER window_slots_state_transition BEFORE UPDATE OF state ON public.window_slots FOR EACH ROW EXECUTE FUNCTION public.enforce_transition('state');


--
-- Name: admin_setup_tokens admin_setup_tokens_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_setup_tokens
    ADD CONSTRAINT admin_setup_tokens_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.admin_users(id) ON DELETE CASCADE;


--
-- Name: approval_requests approval_requests_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES public.admin_users(id);


--
-- Name: approval_requests approval_requests_requested_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_requests
    ADD CONSTRAINT approval_requests_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES public.admin_users(id);


--
-- Name: booking_events booking_events_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.booking_events
    ADD CONSTRAINT booking_events_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE CASCADE;


--
-- Name: bookings bookings_doctor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.doctors(id);


--
-- Name: bookings bookings_hospital_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_hospital_id_fkey FOREIGN KEY (hospital_id) REFERENCES public.hospitals(id);


--
-- Name: bookings bookings_patient_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_patient_user_id_fkey FOREIGN KEY (patient_user_id) REFERENCES public.users(id);


--
-- Name: bookings bookings_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.opd_sessions(id);


--
-- Name: bookings bookings_slot_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_slot_fk FOREIGN KEY (window_id, slot_token) REFERENCES public.window_slots(window_id, token) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: bookings bookings_window_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_window_id_fkey FOREIGN KEY (window_id) REFERENCES public.opd_windows(id);


--
-- Name: bulk_operations bulk_operations_doctor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulk_operations
    ADD CONSTRAINT bulk_operations_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.doctors(id);


--
-- Name: bulk_operations bulk_operations_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bulk_operations
    ADD CONSTRAINT bulk_operations_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.opd_sessions(id);


--
-- Name: devices devices_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.devices
    ADD CONSTRAINT devices_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: doctor_credentials doctor_credentials_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_credentials
    ADD CONSTRAINT doctor_credentials_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: doctor_documents doctor_documents_doctor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_documents
    ADD CONSTRAINT doctor_documents_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.doctors(id) ON DELETE CASCADE;


--
-- Name: doctor_documents doctor_documents_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_documents
    ADD CONSTRAINT doctor_documents_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.admin_users(id);


--
-- Name: doctor_hospitals doctor_hospitals_doctor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_hospitals
    ADD CONSTRAINT doctor_hospitals_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.doctors(id) ON DELETE CASCADE;


--
-- Name: doctor_hospitals doctor_hospitals_hospital_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_hospitals
    ADD CONSTRAINT doctor_hospitals_hospital_id_fkey FOREIGN KEY (hospital_id) REFERENCES public.hospitals(id);


--
-- Name: doctor_leaves doctor_leaves_doctor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_leaves
    ADD CONSTRAINT doctor_leaves_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.doctors(id) ON DELETE CASCADE;


--
-- Name: doctor_leaves doctor_leaves_hospital_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_leaves
    ADD CONSTRAINT doctor_leaves_hospital_id_fkey FOREIGN KEY (hospital_id) REFERENCES public.hospitals(id);


--
-- Name: doctor_picks doctor_picks_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_picks
    ADD CONSTRAINT doctor_picks_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.admin_users(id);


--
-- Name: doctor_picks doctor_picks_doctor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_picks
    ADD CONSTRAINT doctor_picks_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.doctors(id) ON DELETE CASCADE;


--
-- Name: doctor_picks doctor_picks_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctor_picks
    ADD CONSTRAINT doctor_picks_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.admin_users(id);


--
-- Name: doctors doctors_created_by_admin_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctors
    ADD CONSTRAINT doctors_created_by_admin_fkey FOREIGN KEY (created_by_admin) REFERENCES public.admin_users(id);


--
-- Name: doctors doctors_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctors
    ADD CONSTRAINT doctors_type_id_fkey FOREIGN KEY (type_id) REFERENCES public.doctor_types(id);


--
-- Name: doctors doctors_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctors
    ADD CONSTRAINT doctors_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: doctors doctors_verified_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.doctors
    ADD CONSTRAINT doctors_verified_by_fkey FOREIGN KEY (verified_by) REFERENCES public.admin_users(id);


--
-- Name: emergency_kind_types emergency_kind_types_kind_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emergency_kind_types
    ADD CONSTRAINT emergency_kind_types_kind_id_fkey FOREIGN KEY (kind_id) REFERENCES public.emergency_kinds(id) ON DELETE CASCADE;


--
-- Name: emergency_kind_types emergency_kind_types_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emergency_kind_types
    ADD CONSTRAINT emergency_kind_types_type_id_fkey FOREIGN KEY (type_id) REFERENCES public.doctor_types(id);


--
-- Name: emergency_status emergency_status_doctor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emergency_status
    ADD CONSTRAINT emergency_status_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.doctors(id) ON DELETE CASCADE;


--
-- Name: emergency_status emergency_status_hospital_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emergency_status
    ADD CONSTRAINT emergency_status_hospital_id_fkey FOREIGN KEY (hospital_id) REFERENCES public.hospitals(id);


--
-- Name: first_aid_guides first_aid_guides_kind_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.first_aid_guides
    ADD CONSTRAINT first_aid_guides_kind_id_fkey FOREIGN KEY (kind_id) REFERENCES public.emergency_kinds(id) ON DELETE CASCADE;


--
-- Name: hospital_departments hospital_departments_hospital_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hospital_departments
    ADD CONSTRAINT hospital_departments_hospital_id_fkey FOREIGN KEY (hospital_id) REFERENCES public.hospitals(id) ON DELETE CASCADE;


--
-- Name: hospital_departments hospital_departments_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hospital_departments
    ADD CONSTRAINT hospital_departments_type_id_fkey FOREIGN KEY (type_id) REFERENCES public.doctor_types(id);


--
-- Name: notification_prefs notification_prefs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_prefs
    ADD CONSTRAINT notification_prefs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE SET NULL;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: opd_sessions opd_sessions_doctor_id_hospital_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.opd_sessions
    ADD CONSTRAINT opd_sessions_doctor_id_hospital_id_fkey FOREIGN KEY (doctor_id, hospital_id) REFERENCES public.doctor_hospitals(doctor_id, hospital_id);


--
-- Name: opd_sessions opd_sessions_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.opd_sessions
    ADD CONSTRAINT opd_sessions_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.schedule_templates(id) ON DELETE SET NULL;


--
-- Name: opd_windows opd_windows_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.opd_windows
    ADD CONSTRAINT opd_windows_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.opd_sessions(id) ON DELETE CASCADE;


--
-- Name: patient_profiles patient_profiles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.patient_profiles
    ADD CONSTRAINT patient_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: payments payments_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id);


--
-- Name: payout_accounts payout_accounts_doctor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payout_accounts
    ADD CONSTRAINT payout_accounts_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.doctors(id) ON DELETE CASCADE;


--
-- Name: payouts payouts_doctor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payouts
    ADD CONSTRAINT payouts_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.doctors(id);


--
-- Name: pick_purchases pick_purchases_patient_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pick_purchases
    ADD CONSTRAINT pick_purchases_patient_user_id_fkey FOREIGN KEY (patient_user_id) REFERENCES public.users(id);


--
-- Name: pick_purchases pick_purchases_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pick_purchases
    ADD CONSTRAINT pick_purchases_type_id_fkey FOREIGN KEY (type_id) REFERENCES public.doctor_types(id);


--
-- Name: problem_type_map problem_type_map_problem_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.problem_type_map
    ADD CONSTRAINT problem_type_map_problem_id_fkey FOREIGN KEY (problem_id) REFERENCES public.health_problems(id) ON DELETE CASCADE;


--
-- Name: problem_type_map problem_type_map_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.problem_type_map
    ADD CONSTRAINT problem_type_map_type_id_fkey FOREIGN KEY (type_id) REFERENCES public.doctor_types(id);


--
-- Name: queue_entries queue_entries_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.queue_entries
    ADD CONSTRAINT queue_entries_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE CASCADE;


--
-- Name: queue_entries queue_entries_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.queue_entries
    ADD CONSTRAINT queue_entries_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.opd_sessions(id) ON DELETE CASCADE;


--
-- Name: queue_events queue_events_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.queue_events
    ADD CONSTRAINT queue_events_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE SET NULL;


--
-- Name: queue_events queue_events_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.queue_events
    ADD CONSTRAINT queue_events_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.opd_sessions(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.admin_users(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_device_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_device_id_fkey FOREIGN KEY (device_id) REFERENCES public.devices(id) ON DELETE SET NULL;


--
-- Name: refresh_tokens refresh_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refresh_tokens
    ADD CONSTRAINT refresh_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: refunds refunds_approved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refunds
    ADD CONSTRAINT refunds_approved_by_fkey FOREIGN KEY (approved_by) REFERENCES public.admin_users(id);


--
-- Name: refunds refunds_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.refunds
    ADD CONSTRAINT refunds_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id);


--
-- Name: schedule_templates schedule_templates_doctor_id_hospital_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schedule_templates
    ADD CONSTRAINT schedule_templates_doctor_id_hospital_id_fkey FOREIGN KEY (doctor_id, hospital_id) REFERENCES public.doctor_hospitals(doctor_id, hospital_id) ON DELETE CASCADE;


--
-- Name: support_tickets support_tickets_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES public.admin_users(id);


--
-- Name: support_tickets support_tickets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: transfers transfers_doctor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.doctors(id);


--
-- Name: transfers transfers_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id);


--
-- Name: transfers transfers_payout_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_payout_id_fkey FOREIGN KEY (payout_id) REFERENCES public.payouts(id);


--
-- Name: transfers transfers_recovered_in_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transfers
    ADD CONSTRAINT transfers_recovered_in_fkey FOREIGN KEY (recovered_in) REFERENCES public.payouts(id);


--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: visit_feedback visit_feedback_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visit_feedback
    ADD CONSTRAINT visit_feedback_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id);


--
-- Name: visit_feedback visit_feedback_doctor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visit_feedback
    ADD CONSTRAINT visit_feedback_doctor_id_fkey FOREIGN KEY (doctor_id) REFERENCES public.doctors(id);


--
-- Name: visit_feedback visit_feedback_patient_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.visit_feedback
    ADD CONSTRAINT visit_feedback_patient_user_id_fkey FOREIGN KEY (patient_user_id) REFERENCES public.users(id);


--
-- Name: window_slots window_slots_booking_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.window_slots
    ADD CONSTRAINT window_slots_booking_fk FOREIGN KEY (booking_id) REFERENCES public.bookings(id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: window_slots window_slots_window_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.window_slots
    ADD CONSTRAINT window_slots_window_id_fkey FOREIGN KEY (window_id) REFERENCES public.opd_windows(id) ON DELETE CASCADE;


--
-- Name: bookings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;

--
-- Name: bookings bookings_doctor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bookings_doctor ON public.bookings USING (((public.app_role() = 'doctor'::text) AND (doctor_id = public.app_doctor_id()))) WITH CHECK (((public.app_role() = 'doctor'::text) AND (doctor_id = public.app_doctor_id())));


--
-- Name: bookings bookings_patient; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bookings_patient ON public.bookings USING (((public.app_role() = 'patient'::text) AND (patient_user_id = public.app_user_id()))) WITH CHECK (((public.app_role() = 'patient'::text) AND (patient_user_id = public.app_user_id())));


--
-- Name: bookings bookings_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bookings_staff ON public.bookings USING ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text]))) WITH CHECK ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text])));


--
-- Name: devices; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;

--
-- Name: devices devices_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY devices_self ON public.devices USING (((public.app_role() = ANY (ARRAY['patient'::text, 'doctor'::text])) AND (user_id = public.app_user_id()))) WITH CHECK (((public.app_role() = ANY (ARRAY['patient'::text, 'doctor'::text])) AND (user_id = public.app_user_id())));


--
-- Name: devices devices_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY devices_staff ON public.devices USING ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text]))) WITH CHECK ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text])));


--
-- Name: doctor_picks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.doctor_picks ENABLE ROW LEVEL SECURITY;

--
-- Name: doctor_picks doctor_picks_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY doctor_picks_staff ON public.doctor_picks USING ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text]))) WITH CHECK ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text])));


--
-- Name: doctors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.doctors ENABLE ROW LEVEL SECURITY;

--
-- Name: doctors doctors_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY doctors_read ON public.doctors FOR SELECT USING (true);


--
-- Name: doctors doctors_self_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY doctors_self_update ON public.doctors FOR UPDATE USING (((public.app_role() = 'doctor'::text) AND (id = public.app_doctor_id()))) WITH CHECK (((public.app_role() = 'doctor'::text) AND (id = public.app_doctor_id())));


--
-- Name: doctors doctors_staff_write; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY doctors_staff_write ON public.doctors USING ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text]))) WITH CHECK ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text])));


--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications notifications_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notifications_self ON public.notifications USING (((public.app_role() = ANY (ARRAY['patient'::text, 'doctor'::text])) AND (user_id = public.app_user_id()))) WITH CHECK (((public.app_role() = ANY (ARRAY['patient'::text, 'doctor'::text])) AND (user_id = public.app_user_id())));


--
-- Name: notifications notifications_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notifications_staff ON public.notifications USING ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text]))) WITH CHECK ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text])));


--
-- Name: patient_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.patient_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: patient_profiles patient_profiles_self; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY patient_profiles_self ON public.patient_profiles USING (((public.app_role() = 'patient'::text) AND (user_id = public.app_user_id()))) WITH CHECK (((public.app_role() = 'patient'::text) AND (user_id = public.app_user_id())));


--
-- Name: patient_profiles patient_profiles_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY patient_profiles_staff ON public.patient_profiles USING ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text]))) WITH CHECK ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text])));


--
-- Name: payments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

--
-- Name: payments payments_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payments_owner ON public.payments USING (((public.app_role() = ANY (ARRAY['patient'::text, 'doctor'::text])) AND (EXISTS ( SELECT 1
   FROM public.bookings b
  WHERE (b.id = payments.booking_id))))) WITH CHECK (((public.app_role() = ANY (ARRAY['patient'::text, 'doctor'::text])) AND (EXISTS ( SELECT 1
   FROM public.bookings b
  WHERE (b.id = payments.booking_id)))));


--
-- Name: payments payments_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payments_staff ON public.payments USING ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text]))) WITH CHECK ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text])));


--
-- Name: payouts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payouts ENABLE ROW LEVEL SECURITY;

--
-- Name: payouts payouts_doctor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payouts_doctor ON public.payouts USING (((public.app_role() = 'doctor'::text) AND (doctor_id = public.app_doctor_id())));


--
-- Name: payouts payouts_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY payouts_staff ON public.payouts USING ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text]))) WITH CHECK ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text])));


--
-- Name: phone_otps; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.phone_otps ENABLE ROW LEVEL SECURITY;

--
-- Name: phone_otps phone_otps_system; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY phone_otps_system ON public.phone_otps USING ((public.app_role() = 'system'::text)) WITH CHECK ((public.app_role() = 'system'::text));


--
-- Name: pick_purchases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pick_purchases ENABLE ROW LEVEL SECURITY;

--
-- Name: pick_purchases pick_purchases_patient; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pick_purchases_patient ON public.pick_purchases USING (((public.app_role() = 'patient'::text) AND (patient_user_id = public.app_user_id()))) WITH CHECK (((public.app_role() = 'patient'::text) AND (patient_user_id = public.app_user_id())));


--
-- Name: pick_purchases pick_purchases_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY pick_purchases_staff ON public.pick_purchases USING ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text]))) WITH CHECK ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text])));


--
-- Name: queue_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.queue_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: queue_entries queue_entries_doctor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY queue_entries_doctor ON public.queue_entries USING (((public.app_role() = 'doctor'::text) AND (EXISTS ( SELECT 1
   FROM public.opd_sessions s
  WHERE ((s.id = queue_entries.session_id) AND (s.doctor_id = public.app_doctor_id())))))) WITH CHECK (((public.app_role() = 'doctor'::text) AND (EXISTS ( SELECT 1
   FROM public.opd_sessions s
  WHERE ((s.id = queue_entries.session_id) AND (s.doctor_id = public.app_doctor_id()))))));


--
-- Name: queue_entries queue_entries_patient; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY queue_entries_patient ON public.queue_entries FOR SELECT USING (((public.app_role() = 'patient'::text) AND (EXISTS ( SELECT 1
   FROM public.bookings b
  WHERE ((b.id = queue_entries.booking_id) AND (b.patient_user_id = public.app_user_id()))))));


--
-- Name: queue_entries queue_entries_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY queue_entries_staff ON public.queue_entries USING ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text]))) WITH CHECK ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text])));


--
-- Name: refunds; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.refunds ENABLE ROW LEVEL SECURITY;

--
-- Name: refunds refunds_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY refunds_owner ON public.refunds USING (((public.app_role() = ANY (ARRAY['patient'::text, 'doctor'::text])) AND (EXISTS ( SELECT 1
   FROM public.payments p
  WHERE (p.id = refunds.payment_id))))) WITH CHECK (((public.app_role() = ANY (ARRAY['patient'::text, 'doctor'::text])) AND (EXISTS ( SELECT 1
   FROM public.payments p
  WHERE (p.id = refunds.payment_id)))));


--
-- Name: refunds refunds_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY refunds_staff ON public.refunds USING ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text]))) WITH CHECK ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text])));


--
-- Name: transfers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.transfers ENABLE ROW LEVEL SECURITY;

--
-- Name: transfers transfers_doctor; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transfers_doctor ON public.transfers USING (((public.app_role() = 'doctor'::text) AND (doctor_id = public.app_doctor_id()))) WITH CHECK (((public.app_role() = 'doctor'::text) AND (doctor_id = public.app_doctor_id())));


--
-- Name: transfers transfers_patient; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transfers_patient ON public.transfers USING (((public.app_role() = 'patient'::text) AND (EXISTS ( SELECT 1
   FROM public.payments p
  WHERE (p.id = transfers.payment_id))))) WITH CHECK (((public.app_role() = 'patient'::text) AND (EXISTS ( SELECT 1
   FROM public.payments p
  WHERE (p.id = transfers.payment_id)))));


--
-- Name: transfers transfers_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY transfers_staff ON public.transfers USING ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text]))) WITH CHECK ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text])));


--
-- Name: visit_feedback; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.visit_feedback ENABLE ROW LEVEL SECURITY;

--
-- Name: visit_feedback visit_feedback_patient; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY visit_feedback_patient ON public.visit_feedback USING (((public.app_role() = 'patient'::text) AND (patient_user_id = public.app_user_id()))) WITH CHECK (((public.app_role() = 'patient'::text) AND (patient_user_id = public.app_user_id())));


--
-- Name: visit_feedback visit_feedback_staff; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY visit_feedback_staff ON public.visit_feedback USING ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text]))) WITH CHECK ((public.app_role() = ANY (ARRAY['admin'::text, 'system'::text])));


--
-- PostgreSQL database dump complete
--

\unrestrict JtOAc79kGTxG37ji0SeKfR2LLMoIR4mwaVOllDXRPilRiw2me8ACrwa9Ny0ggY0

--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.schema_migrations (
    version character varying NOT NULL PRIMARY KEY
);

--
-- Dbmate schema migrations
--

INSERT INTO public.schema_migrations (version) VALUES
    ('20260925000100'),
    ('20260925000200'),
    ('20260925000300'),
    ('20260925000400'),
    ('20260925000500'),
    ('20260925000600'),
    ('20260925000700'),
    ('20260925000800'),
    ('20260925000900'),
    ('20260925001000'),
    ('20260925001100'),
    ('20260925001200'),
    ('20260925001300'),
    ('20260925001400'),
    ('20260925001500'),
    ('20260925001600'),
    ('20260925001700'),
    ('20260925001800'),
    ('20260925001900'),
    ('20260925002000'),
    ('20260925002100'),
    ('20260925002200'),
    ('20260926002300'),
    ('20260926002400'),
    ('20260926002500'),
    ('20260927000100'),
    ('20260927000200'),
    ('20260927000300'),
    ('20260928000100'),
    ('20260929000100');
