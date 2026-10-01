-- Weekly team review: one review per reviewer / employee / ISO week. Reviews never modify the employee's recaps or time.
create table weekly_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  reviewer_id uuid not null references users(id),
  subject_user_id uuid not null references users(id) on delete cascade,
  week_start date not null check (extract(isodow from week_start) = 1),
  status text not null check (status in ('acknowledged','discussed','needs_follow_up')),
  note text not null default '' check (length(note) <= 3000),
  employee_response text not null default '' check (length(employee_response) <= 3000),
  employee_responded_at timestamptz,
  follow_up_task_id uuid references tasks(id) on delete set null,
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint weekly_reviews_not_self check (reviewer_id <> subject_user_id),
  constraint weekly_reviews_unique unique (tenant_id, reviewer_id, subject_user_id, week_start)
);
create index weekly_reviews_subject on weekly_reviews (tenant_id, subject_user_id, week_start desc);
create index weekly_reviews_week on weekly_reviews (tenant_id, week_start);

alter table weekly_reviews enable row level security;
create policy tenant_isolation on weekly_reviews
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
grant select, insert, update, delete on weekly_reviews to taskapp;
