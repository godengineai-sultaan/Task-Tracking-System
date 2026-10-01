-- Objectives & key results with explainable early warning.

-- Optimistic versioning for objective edits.
alter table objectives add column if not exists version int not null default 1;
alter table objectives add column if not exists updated_at timestamptz not null default now();

create table objective_key_results (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  objective_id uuid not null references objectives(id) on delete cascade,
  title text not null check (length(title) between 1 and 300),
  kind text not null check (kind in ('milestone_completion','task_completion','manual')),
  -- manual: owner-reported current_value toward target_value (in unit). Computed kinds ignore these and derive from linked work.
  target_value numeric check (target_value is null or target_value > 0),
  current_value numeric,
  unit text not null default '' check (length(unit) <= 40),
  milestone_ids uuid[] not null default '{}',
  project_ids uuid[] not null default '{}',
  position int not null default 0,
  version int not null default 1,
  created_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind <> 'manual' or target_value is not null)
);
create index okr_objective on objective_key_results (objective_id, position);

create table objective_checkins (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  objective_id uuid not null references objectives(id) on delete cascade,
  author_id uuid references users(id) on delete set null,
  confidence int not null check (confidence between 1 and 5),
  note text not null default '' check (length(note) <= 4000),
  -- Client-generated key so a retried submit does not post the same check-in twice.
  idempotency_key text check (length(idempotency_key) <= 100),
  created_at timestamptz not null default now()
);
create index ocheckin_objective on objective_checkins (objective_id, created_at);
create unique index ocheckin_idem on objective_checkins (objective_id, idempotency_key) where idempotency_key is not null;

-- Weekly computed status snapshots. One row per objective per ISO week; the unique key makes the weekly tick idempotent.
create table objective_status_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  objective_id uuid not null references objectives(id) on delete cascade,
  period_key text not null,
  status text not null check (status in ('on_track','at_risk','off_track','insufficient_data')),
  previous_status text check (previous_status in ('on_track','at_risk','off_track','insufficient_data')),
  progress numeric,
  expected numeric,
  reasons jsonb not null default '[]'::jsonb,
  notified boolean not null default false,
  evaluated_at timestamptz not null default now(),
  unique (objective_id, period_key)
);
create index ostatus_objective on objective_status_history (objective_id, evaluated_at);

alter table objective_key_results enable row level security;
create policy tenant_isolation on objective_key_results using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
alter table objective_checkins enable row level security;
create policy tenant_isolation on objective_checkins using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
alter table objective_status_history enable row level security;
create policy tenant_isolation on objective_status_history using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

grant select, insert, update, delete on objective_key_results to taskapp;
grant select, insert, update, delete on objective_checkins to taskapp;
grant select, insert, update, delete on objective_status_history to taskapp;
