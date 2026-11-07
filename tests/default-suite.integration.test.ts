import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runCatalogAttacks } from '../src/core/catalog-attacks.js';
import { command, localStatus } from '../src/core/stack.js';

it.skipIf(!process.env.BACKEND_DEFAULT_SUITE_FIXTURE)(
  'detects catalog and missing-sub defects without retaining probe writes',
  async () => {
    const projectRoot = process.env.BACKEND_DEFAULT_SUITE_FIXTURE as string;
    const config = await readFile(
      join(projectRoot, 'supabase', 'config.toml'),
      'utf8',
    );
    if (!/^project_id\s*=\s*["']ak-harness["']/m.test(config))
      throw new Error('Integration test requires the owned ak-harness project');
    await localStatus({ projectRoot });
    const sql = async (statement: string) =>
      command(
        'docker',
        [
          'exec',
          'supabase_db_ak-harness',
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
    const defect = await readFile(
      join(process.cwd(), 'tests', 'fixtures', 'missing-sub-read.sql'),
      'utf8',
    );
    const catalogDefects = await readFile(
      join(process.cwd(), 'tests', 'fixtures', 'default-suite-defects.sql'),
      'utf8',
    );
    let installed = false;
    try {
      await sql(`begin;\n${defect}\n${catalogDefects}\ncommit;`);
      installed = true;
      const before = await sql(
        'select count(*) from public.harness_anon_write',
      );
      const result = await runCatalogAttacks({ projectRoot });
      const after = await sql('select count(*) from public.harness_anon_write');
      expect(after).toBe(before);
      expect(result.status).toBe('fail');
      expect(
        result.findings.find(
          (f) => f.resource === 'public.tasks' && f.check === 'missing sub',
        )?.outcome,
      ).toBe('fail');
      expect(
        result.findings.find(
          (f) =>
            f.resource === 'public.harness_no_rls' &&
            f.check === 'row level security',
        )?.outcome,
      ).toBe('fail');
      expect(
        result.findings.find(
          (f) =>
            f.resource === 'public.harness_anon_write' &&
            f.check === 'anonymous write',
        )?.outcome,
      ).toBe('fail');
    } finally {
      if (installed)
        await sql(
          "begin; drop policy defect_missing_sub_task_read on public.tasks; drop table public.harness_no_rls, public.harness_anon_write; notify pgrst, 'reload schema'; commit;",
        );
    }
  },
  120_000,
);
