-- OPflow · 0200 · Enumerated types used across modules.
-- Adding a value later: `alter type … add value '…'` in a new migration (it cannot run inside a transaction
-- block on older Postgres; dbmate handles one statement per file fine). Never remove or rename a value in place.

-- migrate:up

create type user_status          as enum ('active', 'suspended', 'deleted');
create type user_role            as enum ('patient', 'doctor', 'admin');
create type admin_role           as enum ('super', 'ops', 'finance', 'support');
create type actor_type           as enum ('patient', 'doctor', 'admin', 'system');
create type device_platform      as enum ('android', 'ios', 'web');
create type gender               as enum ('male', 'female', 'other');
create type record_status        as enum ('active', 'hidden');

create type doctor_verification  as enum ('pending', 'verified', 'needs_correction', 'rejected');
create type doctor_status        as enum ('active', 'suspended');
create type document_kind        as enum ('degree', 'registration', 'id_proof', 'other');
create type review_status        as enum ('pending', 'approved', 'rejected');
create type payout_status        as enum ('pending', 'active', 'suspended');
create type emergency_state      as enum ('off', 'available_now', 'available_till', 'on_call');
create type emergency_mode       as enum ('at_hospital', 'phone_first');
create type audience             as enum ('adult', 'child');

create type session_status       as enum ('scheduled', 'running', 'paused', 'ended', 'cancelled');
create type window_status        as enum ('open', 'closed');
create type slot_state           as enum ('free', 'held', 'booked', 'blocked');
create type booking_source       as enum ('online', 'direct', 'emergency');
create type booking_status       as enum ('pending_payment', 'confirmed', 'completed', 'no_show',
                                          'cancelled_by_provider', 'expired');
create type queue_state          as enum ('not_come', 'waiting', 'with_doctor', 'done', 'did_not_come',
                                          'cancelled', 'moved');

create type payment_status       as enum ('created', 'authorized', 'captured', 'failed');
create type refund_reason        as enum ('provider_cancelled', 'late_payment', 'duplicate', 'admin_goodwill');
create type refund_status        as enum ('pending', 'processed', 'failed');
create type transfer_status      as enum ('on_hold', 'released', 'reversed', 'failed');

create type notification_kind    as enum ('booked', 'reminder', 'late', 'turn', 'cancelled', 'changed', 'refund', 'system');
create type article_status       as enum ('draft', 'in_review', 'published');
create type ticket_status        as enum ('open', 'answered', 'closed');
create type bulk_kind            as enum ('cancel_day', 'move_day', 'end_opd_cancel', 'end_opd_move');
create type bulk_status          as enum ('running', 'finished', 'needs_attention');

-- migrate:down

drop type if exists bulk_status, bulk_kind, ticket_status, article_status, notification_kind,
  transfer_status, refund_status, refund_reason, payment_status,
  queue_state, booking_status, booking_source, slot_state, window_status, session_status,
  audience, emergency_mode, emergency_state, payout_status, review_status, document_kind,
  doctor_status, doctor_verification,
  record_status, gender, device_platform, actor_type, admin_role, user_role, user_status;
