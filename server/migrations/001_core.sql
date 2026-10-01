-- Core schema for Task Tracking and Productivity.
-- Every business table carries tenant_id and is protected by row-level security (RLS).
-- The app role (taskapp) is subject to RLS; the owner role (taskapp_owner) runs migrations.
-- System tables without RLS: tenants (public slug lookup), sessions (token lookup), jobs (worker claim),
-- schema_migrations. Those are only reached through server code that re-applies tenant scope.

create table tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name text not null,
  legal_name text,
  timezone text not null default 'UTC',
  logo_url text,
  contact_email text,
  address text,
  plan text not null default 'team' check (plan in ('team','organization','enterprise')),
  seat_limit int not null default 25 check (seat_limit > 0),
  modules text[] not null default array['tasks','analytics','admin_routine'],
  settings jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active','suspended')),
  onboarded_at timestamptz,
  created_at timestamptz not null default now()
);

create table departments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  unique (tenant_id, name)
);

create table customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  unique (tenant_id, name)
);

-- Role profiles: configurable commitments used by explainable assessments (On Track / Needs Attention).
create table role_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  description text not null default '',
  commitment_target numeric(4,3) not null default 0.6 check (commitment_target between 0 and 1),
  coverage_target numeric(4,3) not null default 0.5 check (coverage_target between 0 and 1),
  judge_by_closed_tasks boolean not null default true,
  outcome_guidance text not null default '',
  unique (tenant_id, name)
);

create table users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  email text not null,
  name text not null,
  password_hash text,
  -- member, manager, leadership, routine_admin (company-wide staff records), system_admin, cost_viewer, customer
  roles text[] not null default array['member'],
  title text not null default '',
  department_id uuid references departments(id) on delete set null,
  role_profile_id uuid references role_profiles(id) on delete set null,
  customer_id uuid references customers(id) on delete set null,
  is_founder boolean not null default false,
  timezone text,
  mfa_secret_enc text,
  mfa_enabled boolean not null default false,
  status text not null default 'active' check (status in ('active','invited','deactivated')),
  last_login_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index users_tenant_email on users (tenant_id, lower(email));

create table teams (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  department_id uuid references departments(id) on delete set null,
  manager_id uuid references users(id) on delete set null,
  unique (tenant_id, name)
);
create table team_members (
  tenant_id uuid not null references tenants(id) on delete cascade,
  team_id uuid not null references teams(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  primary key (team_id, user_id)
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  mfa_pending boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ip text, user_agent text
);

create table invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  email text not null,
  name text not null,
  roles text[] not null default array['member'],
  department_id uuid references departments(id) on delete set null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table projects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  key text not null check (key ~ '^[A-Z][A-Z0-9]{1,9}$'),
  name text not null,
  description text not null default '',
  department_id uuid references departments(id) on delete set null,
  customer_id uuid references customers(id) on delete set null,
  visibility text not null default 'company' check (visibility in ('company','private')),
  status text not null default 'active' check (status in ('active','on_hold','completed','archived')),
  owner_id uuid references users(id) on delete set null,
  business_outcome text not null default '',
  start_date date, target_date date,
  created_at timestamptz not null default now(),
  unique (tenant_id, key)
);
create table project_members (
  tenant_id uuid not null references tenants(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  primary key (project_id, user_id)
);

create table objectives (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  title text not null,
  description text not null default '',
  owner_id uuid references users(id) on delete set null,
  period_start date, period_end date,
  status text not null default 'active' check (status in ('active','achieved','missed','dropped')),
  created_at timestamptz not null default now()
);

create table milestones (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  objective_id uuid references objectives(id) on delete set null,
  name text not null,
  due_date date,
  status text not null default 'open' check (status in ('open','done','cancelled')),
  created_at timestamptz not null default now()
);

create table recurring_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  title text not null,
  description text not null default '',
  project_id uuid references projects(id) on delete set null,
  owner_id uuid not null references users(id) on delete cascade,
  category text not null default 'admin',
  priority text not null default 'medium',
  estimate_minutes int,
  checklist jsonb not null default '[]'::jsonb,
  rule text not null check (rule in ('daily','weekdays','weekly','monthly')),
  weekday int check (weekday between 1 and 7),
  month_day int check (month_day between 1 and 28),
  active boolean not null default true,
  last_generated_date date,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);

