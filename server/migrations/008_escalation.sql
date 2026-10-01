-- Smart blocker escalation. Policy lives in tenants.settings.escalation (jsonb).
-- Each ladder level (waiting_on, manager, admin) fires once per blocker: follow_up_date is null for those rows,
-- and "unique nulls not distinct" makes (blocker_id, level) unique. Owner reminders fire once per follow-up date.
create table blocker_escalations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  blocker_id uuid not null references blockers(id) on delete cascade,
  level text not null check (level in ('owner', 'waiting_on', 'manager', 'admin')),
  follow_up_date date,
  working_days int not null check (working_days >= 0),
  outcome text not null default 'notified' check (outcome in ('notified', 'skipped')),
  note text not null default '',
  notified_user_id uuid references users(id) on delete set null,
  recipient_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  check ((level = 'owner') or follow_up_date is null),
  constraint blocker_escalations_once unique nulls not distinct (blocker_id, level, follow_up_date)
);
create index blocker_escalations_blocker on blocker_escalations (tenant_id, blocker_id);

-- Manual nudges: once per blocker per actor per local day (the unique key is the rate limit).
create table blocker_nudges (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  blocker_id uuid not null references blockers(id) on delete cascade,
  actor_id uuid not null references users(id) on delete cascade,
  notified_user_id uuid references users(id) on delete set null,
  nudged_on date not null,
  note text not null default '' check (length(note) <= 500),
  created_at timestamptz not null default now(),
  unique (blocker_id, actor_id, nudged_on)
);
create index blocker_nudges_blocker on blocker_nudges (tenant_id, blocker_id);

alter table blocker_escalations enable row level security;
create policy tenant_isolation on blocker_escalations using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on blocker_escalations to taskapp;

alter table blocker_nudges enable row level security;
create policy tenant_isolation on blocker_nudges using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on blocker_nudges to taskapp;
