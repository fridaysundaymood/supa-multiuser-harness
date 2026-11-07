import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { executeOperation } from '../src/core/operations.js';

const calls = vi.hoisted(
  () => [] as Array<{ program: string; args: string[]; cwd: string }>,
);
vi.mock('node:child_process', () => {
  const execFile = Object.assign(() => {}, {
    [promisify.custom]: async (
      program: string,
      args: string[],
      options: { cwd: string },
    ) => {
      calls.push({ program, args, cwd: options.cwd });
      let stdout = '';
      if (program.includes('supabase') && args[0] === 'status')
        stdout = JSON.stringify({
          DB_URL: 'postgresql://localhost:57322/postgres',
          API_URL: 'http://localhost:57321',
        });
      else if (program === 'docker' && args[0] === 'inspect')
        stdout = JSON.stringify([
          {
            State: { Running: true },
            NetworkSettings: {
              Ports: {
                '5432/tcp': [{ HostPort: '57322' }],
                '8000/tcp': [{ HostPort: '57321' }],
              },
            },
          },
        ]);
      else if (program === 'docker' && args[0] === 'ps')
        stdout = 'supabase_db_ak-harness';
      else if (program === 'psql') stdout = '0';
      return { stdout, stderr: '' };
    },
  });
  return { execFile };
});

let root = '';
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  calls.length = 0;
});

it('keeps CLI state and uses an isolated config across up, status, verify and down', async () => {
  root = await mkdtemp(join(tmpdir(), 'harness-isolation-'));
  const source = join(root, 'supabase');
  const isolated = join(root, '.android-kit', 'harness-stack');
  await mkdir(join(source, 'migrations'), { recursive: true });
  const config =
    'project_id = "someone-else"\n[api]\nport = 54321\n[db]\nport = 54322\nshadow_port = 54320\n';
  await writeFile(join(source, 'config.toml'), config);
  expect(
    (await executeOperation('stack_up', { projectRoot: root })).status,
  ).toBe('pass');
  await mkdir(join(isolated, 'supabase', '.temp'), { recursive: true });
  await writeFile(join(isolated, 'supabase', '.temp', 'cli-state'), 'preserve');
  for (const operation of ['status', 'stack_verify', 'stack_down'] as const) {
    expect(
      (await executeOperation(operation, { projectRoot: root })).status,
    ).toBe('pass');
    expect(
      await readFile(join(isolated, 'supabase', '.temp', 'cli-state'), 'utf8'),
    ).toBe('preserve');
  }
  expect(await readFile(join(source, 'config.toml'), 'utf8')).toBe(config);
  const rewritten = await readFile(
    join(isolated, 'supabase', 'config.toml'),
    'utf8',
  );
  expect(rewritten).toContain('project_id = "ak-harness"');
  expect(rewritten).toContain('port = 57321');
  expect(rewritten).toContain('port = 57322');
  expect(rewritten).toContain('shadow_port = 57324');
  const cliCalls = calls.filter((call) => call.program.includes('supabase'));
  expect(cliCalls.some((call) => call.args[0] === 'start')).toBe(true);
  expect(
    cliCalls.some((call) => call.args[0] === 'stop' && call.cwd === isolated),
  ).toBe(true);
  expect(cliCalls.every((call) => call.cwd !== root)).toBe(true);
});
