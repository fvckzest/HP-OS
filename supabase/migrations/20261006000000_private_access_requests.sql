-- Issue #46: Site-scoped private Event Access Requests.
--
-- The request is the durable approval record. Approval links are replaceable
-- opaque secrets and are stored only as SHA-256 digests. Decision history
-- retains the attendee snapshot that was actually reviewed, even when a
-- pending request is later corrected.
create table hpos.access_requests (
  id uuid primary key,
  site_id uuid not null,
  event_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 200),
  email text not null check (char_length(btrim(email)) between 1 and 254),
  normalized_email text not null check (char_length(normalized_email) between 1 and 254),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected')),
  version integer not null default 1 check (version > 0),
  decision_at timestamptz,
  paid_order_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, site_id),
  unique (id, event_id, site_id),
  foreign key (event_id, site_id)
    references hpos.events(id, site_id) on delete restrict,
  constraint access_requests_paid_order_event_fk foreign key (paid_order_id, event_id, site_id)
    references hpos.orders(id, event_id, site_id) on delete restrict,
  check ((status = 'pending' and decision_at is null) or (status in ('approved', 'rejected') and decision_at is not null))
);

create index access_requests_event_recent_idx
  on hpos.access_requests (site_id, event_id, created_at desc, id asc);
create index access_requests_event_status_idx
  on hpos.access_requests (site_id, event_id, status, created_at desc, id asc);
create index access_requests_email_idx
  on hpos.access_requests (site_id, event_id, normalized_email, created_at desc, id asc);
create index access_requests_paid_order_idx
  on hpos.access_requests (site_id, paid_order_id)
  where paid_order_id is not null;

create table hpos.access_request_approval_tokens (
  id uuid primary key,
  site_id uuid not null,
  access_request_id uuid not null,
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  unique (id, site_id),
  unique (id, access_request_id, site_id),
  unique (site_id, token_hash),
  foreign key (access_request_id, site_id)
    references hpos.access_requests(id, site_id) on delete restrict
);

create unique index access_request_active_token_idx
  on hpos.access_request_approval_tokens (site_id, access_request_id)
  where revoked_at is null;
create index access_request_tokens_request_idx
  on hpos.access_request_approval_tokens (site_id, access_request_id, created_at desc, id desc);

create table hpos.access_request_decisions (
  id uuid primary key,
  site_id uuid not null,
  access_request_id uuid not null,
  action text not null check (action in ('approve', 'reject', 'undo_decision', 'correct')),
  from_status text not null check (from_status in ('pending', 'approved', 'rejected')),
  to_status text not null check (to_status in ('pending', 'approved', 'rejected')),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  email text not null check (char_length(btrim(email)) between 1 and 254),
  approval_token_id uuid,
  actor_type text not null check (actor_type in ('user', 'system')),
  actor_reference text not null check (char_length(btrim(actor_reference)) between 1 and 200),
  previous_version integer not null check (previous_version > 0),
  new_version integer not null check (new_version > previous_version),
  created_at timestamptz not null default clock_timestamp(),
  unique (id, site_id),
  foreign key (access_request_id, site_id)
    references hpos.access_requests(id, site_id) on delete restrict,
  foreign key (approval_token_id, access_request_id, site_id)
    references hpos.access_request_approval_tokens(id, access_request_id, site_id) on delete restrict,
  check ((action = 'approve' and from_status = 'pending' and to_status = 'approved' and approval_token_id is not null)
    or (action = 'reject' and from_status = 'pending' and to_status = 'rejected' and approval_token_id is null)
    or (action = 'undo_decision' and from_status in ('approved', 'rejected') and to_status = 'pending' and approval_token_id is null)
    or (action = 'correct' and from_status = 'pending' and to_status = 'pending' and approval_token_id is null))
);

create index access_request_decisions_request_idx
  on hpos.access_request_decisions (site_id, access_request_id, created_at asc, id asc);

-- Notification jobs created before an approval is withdrawn may already be
-- claimed. Retain their dispatch history, but carry the digest separately so
-- workers can revalidate the current token without hashing payload text in SQL.
alter table hpos.notification_jobs
  add column access_request_token_hash text,
  add constraint notification_jobs_access_request_token_hash_check
    check (access_request_token_hash is null or access_request_token_hash ~ '^[0-9a-f]{64}$');

alter table hpos.notification_jobs
  add constraint notification_jobs_access_request_fk
    foreign key (access_request_id, site_id)
    references hpos.access_requests(id, site_id) on delete restrict;

create index notification_jobs_access_request_current_idx
  on hpos.notification_jobs (site_id, access_request_id, kind, status, is_superseded, created_at)
  where kind = 'access_approved';

comment on table hpos.access_requests is
  'Site-scoped attendee permission requests for private Events. Approval permits one private checkout but never reserves capacity.';
comment on table hpos.access_request_approval_tokens is
  'Replaceable approval-link digests. Raw tokens exist only in the approval response payload passed to the Site worker.';
comment on table hpos.access_request_decisions is
  'Append-only approval, rejection, undo, and pending attendee-correction history with the reviewed attendee snapshot.';
comment on column hpos.access_requests.paid_order_id is
  'Set by private checkout after a successful purchase; a paid or refunded Order permanently consumes the approval.';
comment on column hpos.notification_jobs.access_request_token_hash is
  'Digest of the raw approval token in an access_approved payload, used for stale-link revalidation without exposing the digest.';