create sequence task_number_seq;
create table tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  number bigint not null default nextval('task_number_seq'),
  project_id uuid references projects(id) on delete set null,
  milestone_id uuid references milestones(id) on delete set null,
  title text not null check (length(title) between 1 and 300),
  description text not null default '',
  owner_id uuid not null references users(id),
  created_by uuid references users(id),
  status text not null default 'planned'
    check (status in ('backlog','planned','in_progress','blocked','in_review','done','cancelled')),
  priority text not null default 'medium' check (priority in ('urgent','high','medium','low','none')),
  category text not null default 'delivery'
    check (category in ('delivery','admin','finance','support','research','sales','operations','other')),
  due_date date,
  estimate_minutes int check (estimate_minutes is null or estimate_minutes between 1 and 100000),
  tags text[] not null default '{}',
  acceptance_criteria text not null default '',
  requires_review boolean not null default false,
  requires_evidence boolean not null default false,
  reviewer_id uuid references users(id) on delete set null,
  customer_visible boolean not null default false,
  source_type text not null default 'manual'
    check (source_type in ('manual','quick_capture','recurring','integration','approval','document','kyc','offboarding','follow_up','ai_draft')),
  source_ref jsonb,
  external_key text,
  recurring_template_id uuid references recurring_templates(id) on delete set null,
  occurrence_date date,
  sort_order double precision not null default 0,
  version int not null default 1,
  reopen_count int not null default 0,
  started_at timestamptz,
  done_at timestamptz,
  accepted_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index tasks_external_key on tasks (tenant_id, external_key) where external_key is not null;
create unique index tasks_recurring_occurrence on tasks (recurring_template_id, occurrence_date) where recurring_template_id is not null;
create index tasks_owner_status on tasks (tenant_id, owner_id, status);
create index tasks_project on tasks (tenant_id, project_id);
create index tasks_title_search on tasks using gin (to_tsvector('simple', title || ' ' || description));

create table task_collaborators (
  tenant_id uuid not null references tenants(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  primary key (task_id, user_id)
);
create table task_dependencies (
  tenant_id uuid not null references tenants(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  depends_on_task_id uuid not null references tasks(id) on delete cascade,
  primary key (task_id, depends_on_task_id),
  check (task_id <> depends_on_task_id)
);
create table checklist_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  text text not null,
  done boolean not null default false,
  position int not null default 0,
  done_by uuid references users(id), done_at timestamptz
);
create table task_state_history (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  from_status text,
  to_status text not null,
  actor_id uuid references users(id),
  reason text,
  at timestamptz not null default now()
);
create index tsh_task on task_state_history (task_id, at);
create index tsh_actor_at on task_state_history (tenant_id, actor_id, at);

create table comments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  author_id uuid references users(id),
  body text not null,
  kind text not null default 'comment' check (kind in ('comment','review','system','scope_change')),
  created_at timestamptz not null default now()
);

create table stored_files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  storage_key text not null unique,
  filename text not null,
  mime text not null,
  size_bytes bigint not null,
  sha256 text not null,
  purpose text not null check (purpose in ('evidence','export','import')),
  uploaded_by uuid references users(id),
  created_at timestamptz not null default now()
);

-- Evidence: a link, an uploaded private file, or a restricted reference to a document held by another module.
-- restricted = true means the source keeps its own access control: we store only a label + opaque reference.
create table evidence_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  kind text not null check (kind in ('link','file','source_ref')),
  label text not null,
  url text,
  file_id uuid references stored_files(id) on delete set null,
  source_module text,
  source_reference text,
  restricted boolean not null default false,
  allowed_user_ids uuid[] not null default '{}',
  added_by uuid references users(id),
  created_at timestamptz not null default now()
);

create table blockers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  reason text not null,
  cause text not null default 'dependency'
    check (cause in ('dependency','client','requirement','access','technical','capacity','other')),
  waiting_on_user_id uuid references users(id) on delete set null,
  waiting_on_text text not null default '',
  next_follow_up date,
  raised_by uuid references users(id),
  raised_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references users(id),
  resolution text
);
create index blockers_open on blockers (tenant_id) where resolved_at is null;

create table task_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  reviewer_id uuid not null references users(id),
  decision text not null check (decision in ('accepted','changes_requested')),
  note text not null default '',
  created_at timestamptz not null default now()
);

