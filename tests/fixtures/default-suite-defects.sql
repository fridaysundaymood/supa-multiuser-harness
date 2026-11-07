-- Disposable synthetic tables for the default security suite regression.
create table public.harness_no_rls (id uuid primary key default gen_random_uuid());
grant select on public.harness_no_rls to authenticated;

create table public.harness_anon_write (id uuid primary key default gen_random_uuid());
alter table public.harness_anon_write enable row level security;
grant select, insert on public.harness_anon_write to anon, authenticated;
create policy harness_anon_write_insert on public.harness_anon_write
  for insert to anon with check (true);
notify pgrst, 'reload schema';
