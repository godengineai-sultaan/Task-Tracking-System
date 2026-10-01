-- Task sources used by feature areas (task templates, automation rules).
alter table tasks drop constraint tasks_source_type_check;
alter table tasks add constraint tasks_source_type_check
  check (source_type in ('manual','quick_capture','recurring','integration','follow_up','ai_draft','template','automation'));
