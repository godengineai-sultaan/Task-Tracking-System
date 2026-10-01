-- Task Tracking and Productivity is a standalone module: remove connectors and task sources
-- that belonged to sibling office modules (approvals, document generator, KYC, password vault).
delete from integration_connections where kind in ('module_approvals','module_documents','module_kyc','module_vault');
update tasks set source_type = 'integration' where source_type in ('approval','document','kyc','offboarding');

alter table integration_connections drop constraint integration_connections_kind_check;
alter table integration_connections add constraint integration_connections_kind_check check (kind in ('ics_calendar','issues','helpdesk','code'));
alter table tasks drop constraint tasks_source_type_check;
alter table tasks add constraint tasks_source_type_check
  check (source_type in ('manual','quick_capture','recurring','integration','follow_up','ai_draft'));
