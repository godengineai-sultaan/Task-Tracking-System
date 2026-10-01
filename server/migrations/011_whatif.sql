-- What-if capacity planner: saved scenarios (hypothetical changes only; simulations never modify real data).
create table whatif_scenarios (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  horizon_days int not null default 14 check (horizon_days between 5 and 60),
  people uuid[] not null default '{}',
  changes jsonb not null default '[]',
  unestimated_minutes int not null default 60 check (unestimated_minutes between 0 and 6000),
  created_by uuid not null references users(id) on delete cascade,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, created_by, name)
);
create index whatif_scenarios_owner on whatif_scenarios (tenant_id, created_by, updated_at desc);

alter table whatif_scenarios enable row level security;
create policy tenant_isolation on whatif_scenarios using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on whatif_scenarios to taskapp;
