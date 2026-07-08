create table if not exists audit_reports (
  id text primary key,
  title text not null,
  risk_level text not null default '보통',
  description text not null default '',
  owner text not null default '',
  status text not null default '검토 전',
  created_at timestamptz not null default now(),
  files jsonb not null default '[]'::jsonb
);

create table if not exists audit_items (
  id text primary key,
  report_id text not null references audit_reports(id) on delete cascade,
  sort_index integer not null default 0,
  image_url text not null default '',
  screen_name text not null default '',
  risk_level text not null default '보통',
  fix text not null default '',
  reason text not null default '',
  checklist text not null default '',
  area text not null default '',
  source_file_name text not null default '',
  needs_review boolean not null default false,
  uploaded_at timestamptz not null default now()
);

create table if not exists audit_history (
  id bigserial primary key,
  action text not null,
  report_id text,
  item_id text,
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_reports_created_at_idx on audit_reports(created_at desc);
create index if not exists audit_items_report_id_idx on audit_items(report_id);
create index if not exists audit_history_created_at_idx on audit_history(created_at desc);
create index if not exists audit_history_report_id_idx on audit_history(report_id);
