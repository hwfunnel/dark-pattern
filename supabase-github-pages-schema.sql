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

create index if not exists audit_items_report_id_idx on audit_items(report_id);
create index if not exists audit_items_uploaded_at_idx on audit_items(uploaded_at desc);

alter table audit_reports enable row level security;
alter table audit_items enable row level security;

drop policy if exists "public read audit reports" on audit_reports;
drop policy if exists "public insert audit reports" on audit_reports;
drop policy if exists "public update audit reports" on audit_reports;
drop policy if exists "public delete audit reports" on audit_reports;

drop policy if exists "public read audit items" on audit_items;
drop policy if exists "public insert audit items" on audit_items;
drop policy if exists "public update audit items" on audit_items;
drop policy if exists "public delete audit items" on audit_items;

create policy "public read audit reports"
on audit_reports for select
to anon
using (true);

create policy "public insert audit reports"
on audit_reports for insert
to anon
with check (true);

create policy "public update audit reports"
on audit_reports for update
to anon
using (true)
with check (true);

create policy "public delete audit reports"
on audit_reports for delete
to anon
using (true);

create policy "public read audit items"
on audit_items for select
to anon
using (true);

create policy "public insert audit items"
on audit_items for insert
to anon
with check (true);

create policy "public update audit items"
on audit_items for update
to anon
using (true)
with check (true);

create policy "public delete audit items"
on audit_items for delete
to anon
using (true);

insert into storage.buckets (id, name, public)
values ('audit-files', 'audit-files', true)
on conflict (id) do update set public = true;

drop policy if exists "public read audit files" on storage.objects;
drop policy if exists "public upload audit files" on storage.objects;
drop policy if exists "public update audit files" on storage.objects;
drop policy if exists "public delete audit files" on storage.objects;

create policy "public read audit files"
on storage.objects for select
to anon
using (bucket_id = 'audit-files');

create policy "public upload audit files"
on storage.objects for insert
to anon
with check (bucket_id = 'audit-files');

create policy "public update audit files"
on storage.objects for update
to anon
using (bucket_id = 'audit-files')
with check (bucket_id = 'audit-files');

create policy "public delete audit files"
on storage.objects for delete
to anon
using (bucket_id = 'audit-files');
