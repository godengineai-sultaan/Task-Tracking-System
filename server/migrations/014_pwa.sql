-- PWA / offline capture: client-generated request ids make task creation idempotent per (tenant, creator, id),
-- so a capture retried from the offline outbox (or a resubmitted request whose response was lost) never duplicates.
-- tasks already has tenant_id + row-level security; no new tenant table is introduced.
alter table tasks add column if not exists client_request_id text;
alter table tasks add constraint tasks_client_request_id_len check (client_request_id is null or char_length(client_request_id) between 8 and 100);
create unique index if not exists tasks_client_request on tasks (tenant_id, created_by, client_request_id) where client_request_id is not null;
