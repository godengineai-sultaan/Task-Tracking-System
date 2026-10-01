-- No-code automation rules for task workflows (feature area: automation).
-- A rule = trigger + conditions + actions. Company rules are created by system admins; team rules by
-- managers and only ever match tasks owned by the people they manage (checked at evaluation time).
create table automation_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  description text not null default '',
  enabled boolean not null default true,
  trigger jsonb not null,
  conditions jsonb not null default '{}'::jsonb,
  actions jsonb not null default '[]'::jsonb,
  scope text not null check (scope in ('company','team')),
  owner_id uuid not null references users(id) on delete cascade,
  created_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  preset text,
  version int not null default 1,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index automation_rules_trigger on automation_rules (tenant_id, (trigger->>'type')) where enabled and archived_at is null;

-- One row per rule evaluation that matched (success), was held back (skipped: loop guard, nothing to do) or errored (failed).
create table automation_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  rule_id uuid not null references automation_rules(id) on delete cascade,
  rule_version int not null,
  task_id uuid references tasks(id) on delete set null,
  trigger text not null,
  status text not null check (status in ('success','skipped','failed')),
  message text not null default '',
  results jsonb not null default '[]'::jsonb,
  depth int not null default 0,
  dedupe_key text,
  created_at timestamptz not null default now()
);
create index automation_runs_rule on automation_runs (tenant_id, rule_id, created_at desc);
create index automation_runs_recent on automation_runs (tenant_id, created_at desc);
-- Time-based triggers (due soon / overdue) fire at most once per rule, task and due date.
create unique index automation_runs_dedupe on automation_runs (tenant_id, dedupe_key) where dedupe_key is not null;

alter table automation_rules enable row level security;
create policy tenant_isolation on automation_rules using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
alter table automation_runs enable row level security;
create policy tenant_isolation on automation_runs using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on automation_rules to taskapp;
grant select, insert, update, delete on automation_runs to taskapp;