create table daily_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  date date not null,
  focus_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, date)
);
-- Up to three intended outcomes per day (enforced in service + partial unique index on position).
create table daily_plan_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  plan_id uuid not null references daily_plans(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  position int not null check (position between 1 and 3),
  added_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_reason text
);
create unique index dpi_active_position on daily_plan_items (plan_id, position) where removed_at is null;
create unique index dpi_active_task on daily_plan_items (plan_id, task_id) where removed_at is null;

create table daily_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  date date not null,
  status text not null default 'draft' check (status in ('draft','confirmed','manager_reviewed')),
  day_type text not null default 'work' check (day_type in ('work','no_work','non_working')),
  summary text not null default '',
  blockers_note text not null default '',
  next_steps text not null default '',
  context_note text not null default '',
  version int not null default 0,
  confirmed_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid references users(id),
  ai_draft_run_id uuid,
  updated_at timestamptz not null default now(),
  unique (user_id, date)
);
create table daily_review_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  review_id uuid not null references daily_reviews(id) on delete cascade,
  version int not null,
  snapshot jsonb not null,
  change_reason text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (review_id, version)
);

create table time_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  task_id uuid references tasks(id) on delete set null,
  category text not null default 'task' check (category in ('task','meeting','admin','learning','other')),
  started_at timestamptz not null,
  ended_at timestamptz,
  source text not null check (source in ('timer','manual','calendar','integration')),
  source_event_id uuid,
  note text not null default '',
  deleted_at timestamptz,
  version int not null default 1,
  created_at timestamptz not null default now(),
  check (ended_at is null or ended_at > started_at)
);
create unique index one_running_timer on time_entries (user_id) where ended_at is null and deleted_at is null;
create index te_user_time on time_entries (tenant_id, user_id, started_at);
create table time_entry_revisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  time_entry_id uuid not null references time_entries(id) on delete cascade,
  before jsonb, after jsonb,
  reason text not null,
  actor_id uuid references users(id),
  at timestamptz not null default now()
);

-- Working calendar. user_id null = tenant default schedule.
create table work_schedules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  weekday int not null check (weekday between 1 and 7),
  start_minute int not null check (start_minute between 0 and 1439),
  end_minute int not null check (end_minute between 1 and 1440),
  break_minutes int not null default 0 check (break_minutes >= 0),
  check (end_minute > start_minute)
);
create unique index ws_unique on work_schedules (tenant_id, coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), weekday);
create table holidays (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  date date not null,
  name text not null,
  unique (tenant_id, date)
);
create table leave_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  start_date date not null,
  end_date date not null,
  portion text not null default 'full' check (portion in ('full','half_am','half_pm')),
  kind text not null default 'leave' check (kind in ('leave','sick','training','other')),
  note text not null default '',
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  check (end_date >= start_date)
);
create table capacity_allocations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  percent int not null check (percent between 1 and 100),
  start_date date not null,
  end_date date,
  assumption text not null default ''
);
-- Confidential cost rates; only cost_viewer can read through the API.
create table cost_rates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  hourly_rate numeric(12,2) not null check (hourly_rate >= 0),
  currency text not null default 'INR',
  effective_from date not null
);

create table integration_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,
  kind text not null check (kind in ('ics_calendar','issues','helpdesk','code','module_approvals','module_documents','module_kyc','module_vault')),
  name text not null,
  status text not null default 'active' check (status in ('active','paused','error','revoked')),
  secret_enc text,
  settings jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  last_error text,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
-- Integration event envelope per the shared contract. Deduplicated on (connection, event_id).
create table integration_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  connection_id uuid not null references integration_connections(id) on delete cascade,
  event_id text not null,
  event_type text not null,
  schema_version text not null,
  entity_id text, resource_id text, resource_version text,
  occurred_at timestamptz,
  actor_reference text,
  correlation_id text,
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  status text not null default 'received' check (status in ('received','suggested','applied','ignored','rejected','duplicate')),
  result text,
  unique (connection_id, event_id)
);
create table suggestions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('time_entry','task','link_to_task')),
  dedupe_key text not null,
  event_ids uuid[] not null default '{}',
  title text not null,
  data jsonb not null default '{}'::jsonb,
  matched_task_id uuid references tasks(id) on delete set null,
  status text not null default 'open' check (status in ('open','accepted','dismissed')),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id, dedupe_key)
);

