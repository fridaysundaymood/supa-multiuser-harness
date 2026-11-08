import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { executeOperation } from '../src/core/operations.js';
import { projectIdentity } from '../src/core/workdir.js';

const calls = vi.hoisted(
  () => [] as Array<{ program: string; args: string[]; cwd: string }>,
);
const database = vi.hoisted(() => ({ owner: '', running: false }));
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
        stdout = database.running ? 'supabase_db_owned' : '';
      else if (program.includes('supabase') && args[0] === 'start')
        database.running = true;
      else if (program === 'psql') {
        const sql = args[args.indexOf('-c') + 1] ?? '';
        const marker = sql.match(/harness-owner:ak-harness-[0-9a-f]+/);
        if (sql.startsWith('COMMENT ON DATABASE') && marker)
          database.owner = marker[0];
        stdout = sql.includes('shobj_description') ? database.owner : '0';
      }
      return { stdout, stderr: '' };
    },
  });
  return { execFile };
});

let root = '';
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  calls.length = 0;
  database.owner = '';
  database.running = false;
  vi.unstubAllEnvs();
});

it('keeps CLI state and uses an isolated config across up, status, verify and down', async () => {
  vi.stubEnv('BACKEND_PORT_BASE', '57321');
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
  const id = await projectIdentity(root);
  expect(rewritten).toContain(`project_id = "${id}"`);
  expect(rewritten).toContain('port = 57321');
  expect(rewritten).toContain('port = 57322');
  expect(rewritten).toContain('shadow_port = 57324');
  const cliCalls = calls.filter((call) => call.program.includes('supabase'));
  expect(cliCalls.some((call) => call.args[0] === 'start')).toBe(true);
  expect(
    cliCalls.some(
      (call) =>
        call.args[0] === 'stop' &&
        call.args.includes(id) &&
        call.cwd === isolated,
    ),
  ).toBe(true);
  expect(cliCalls.every((call) => call.cwd !== root)).toBe(true);
  database.owner = 'harness-owner:foreign';
  for (const operation of [
    'stack_at',
    'run_cron',
    'stack_down',
    'status',
  ] as const) {
    const result = await executeOperation(operation, {
      projectRoot: root,
      version: '20260101',
      sql: 'select 1',
    });
    expect(result.status).not.toBe('pass');
  }
}, 30000);

it('blocks scenario paths outside the project, including symlink escapes', async () => {
  root = await mkdtemp(join(tmpdir(), 'harness-paths-'));
  const project = join(root, 'project');
  const outside = join(root, 'outside');
  await mkdir(project);
  await mkdir(outside);
  await writeFile(join(outside, 'scenario.yaml'), 'steps: []');
  for (const operation of [
    'run_scenario',
    'run_attacks',
    'run_races',
  ] as const) {
    expect(
      (
        await executeOperation(operation, {
          projectRoot: project,
          file: '../outside/scenario.yaml',
        })
      ).status,
    ).toBe('blocked');
    expect(
      (
        await executeOperation(operation, {
          projectRoot: project,
          file: join(outside, 'scenario.yaml'),
        })
      ).status,
    ).toBe('blocked');
  }
  expect(
    (
      await executeOperation('init_scenario', {
        projectRoot: project,
        file: '../outside/new.yaml',
      })
    ).status,
  ).toBe('blocked');
  try {
    await symlink(outside, join(project, 'escape'), 'junction');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
    throw error;
  }
  for (const operation of ['run_scenario', 'run_attacks', 'run_races'] as const)
    expect(
      (
        await executeOperation(operation, {
          projectRoot: project,
          file: 'escape/scenario.yaml',
        })
      ).status,
    ).toBe('blocked');
  expect(
    (
      await executeOperation('init_scenario', {
        projectRoot: project,
        file: 'escape/new.yaml',
      })
    ).status,
  ).toBe('blocked');
  try {
    await symlink(
      join(outside, 'scenario.yaml'),
      join(project, 'file-link.yaml'),
      'file',
    );
    expect(
      (
        await executeOperation('run_scenario', {
          projectRoot: project,
          file: 'file-link.yaml',
        })
      ).status,
    ).toBe('blocked');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
  }
});
