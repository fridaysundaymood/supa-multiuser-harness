import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { doctorChecks } from '../src/core/doctor.js';
import {
  assertLocalUrl,
  BackendError,
  command,
  localStatus,
  normalizeDump,
  runCron,
  stackAt,
  stackDown,
  stackMigrate,
  stackSeed,
  stackVerify,
  startupPortConflict,
} from '../src/core/stack.js';
import { status } from '../src/core/tools.js';

describe('local stack safety', () => {
  it('accepts loopback and rejects remote or deceptive endpoints', () => {
    expect(() =>
      assertLocalUrl('postgresql://postgres@127.0.0.1:54322/postgres', [
        'postgresql:',
      ]),
    ).not.toThrow();
    for (const url of [
      'https://localhost.example.com',
      'https://10.0.2.2',
      'https://example.com',
      'file:///tmp/x',
    ]) {
      expect(() => assertLocalUrl(url, ['http:', 'https:'])).toThrow(
        BackendError,
      );
    }
  });
  it('refuses linked operations before consulting the stack', async () => {
    await expect(
      stackMigrate({ projectRoot: '.', linked: true }),
    ).rejects.toThrow('linked');
    await expect(
      stackAt({ projectRoot: '.', version: '20260101', linked: true }),
    ).rejects.toThrow('linked');
  });

  it('refuses to stop a synthetic non-harness project before any CLI call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backend-stop-'));
    try {
      await mkdir(join(root, 'supabase'));
      await writeFile(
        join(root, 'supabase', 'config.toml'),
        'project_id = "other-project"\n',
      );
      await expect(stackDown({ projectRoot: root })).rejects.toThrow(
        'other than ak-harness',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('normalizes dump metadata but preserves SQL and schema comments', () => {
    const dump =
      '-- Dumped by pg_dump version 16\r\n\\restrict abc\r\n-- meaningful comment\r\nCREATE TABLE x (id int);\r\n';
    expect(normalizeDump(dump)).toBe(
      '-- meaningful comment\nCREATE TABLE x (id int);\n',
    );
    expect(normalizeDump('CREATE TABLE x (id text);')).not.toBe(
      normalizeDump('CREATE TABLE x (id int);'),
    );
  });

  it('does not include command arguments in errors', async () => {
    await expect(
      command('backend-missing-executable', ['secret-value'], '.'),
    ).rejects.toThrow('backend-missing-executable command failed');
  });

  it('reports a synthetic occupied startup port without exposing stderr', () => {
    const error = startupPortConflict(
      'secret-value: Bind for 0.0.0.0:12345 failed: port is already allocated',
    );
    expect(error).toBeInstanceOf(BackendError);
    expect(error?.message).toContain('12345');
    expect(error?.message).toContain('supabase/config.toml');
    expect(error?.message).not.toContain('secret-value');
    expect(startupPortConflict('unrelated failure')).toBeUndefined();
  });

  it.skipIf(!process.env.BACKEND_VERIFY_FIXTURE)(
    'executes seed and cron SQL and reports migration status',
    async () => {
      const projectRoot = process.env.BACKEND_VERIFY_FIXTURE as string;
      const text = await readFile(
        join(projectRoot, 'supabase', 'config.toml'),
        'utf8',
      );
      if (!/^project_id\s*=\s*["']ak-harness["']/m.test(text))
        throw new Error(
          'Integration test requires the owned ak-harness project',
        );
      await localStatus({ projectRoot });
      const seedDir = join(projectRoot, 'supabase', 'seeds');
      const scenario = `harness-${randomUUID()}`;
      const seedPath = join(seedDir, `${scenario}.sql`);
      await mkdir(seedDir, { recursive: true });
      try {
        await writeFile(seedPath, 'select 1;\n', { flag: 'wx' });
        await stackSeed({ projectRoot, scenario });
        await runCron({ projectRoot, sql: 'select 1' });
        expect((await status({ projectRoot })).status).toBe('pass');
        expect(
          (await doctorChecks()).find((check) => check.command === 'psql'),
        ).toMatchObject({ ok: true });
      } finally {
        await rm(seedPath, { force: true });
      }
    },
    60_000,
  );

  it.skipIf(!process.env.BACKEND_VERIFY_FIXTURE)(
    'compares a clean local fixture and reports schema drift',
    async () => {
      const projectRoot = process.env.BACKEND_VERIFY_FIXTURE as string;
      const text = await readFile(
        join(projectRoot, 'supabase', 'config.toml'),
        'utf8',
      );
      if (!/^project_id\s*=\s*["']ak-harness["']/m.test(text))
        throw new Error(
          'Integration test requires the owned ak-harness project',
        );
      await localStatus({ projectRoot });
      const artifactDir = await mkdtemp(join(tmpdir(), 'backend-verify-test-'));
      let altered = false;
      try {
        const clean = await stackVerify({ projectRoot, artifactDir });
        expect(clean).toMatchObject({ matches: true, missing: [] });
        await command(
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
            '-c',
            'ALTER TABLE public.tasks ADD COLUMN harness_drift_test text',
          ],
          projectRoot,
        );
        altered = true;
        const drift = await stackVerify({ projectRoot, artifactDir });
        expect(drift.matches).toBe(false);
        expect(await readFile(drift.diff as string, 'utf8')).toContain(
          'harness_drift_test',
        );
      } finally {
        if (altered)
          await command(
            'docker',
            [
              'exec',
              'supabase_db_ak-harness',
              'psql',
              '-U',
              'postgres',
              '-d',
              'postgres',
              '-c',
              'ALTER TABLE public.tasks DROP COLUMN harness_drift_test',
            ],
            projectRoot,
          );
        await rm(artifactDir, { recursive: true, force: true });
      }
    },
    1_200_000,
  );
});