create table manager_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  subject_user_id uuid not null references users(id) on delete cascade,
  date date,
  daily_review_id uuid references daily_reviews(id) on delete set null,
  reviewer_id uuid not null references users(id),
  action text not null check (action in ('acknowledge','note','clarification_request','clarification_response','follow_up','blocker_help','reassign')),
  note text not null default '',
  related_task_id uuid references tasks(id) on delete set null,
  related_blocker_id uuid references blockers(id) on delete set null,
  parent_id uuid references manager_reviews(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

create table notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null default '',
  link text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

-- Report snapshots: period, metric definitions, source coverage, confirmation state and correction history.
create table report_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  period_kind text not null check (period_kind in ('day','week','month','custom')),
  period_start date not null,
  period_end date not null,
  version int not null,
  status text not null check (status in ('provisional','confirmed','manager_reviewed')),
  definitions_version text not null,
  data jsonb not null,
  reason text not null default '',
  generated_by uuid references users(id),
  generated_at timestamptz not null default now(),
  unique (user_id, period_kind, period_start, period_end, version)
);

create table exports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  requested_by uuid not null references users(id),
  format text not null check (format in ('pdf','csv')),
  report text not null check (report in ('individual','team_daily','delivery')),
  params jsonb not null,
  status text not null default 'queued' check (status in ('queued','running','ready','failed')),
  file_id uuid references stored_files(id) on delete set null,
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table saved_filters (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  view text not null default 'list',
  query jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Product telemetry: how long the routine takes. Used for the <2 minute overhead goal, not staff assessment.
create table ux_timings (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  flow text not null check (flow in ('plan','recap','quick_capture','status_update','timer')),
  duration_ms int not null check (duration_ms >= 0),
  date date not null,
  created_at timestamptz not null default now()
);

create table ai_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  feature text not null check (feature in ('task_draft','recap_draft')),
  prompt_version text not null,
  model text not null,
  source_refs jsonb not null default '[]'::jsonb,
  output jsonb,
  status text not null check (status in ('succeeded','failed')),
  error text,
  decision text check (decision in ('accepted','edited','rejected')),
  latency_ms int,
  input_tokens int, output_tokens int,
  created_at timestamptz not null default now()
);

-- Append-only audit log with a per-tenant hash chain for tamper detection.
create table audit_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  actor_id uuid,
  action text not null,
  resource_type text not null,
  resource_id text,
  resource_version int,
  reason text,
  authority text,
  correlation_id text,
  outcome text not null default 'success',
  details jsonb not null default '{}'::jsonb,
  at timestamptz not null default now(),
  prev_hash text not null,
  hash text not null
);
create index audit_tenant on audit_events (tenant_id, id);
create function audit_immutable() returns trigger language plpgsql as $$
begin
  if current_setting('app.audit_purge', true) = 'on' and tg_op = 'DELETE' then return old; end if;
  raise exception 'audit_events is append-only';
end $$;
create trigger audit_no_update before update or delete on audit_events for each row execute function audit_immutable();

-- Durable job queue + transactional outbox: jobs are inserted in the same transaction as the business change.
create table jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued','running','succeeded','dead','cancelled')),
  attempts int not null default 0,
  max_attempts int not null default 5,
  run_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index jobs_ready on jobs (run_at) where status = 'queued';

-- Row-level security for every tenant-scoped table.
do $$
declare t text;
begin
  for t in select unnest(array[
    'departments','customers','role_profiles','users','teams','team_members','invitations','projects','project_members',
    'objectives','milestones','recurring_templates','tasks','task_collaborators','task_dependencies','checklist_items',
    'task_state_history','comments','stored_files','evidence_links','blockers','task_reviews','daily_plans','daily_plan_items',
    'daily_reviews','daily_review_versions','time_entries','time_entry_revisions','work_schedules','holidays','leave_entries',
    'capacity_allocations','cost_rates','integration_connections','integration_events','suggestions','manager_reviews',
    'notifications','report_versions','exports','saved_filters','ux_timings','ai_runs','audit_events'])
  loop
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy tenant_isolation on %I using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
                      with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  end loop;
end $$;

grant select, insert, update, delete on all tables in schema public to taskapp;
revoke update, delete on audit_events from taskapp;
grant usage, select on all sequences in schema public to taskapp;
