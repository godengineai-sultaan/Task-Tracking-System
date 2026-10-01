-- Calendar subscriptions (ICS URL), personal calendar feed tokens, and holiday import previews.

-- A user's "secret iCal address" subscription, attached to their ics_calendar connection.
-- The URL itself is a credential: stored encrypted only; url_host is kept for display.
create table calendar_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  connection_id uuid not null unique references integration_connections(id) on delete cascade,
  url_enc text not null,
  url_host text not null,
  status text not null default 'active' check (status in ('active','paused')),
  etag text,
  last_modified text,
  last_fetch_at timestamptz,
  last_success_at timestamptz,
  last_status text check (last_status in ('ok','not_modified','error')),
  last_error text,
  last_result jsonb not null default '{}'::jsonb,
  consecutive_failures int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index calendar_subscriptions_user on calendar_subscriptions (user_id);
alter table calendar_subscriptions enable row level security;
create policy tenant_isolation on calendar_subscriptions using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on calendar_subscriptions to taskapp;

-- Personal read-only calendar feed. Only a SHA-256 hash of the secret is stored; one active token per user.
create table calendar_feed_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);
create unique index calendar_feed_tokens_active on calendar_feed_tokens (user_id) where revoked_at is null;
alter table calendar_feed_tokens enable row level security;
create policy tenant_isolation on calendar_feed_tokens using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on calendar_feed_tokens to taskapp;

-- Holiday import: parsed dates are kept server-side between preview and confirm, so only dates read from the file are imported.
create table holiday_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  source_kind text not null check (source_kind in ('file','url')),
  source_label text not null,
  items jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  status text not null default 'preview' check (status in ('preview','imported')),
  imported_count int not null default 0,
  skipped_count int not null default 0,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  confirmed_by uuid references users(id),
  confirmed_at timestamptz
);
create index holiday_imports_recent on holiday_imports (tenant_id, created_at desc);
alter table holiday_imports enable row level security;
create policy tenant_isolation on holiday_imports using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on holiday_imports to taskapp;
