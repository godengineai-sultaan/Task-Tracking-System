-- Tenant branding and client-facing weekly update reports (feature area: clientbrand).
-- The organization display name stays in tenants.name (single source of truth); this table holds the accent and logo.

create table tenant_branding (
  tenant_id uuid primary key references tenants(id) on delete cascade,
  -- Accent behind white text. The API only stores colours with >= 4.5:1 contrast against white.
  accent text check (accent ~ '^#[0-9a-f]{6}$'),
  logo_file_id uuid references stored_files(id) on delete set null,
  -- Optional weekly tick that prepares drafts (never publishes).
  weekly_drafts boolean not null default false,
  -- Monday of the last week the scheduled tick prepared drafts for: drafts are prepared once per week, so a discarded one is not re-created.
  weekly_last_period date,
  version int not null default 1,
  updated_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table client_updates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  -- The client the update is addressed to (set when drafted and again when published). Clients only see updates addressed to them,
  -- so moving a project to another client never hands the new client what was written for the previous one.
  customer_id uuid references customers(id) on delete set null,
  period_start date not null,
  period_end date not null,
  status text not null default 'draft' check (status in ('draft','published')),
  summary text not null default '' check (length(summary) <= 8000),
  -- Snapshot of client-visible facts only (milestone progress, shared deliverables). Never time, people analytics or internal notes.
  highlights jsonb not null default '{}'::jsonb,
  source text not null default 'manual' check (source in ('manual','scheduled')),
  created_by uuid references users(id) on delete set null,
  updated_by uuid references users(id) on delete set null,
  published_by uuid references users(id) on delete set null,
  published_at timestamptz,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end >= period_start and period_end - period_start <= 92),
  unique (tenant_id, project_id, period_start, period_end)
);
create index client_updates_project on client_updates (tenant_id, project_id, period_end desc);

alter table tenant_branding enable row level security;
create policy tenant_isolation on tenant_branding using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on tenant_branding to taskapp;

alter table client_updates enable row level security;
create policy tenant_isolation on client_updates using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on client_updates to taskapp;

-- Stored files gain a 'branding' purpose (tenant logo). Extend whatever the current list is rather than replacing it.
do $$
declare def text;
begin
  select pg_get_constraintdef(oid) into def from pg_constraint
    where conrelid = 'stored_files'::regclass and conname = 'stored_files_purpose_check';
  if def is not null and position('''branding''' in def) = 0 then
    alter table stored_files drop constraint stored_files_purpose_check;
    execute 'alter table stored_files add constraint stored_files_purpose_check '
      || replace(def, '''evidence''::text', '''evidence''::text, ''branding''::text');
  end if;
end $$;
