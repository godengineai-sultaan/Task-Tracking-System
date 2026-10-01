-- Extension points for feature areas: export report types are registered in code (exports.ts registry).
alter table exports drop constraint exports_report_check;
alter table exports add constraint exports_report_check check (report ~ '^[a-z_]{2,40}$');
