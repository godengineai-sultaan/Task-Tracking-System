-- Task template library ("playbooks"): reusable sets of steps that are applied as real tasks.
-- Templates are versioned (every edit stores a snapshot) and archived, never hard-deleted.

create table task_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  description text not null default '',
  category text not null default 'other'
    check (category in ('people','finance','procurement','client','team','product','operations','other')),
  visibility text not null default 'private' check (visibility in ('company','private')),
  created_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  is_starter boolean not null default false,
  -- Stable key of a provisioned starter template; the unique index makes provisioning idempotent per tenant.
  starter_key text,
  version int not null default 1 check (version > 0),
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index task_templates_starter on task_templates (tenant_id, starter_key) where starter_key is not null;
create index task_templates_list on task_templates (tenant_id, archived_at, category);

create table task_template_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  template_id uuid not null references task_templates(id) on delete cascade,
  position int not null check (position between 1 and 200),
  title text not null check (length(title) between 1 and 300),
  description text not null default '',
  category text not null default 'delivery'
    check (category in ('delivery','admin','finance','support','research','sales','operations','other')),
  priority text not null default 'medium' check (priority in ('urgent','high','medium','low','none')),
  estimate_minutes int check (estimate_minutes is null or estimate_minutes between 1 and 100000),
  -- Working days after the start date (the assignee's non-working days are skipped); null = no due date.
  due_offset_days int check (due_offset_days is null or due_offset_days between 0 and 365),
  owner_hint text not null default '',
  checklist jsonb not null default '[]'::jsonb check (jsonb_typeof(checklist) = 'array'),
  requires_review boolean not null default false,
  requires_evidence boolean not null default false,
  -- Positions (within the same template) this step depends on.
  depends_on int[] not null default '{}',
  unique (template_id, position)
);

create table task_template_versions (
  tenant_id uuid not null references tenants(id) on delete cascade,
  template_id uuid not null references task_templates(id) on delete cascade,
  version int not null,
  snapshot jsonb not null,
  change_note text not null default '',
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (template_id, version)
);

create table task_template_applications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  template_id uuid not null references task_templates(id) on delete cascade,
  template_version int not null,
  -- Client-generated idempotency key: a retried apply returns the original tasks instead of creating duplicates.
  apply_key text not null check (length(apply_key) between 8 and 100),
  applied_by uuid references users(id) on delete set null,
  start_date date not null,
  project_id uuid references projects(id) on delete set null,
  milestone_id uuid references milestones(id) on delete set null,
  task_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (tenant_id, apply_key)
);
create index task_template_applications_template on task_template_applications (template_id, created_at desc);

-- Row-level tenant isolation and app-role grants.
alter table task_templates enable row level security;
create policy tenant_isolation on task_templates using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on task_templates to taskapp;

alter table task_template_items enable row level security;
create policy tenant_isolation on task_template_items using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on task_template_items to taskapp;

alter table task_template_versions enable row level security;
create policy tenant_isolation on task_template_versions using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on task_template_versions to taskapp;

alter table task_template_applications enable row level security;
create policy tenant_isolation on task_template_applications using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on task_template_applications to taskapp;
