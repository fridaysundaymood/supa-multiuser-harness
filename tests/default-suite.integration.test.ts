import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runCatalogAttacks } from '../src/core/catalog-attacks.js';
import { command, localStatus } from '../src/core/stack.js';
import { workdirIdentity } from '../src/core/workdir.js';

it.skipIf(!process.env.BACKEND_DEFAULT_SUITE_FIXTURE)(
  'detects catalog, trigger and missing-sub defects without retaining probe writes',
  async () => {
    const projectRoot = process.env.BACKEND_DEFAULT_SUITE_FIXTURE as string;
    const projectId = await workdirIdentity(projectRoot);
    await localStatus({ projectRoot });
    const sql = async (statement: string) =>
      command(
        'docker',
        [
          'exec',
          `supabase_db_${projectId}`,
          'psql',
          '-U',
          'postgres',
          '-d',
          'postgres',
          '-v',
          'ON_ERROR_STOP=1',
          '-At',
          '-c',
          statement,
        ],
        projectRoot,
      );
    const count = Number(await sql('select count(*) from public.tasks'));
    if (!count)
      throw new Error(
        'Seed the fixture with synthetic tasks before running this test',
      );
    const clean = await runCatalogAttacks({ projectRoot });
    expect(clean.status).toBe('pass');
    expect(
      clean.findings.find(
        (f) => f.resource === 'public.tasks' && f.check === 'missing sub',
      )?.outcome,
    ).toBe('info');
    const missingSub = await readFile(
      join(process.cwd(), 'tests', 'fixtures', 'missing-sub-read.sql'),
      'utf8',
    );
    const catalogDefects = await readFile(
      join(process.cwd(), 'tests', 'fixtures', 'default-suite-defects.sql'),
      'utf8',
    );
    const triggerDefects = await readFile(
      join(
        process.cwd(),
        'tests',
        'fixtures',
        'default-suite-trigger-defects.sql',
      ),
      'utf8',
    );
    let installed = false;
    try {
      await sql(
        `begin;\n${missingSub}\n${catalogDefects}\n${triggerDefects}\ncommit;`,
      );
      installed = true;
      const beforeAudit = await sql(
        'select count(*) from public.harness_audit',
      );
      const before = await sql(
        'select count(*) from public.harness_anon_write',
      );
      const result = await runCatalogAttacks({ projectRoot });
      const after = await sql('select count(*) from public.harness_anon_write');
      expect(after).toBe(before);
      expect(await sql('select count(*) from public.harness_audit')).toBe(
        beforeAudit,
      );
      expect(result.status).toBe('fail');
      const outcomes = new Map(
        result.findings.map((f) => [`${f.resource} ${f.check}`, f.outcome]),
      );
      expect(outcomes.get('public.tasks missing sub')).toBe('fail');
      expect(outcomes.get('public.harness_no_rls row level security')).toBe(
        'fail',
      );
      expect(outcomes.get('public.harness_anon_write anonymous write')).toBe(
        'fail',
      );
      // Ordinary trigger suppressed in replica mode: anon INSERT is 'allowed', not 'indeterminate'.
      const audited = result.findings.filter(
        (f) =>
          f.resource === 'public.harness_audited_write' &&
          f.check === 'anonymous write',
      );
      expect(audited.some((f) => f.detail.startsWith('INSERT: allowed'))).toBe(
        true,
      );
      // ENABLE ALWAYS trigger: write probes skipped, reported as blocked with evidence.
      expect(outcomes.get('public.harness_always_write anonymous write')).toBe(
        'blocked',
      );
      expect(
        result.findings.find(
          (f) =>
            f.resource === 'public.harness_always_write' &&
            f.check === 'anonymous write',
        )?.detail,
      ).toContain('harness_always_write_audit');
    } finally {
      if (installed)
        await sql(
          "begin; drop table public.harness_always_write; drop table public.harness_audited_write; drop function public.harness_audit_fn(); drop table public.harness_audit; drop policy defect_missing_sub_task_read on public.tasks; drop table public.harness_no_rls, public.harness_anon_write; notify pgrst, 'reload schema'; commit;",
        );
    }
  },
  120_000,
);
