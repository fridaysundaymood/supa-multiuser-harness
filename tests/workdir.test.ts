import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BackendError } from '../src/core/stack.js';
import { prepareWorkdir, rewriteConfig } from '../src/core/workdir.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

// Synthetic config shaped like a real project: foreign id, user ports, unsupported sections.
const synthetic = `project_id = "user-project"

[api]
port = 55321

[db]
port = 55322
shadow_port = 55320
orioledb_version = ""

[studio]
port = 55323

[local_smtp]
enabled = true
port = 54324

[experimental.pgdelta]
enabled = true

[auth]
site_url = "http://127.0.0.1:3000"
`;

describe('harness workdir rewrite', () => {
  it('forces the harness project id and moves ports into the harness block', () => {
    const { text, info } = rewriteConfig(synthetic);
    expect(text).toMatch(/^project_id = "ak-harness"$/m);
    expect(text).not.toContain('user-project');
    expect(text).toMatch(/^\[api\][\s\S]*?port = 57321/m);
    expect(text).toMatch(/^\[db\][\s\S]*?port = 57322/m);
    expect(text).toMatch(/shadow_port = 57324/);
    expect(text).toMatch(/^\[studio\][\s\S]*?port = 57323/m);
    expect(info).toContain(
      'project_id "user-project" replaced with "ak-harness"',
    );
    expect(info).toContain('api.port 55321 -> 57321');
  });

  it('removes unsupported sections and reports them as info, not silently', () => {
    const { text, info } = rewriteConfig(synthetic);
    expect(text).not.toContain('[local_smtp]');
    expect(text).not.toContain('[experimental.pgdelta]');
    expect(text).toContain('[auth]');
    expect(info).toContain(
      '[local_smtp] removed: unsupported by pinned Supabase CLI',
    );
    expect(info).toContain(
      '[experimental.pgdelta] removed: unsupported by pinned Supabase CLI',
    );
  });

  it('blocks when an unsupported db key carries a value that changes database semantics', () => {
    const risky = synthetic.replace(
      'orioledb_version = ""',
      'orioledb_version = "17.0"',
    );
    expect(() => rewriteConfig(risky)).toThrow(BackendError);
    expect(() => rewriteConfig(risky)).toThrow(/database engine semantics/);
  });

  it('refuses a config that does not parse', () => {
    expect(() => rewriteConfig('project_id = ')).toThrow(/not valid TOML/);
  });

  it('copies supabase/ into .android-kit and never writes the project original', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-workdir-'));
    roots.push(root);
    await mkdir(join(root, 'supabase', 'migrations'), { recursive: true });
    await writeFile(join(root, 'supabase', 'config.toml'), synthetic);
    await writeFile(
      join(root, 'supabase', 'migrations', '20260101_x.sql'),
      'select 1;',
    );
    const prepared = await prepareWorkdir(root);
    expect(prepared.dir).toContain(join('.android-kit', 'harness-stack'));
    expect(prepared.projectId).toBe('ak-harness');
    expect(await readFile(join(prepared.dir, 'config.toml'), 'utf8')).toMatch(
      /project_id = "ak-harness"/,
    );
    expect(await readFile(join(root, 'supabase', 'config.toml'), 'utf8')).toBe(
      synthetic,
    );
    expect(
      await readFile(
        join(prepared.dir, 'migrations', '20260101_x.sql'),
        'utf8',
      ),
    ).toBe('select 1;');
  });
});

describe('harness isolation guards', () => {
  it('never prepares a workdir from another project and leaves the original untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'harness-guard-'));
    roots.push(root);
    await mkdir(join(root, 'supabase'), { recursive: true });
    await writeFile(
      join(root, 'supabase', 'config.toml'),
      'project_id = "user-project"\n',
    );
    const prepared = await prepareWorkdir(root);
    expect(prepared.projectId).toBe('ak-harness');
    expect(await readFile(join(root, 'supabase', 'config.toml'), 'utf8')).toBe(
      'project_id = "user-project"\n',
    );
  });
});
