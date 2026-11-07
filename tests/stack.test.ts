import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertLocalUrl,
  BackendError,
  command,
  localStatus,
  normalizeDump,
  stackAt,
  stackMigrate,
  stackVerify,
} from '../src/core/stack.js';

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
