-- Synthetic trigger defects for the default security suite.
-- harness_audit rejects every row, so an ordinary trigger that fires during an anon write
-- turns the probe result into 'indeterminate'. A probe result of 'allowed' proves the trigger was suppressed.
create table public.harness_audit (id uuid, check (false));

create table public.harness_audited_write (id uuid primary key default gen_random_uuid());
alter table public.harness_audited_write enable row level security;
grant insert on public.harness_audited_write to anon;
create policy harness_audited_write_insert on public.harness_audited_write for insert to anon with check (true);

create function public.harness_audit_fn() returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.harness_audit (id) values (new.id);
  return new;
end;
$$;
create trigger harness_audited_write_audit after insert on public.harness_audited_write
  for each row execute function public.harness_audit_fn();

-- ENABLE ALWAYS triggers fire even in replica mode, so the suite must skip write probes here.
create table public.harness_always_write (id uuid primary key default gen_random_uuid());
alter table public.harness_always_write enable row level security;
grant insert on public.harness_always_write to anon;
create policy harness_always_write_insert on public.harness_always_write for insert to anon with check (true);
create trigger harness_always_write_audit after insert on public.harness_always_write
  for each row execute function public.harness_audit_fn();
alter table public.harness_always_write enable always trigger harness_always_write_audit;

notify pgrst, 'reload schema';
