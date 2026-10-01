-- Project budgets, burn tracking and profitability alerts.
-- Money values are confidential: the API only returns them to cost viewers.

create table project_budgets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  project_id uuid not null unique references projects(id) on delete cascade,
  billing_type text not null check (billing_type in ('fixed_fee','time_and_materials','internal')),
  budget_amount numeric(14,2) check (budget_amount is null or budget_amount >= 0),
  currency text not null default 'INR' check (currency ~ '^[A-Z]{3}$'),
  budget_hours numeric(10,2) check (budget_hours is null or budget_hours >= 0),
  bill_rate numeric(12,2) check (bill_rate is null or bill_rate >= 0),
  start_date date,
  end_date date,
  alert_thresholds int[] not null default '{75,90,100}',
  notes text not null default '',
  -- Bumped when the amount, hours, currency, billing type, bill rate or start date change, so thresholds re-arm against the new budget.
  alert_epoch int not null default 1,
  version int not null default 1,
  created_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date),
  check (budget_amount is not null or budget_hours is not null)
);
create index project_budgets_tenant on project_budgets (tenant_id);

-- One row per crossed threshold per budget revision: makes alerting idempotent.
create table project_budget_alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  budget_id uuid not null references project_budgets(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  epoch int not null,
  kind text not null check (kind in ('amount','hours','forecast_amount','forecast_hours')),
  threshold int not null default 0,
  consumption numeric(10,4),
  notified_user_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (budget_id, epoch, kind, threshold)
);
create index project_budget_alerts_project on project_budget_alerts (tenant_id, project_id, created_at desc);

alter table project_budgets enable row level security;
create policy tenant_isolation on project_budgets using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on project_budgets to taskapp;

alter table project_budget_alerts enable row level security;
create policy tenant_isolation on project_budget_alerts using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on project_budget_alerts to taskapp;
