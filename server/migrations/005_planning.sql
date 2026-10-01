-- Planning assistant: per-user nudge preferences and an idempotency log of routine nudges (in-app only).

create table planning_preferences (
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid primary key references users(id) on delete cascade,
  plan_nudge boolean not null default true,
  recap_nudge boolean not null default true,
  updated_at timestamptz not null default now()
);

-- One row per user, local date and nudge kind: the primary key makes sending idempotent.
create table planning_nudges (
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  date date not null,
  kind text not null check (kind in ('plan', 'recap')),
  sent_at timestamptz not null default now(),
  primary key (user_id, date, kind)
);
create index planning_nudges_tenant_date on planning_nudges (tenant_id, date);

alter table planning_preferences enable row level security;
create policy tenant_isolation on planning_preferences using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on planning_preferences to taskapp;

alter table planning_nudges enable row level security;
create policy tenant_isolation on planning_nudges using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on planning_nudges to taskapp;
