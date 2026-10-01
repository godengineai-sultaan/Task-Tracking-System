-- Portfolio core: companies, products (per-tenant product partitions), product membership, KPI definitions,
-- product metrics/activity (filled later by product data connectors), user preferences, and product_id on work records.
--
-- Product partitions are enforced in the database with RESTRICTIVE row-level security policies that combine with
-- tenant_isolation. Two request settings drive them (set per transaction by the API, see server/src/app.ts tx()):
--   app.product_scope  'all' | '' | unset  -> every product (system jobs, CLI, admins, leadership)
--                      'none'              -> only company-wide rows (product_id is null)
--                      'uuid,uuid,...'     -> those products plus company-wide rows
--   app.product_focus  unset | ''          -> no focus
--                      'none'              -> company-wide work only
--                      '<uuid>'            -> that product (strict tables hide company-wide rows; loose tables keep them)
-- Focus applies to reads only (separate FOR SELECT policies); access applies to reads and writes.
-- Person-level records (time_entries, daily plans/reviews, users, notifications) carry no product policy.

-- ---------- Tables ----------
create table companies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  code text not null check (code ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  name text not null check (length(name) between 1 and 200),
  -- Legal facts stay null until an administrator supplies them; nothing is invented.
  legal_name text,
  cin text,
  gstin text,
  registered_address text,
  website text,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, code)
);

create table products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  key text not null check (key ~ '^[A-Z][A-Z0-9_]{1,39}$'),
  number int,
  name text not null check (length(name) between 1 and 200),
  tagline text not null default '',
  layer text not null default '',
  revenue_engine text not null default '',
  description text not null default '',
  company_id uuid references companies(id) on delete set null,
  -- false = provisional assignment that an administrator still has to confirm.
  company_confirmed boolean not null default false,
  website_url text,
  -- members: product members (and all-scope roles) only; company: every staff member of the tenant.
  visibility text not null default 'members' check (visibility in ('members','company')),
  status text not null default 'active' check (status in ('active','paused','archived')),
  -- Catalog snapshot: customer_segments, workstreams, activity_types, work_item_types, risks, grounding_notes.
  catalog jsonb not null default '{}'::jsonb,
  catalog_version text,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, key),
  check (not company_confirmed or company_id is not null)
);
create index products_company on products (company_id);
create index products_tenant_number on products (tenant_id, number);

create table product_members (
  tenant_id uuid not null references tenants(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null default 'member' check (role in ('lead','member','viewer')),
  added_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (product_id, user_id)
);
create index product_members_user on product_members (user_id);
create index product_members_tenant_user on product_members (tenant_id, user_id);
create index product_members_added_by on product_members (added_by);

create table product_kpis (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,59}$'),
  name text not null,
  unit text not null default '',
  direction text not null default 'up' check (direction in ('up','down','target')),
  cadence text not null default 'monthly' check (cadence in ('daily','weekly','monthly','quarterly')),
  source text not null default 'platform',
  definition text not null default '',
  position int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, key)
);
create index product_kpis_tenant on product_kpis (tenant_id, product_id);

-- Filled by the product data connectors feature (one value per KPI per period).
create table product_metrics (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  kpi_key text not null,
  period_start date not null,
  period_end date not null,
  value numeric not null,
  unit text not null default '',
  source_connection_id uuid references integration_connections(id) on delete set null,
  recorded_at timestamptz not null default now(),
  check (period_end >= period_start),
  unique (product_id, kpi_key, period_start, period_end)
);
create index product_metrics_tenant on product_metrics (tenant_id, product_id, period_end desc);
create index product_metrics_connection on product_metrics (source_connection_id);

