-- An authenticated token without a subject must not gain access to tasks.
create policy defect_missing_sub_task_read on public.tasks for select to authenticated
  using ((select auth.uid()) is null);
