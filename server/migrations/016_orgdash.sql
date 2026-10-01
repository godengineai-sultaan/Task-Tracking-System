-- Insights (organization & team analytics): indexes for the period aggregates.
-- No new tables: every metric is computed live from existing RLS-protected records.
create index if not exists orgdash_tasks_accepted on tasks (tenant_id, owner_id, accepted_at) where accepted_at is not null;
create index if not exists orgdash_tasks_due on tasks (tenant_id, owner_id, due_date) where due_date is not null;
create index if not exists orgdash_blockers_raised on blockers (tenant_id, raised_at);
create index if not exists orgdash_daily_reviews_date on daily_reviews (tenant_id, date);
create index if not exists orgdash_daily_plans_date on daily_plans (tenant_id, date);