-- Filled by the product data connectors feature: evidence of product work (releases, deploys, tickets...).
create table product_activity (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  product_id uuid not null references products(id) on delete cascade,
  type text not null check (type ~ '^[a-z][a-z0-9_.]{1,59}$'),
  title text not null check (length(title) between 1 and 500),
  occurred_at timestamptz not null,
  actor_user_id uuid references users(id) on delete set null,
  actor_reference text,
  task_id uuid references tasks(id) on delete set null,
  url text,
  external_id text,
  connection_id uuid references integration_connections(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create unique index product_activity_external on product_activity (product_id, connection_id, external_id) nulls not distinct where external_id is not null;
create index product_activity_recent on product_activity (tenant_id, product_id, occurred_at desc);
create index product_activity_actor on product_activity (actor_user_id);
create index product_activity_task on product_activity (task_id);
create index product_activity_connection on product_activity (connection_id);

create table user_preferences (
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);
create index user_preferences_tenant on user_preferences (tenant_id);

-- ---------- product_id on work records (null = company-wide work; nothing is backfilled) ----------
alter table projects add column product_id uuid references products(id);
alter table tasks add column product_id uuid references products(id);
alter table objectives add column product_id uuid references products(id);
alter table recurring_templates add column product_id uuid references products(id);
alter table task_templates add column product_id uuid references products(id);
alter table automation_rules add column product_id uuid references products(id);
alter table integration_connections add column product_id uuid references products(id);
alter table time_entries add column product_id uuid references products(id);
create index projects_product on projects (tenant_id, product_id);
create index tasks_product on tasks (tenant_id, product_id, status);
create index objectives_product on objectives (tenant_id, product_id);
create index recurring_templates_product on recurring_templates (tenant_id, product_id);
create index task_templates_product on task_templates (tenant_id, product_id);
create index automation_rules_product on automation_rules (tenant_id, product_id);
create index integration_connections_product on integration_connections (tenant_id, product_id);
create index time_entries_product on time_entries (tenant_id, product_id, started_at);

-- ---------- Consistency triggers (security definer: they must see the project/task regardless of the caller's scope) ----------
-- A record with a project belongs to that project's product; an explicit product that contradicts the project is refused.
create function app_project_product_sync() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare pp uuid;
begin
  if new.project_id is not null then
    select product_id into pp from projects where id = new.project_id;
    if tg_op = 'INSERT' then
      if new.product_id is not null and new.product_id is distinct from pp then
        raise exception 'The product must match the project''s product' using errcode = '23514';
      end if;
    elsif new.product_id is distinct from old.product_id and new.product_id is distinct from pp then
      raise exception 'The product must match the project''s product' using errcode = '23514';
    end if;
    new.product_id := pp;
  end if;
  return new;
end $$;
create trigger tasks_product_sync before insert or update of project_id, product_id on tasks
  for each row execute function app_project_product_sync();
create trigger recurring_templates_product_sync before insert or update of project_id, product_id on recurring_templates
  for each row execute function app_project_product_sync();

-- Moving a project to another product moves its tasks and recurring work with it.
create function app_project_product_cascade() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update tasks set product_id = new.product_id where project_id = new.id and product_id is distinct from new.product_id;
  update recurring_templates set product_id = new.product_id where project_id = new.id and product_id is distinct from new.product_id;
  return null;
end $$;
create trigger projects_product_cascade after update on projects
  for each row when (old.product_id is distinct from new.product_id) execute function app_project_product_cascade();

-- Time on a task belongs to the task's product.
create function app_time_entry_product_sync() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.task_id is not null then
    select product_id into new.product_id from tasks where id = new.task_id;
  end if;
  return new;
end $$;
create trigger time_entries_product_sync before insert or update of task_id, product_id on time_entries
  for each row execute function app_time_entry_product_sync();

create function app_task_time_product_cascade() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update time_entries set product_id = new.product_id where task_id = new.id and product_id is distinct from new.product_id;
  return null;
end $$;
create trigger tasks_time_product_cascade after update on tasks
  for each row when (old.product_id is distinct from new.product_id) execute function app_task_time_product_cascade();

-- ---------- Partition predicates ----------
create function app_product_allowed(pid uuid) returns boolean language sql stable parallel safe as $$
  select pid is null
    or coalesce(nullif(current_setting('app.product_scope', true), ''), 'all') = 'all'
    or coalesce(pid = any (string_to_array(nullif(current_setting('app.product_scope', true), 'none'), ',')::uuid[]), false)
$$;

create function app_product_focus_ok(pid uuid, strict boolean) returns boolean language sql stable parallel safe as $$
  select coalesce(current_setting('app.product_focus', true), '') = ''
    or (current_setting('app.product_focus', true) = 'none' and pid is null)
    or coalesce(pid::text = current_setting('app.product_focus', true), false)
    or (not strict and pid is null)
$$;

-- Whether the current tenant has any products at all (independent of the caller's product scope).
create function app_tenant_has_products() returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from products where tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
$$;

-- ---------- Row-level security ----------
do $$
declare t text;
begin
  for t in select unnest(array['companies','products','product_members','product_kpis','product_metrics','product_activity','user_preferences'])
  loop
    execute format('alter table %I enable row level security', t);
    execute format($p$create policy tenant_isolation on %I using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
                      with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
    execute format('grant select, insert, update, delete on %I to taskapp', t);
  end loop;

  -- Access (reads and writes) on the product column.
  for t in select unnest(array['product_members','product_kpis','product_metrics','product_activity','projects','tasks','objectives',
    'recurring_templates','task_templates','automation_rules','integration_connections'])
  loop
    execute format('create policy product_access on %I as restrictive for all using (app_product_allowed(product_id)) with check (app_product_allowed(product_id))', t);
  end loop;

  -- Task children follow their task; milestones follow their project.
  for t in select unnest(array['checklist_items','comments','evidence_links','blockers','task_reviews','task_state_history','task_dependencies','task_collaborators'])
  loop
    execute format('create policy product_access on %I as restrictive for all using (exists (select 1 from tasks pt where pt.id = %I.task_id))
                    with check (exists (select 1 from tasks pt where pt.id = %I.task_id))', t, t, t);
  end loop;

  -- Focus (reads only). Strict: company-wide rows are hidden under a product focus. Loose: they stay visible.
  for t in select unnest(array['projects','tasks','objectives','recurring_templates','product_kpis','product_metrics','product_activity'])
  loop
    execute format('create policy product_focus on %I as restrictive for select using (app_product_focus_ok(product_id, true))', t);
  end loop;
  for t in select unnest(array['task_templates','automation_rules','integration_connections'])
  loop
    execute format('create policy product_focus on %I as restrictive for select using (app_product_focus_ok(product_id, false))', t);
  end loop;
end $$;

create policy product_access on products as restrictive for all using (app_product_allowed(id)) with check (app_product_allowed(id));
create policy product_access on milestones as restrictive for all using (exists (select 1 from projects pp where pp.id = milestones.project_id))
  with check (exists (select 1 from projects pp where pp.id = milestones.project_id));

grant execute on function app_product_allowed(uuid) to taskapp;
grant execute on function app_product_focus_ok(uuid, boolean) to taskapp;
grant execute on function app_tenant_has_products() to taskapp;
