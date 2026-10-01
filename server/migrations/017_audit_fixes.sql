-- Audit fixes: account safety columns and the indexes that hot paths and per-task lookups need.

-- Invitations cannot revive an account deactivated after they were issued.
alter table users add column if not exists deactivated_at timestamptz;
update users set deactivated_at = now() where status = 'deactivated' and deactivated_at is null;

-- MFA attempt limits: per pending sign-in and per account.
alter table sessions add column if not exists mfa_failures int not null default 0;
alter table users add column if not exists mfa_failed_attempts int not null default 0;
alter table users add column if not exists mfa_locked_until timestamptz;

-- Notifications: unread badge, bell list and reminder de-dupe all filter by person.
create index if not exists notifications_user_created on notifications (user_id, created_at desc);
create index if not exists notifications_unread on notifications (user_id) where read_at is null;

-- Per-task lookups (task detail, task lists, analytics, profitability forecasts).
create index if not exists time_entries_task on time_entries (task_id) where deleted_at is null;
create index if not exists task_reviews_task on task_reviews (task_id, created_at);
create index if not exists comments_task on comments (task_id, created_at);
create index if not exists checklist_items_task on checklist_items (task_id, position);
create index if not exists evidence_links_task on evidence_links (task_id);
create index if not exists daily_plan_items_task on daily_plan_items (task_id);
create index if not exists blockers_task on blockers (task_id, raised_at desc);

-- Job queue: stale-lock reclaim, admin job list, health check on dead letters.
create index if not exists jobs_running_locked on jobs (locked_at) where status = 'running';
create index if not exists jobs_tenant_created on jobs (tenant_id, created_at desc);
create index if not exists jobs_dead on jobs (run_at) where status = 'dead';

-- Calendar lookups per person.
create index if not exists leave_entries_user on leave_entries (user_id, start_date);
create index if not exists work_schedules_user on work_schedules (user_id) where user_id is not null;
