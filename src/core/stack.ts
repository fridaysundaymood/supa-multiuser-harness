import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export class BackendError extends Error {
  constructor(
    message: string,
    readonly status: 'blocked' | 'unsupported' = 'blocked',
  ) {
    super(message);
  }
}
export interface StackOptions {
  projectRoot: string;
  linked?: boolean;
}

export async function command(
  program: string,
  args: string[],
  cwd: string,
): Promise<string> {
  try {
    return (
      await exec(program, args, {
        cwd,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      })
    ).stdout;
  } catch {
    throw new Error(`${program} command failed`);
  }
}
export function assertLocalUrl(value: string, protocols: string[]): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BackendError('Invalid local stack endpoint');
  }
  if (
    !protocols.includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  )
    throw new BackendError('Refusing non-local stack endpoint');
}
export async function localStatus(
  options: StackOptions,
): Promise<Record<string, string>> {
  if (options.linked) throw new BackendError('Refusing linked project');
  const root = resolve(options.projectRoot);
  try {
    await access(join(root, 'supabase', '.temp', 'project-ref'));
    throw new BackendError('Refusing linked project');
  } catch (error) {
    if (error instanceof BackendError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await access(join(root, 'supabase', 'config.toml'));
  let status: Record<string, string>;
  try {
    status = JSON.parse(
      await command('supabase', ['status', '-o', 'json'], root),
    ) as Record<string, string>;
  } catch {
    throw new BackendError(
      'Local Supabase stack is not running or status is unavailable',
    );
  }
  assertLocalUrl(status.DB_URL, ['postgres:', 'postgresql:']);
  if (status.API_URL) assertLocalUrl(status.API_URL, ['http:', 'https:']);
  const config = await readFile(join(root, 'supabase', 'config.toml'), 'utf8');
  const projectId = config.match(/^\s*project_id\s*=\s*["']([^"']+)["']/m)?.[1];
  if (!projectId || !/^[\w.-]+$/.test(projectId))
    throw new BackendError('Cannot verify local project identity');
  try {
    const details = JSON.parse(
      await command('docker', ['inspect', `supabase_db_${projectId}`], root),
    ) as Array<{
      State: { Running: boolean };
      NetworkSettings: {
        Ports: Record<string, Array<{ HostPort: string }> | null>;
      };
    }>;
    const dbPort = new URL(status.DB_URL).port || '5432';
    if (
      !details[0]?.State.Running ||
      !details[0].NetworkSettings.Ports['5432/tcp']?.some(
        (binding) => binding.HostPort === dbPort,
      )
    )
      throw new Error();
  } catch {
    throw new BackendError(
      'Cannot verify the local database container and endpoint',
    );
  }
  if (status.API_URL) {
    try {
      const details = JSON.parse(
        await command(
          'docker',
          ['inspect', `supabase_kong_${projectId}`],
          root,
        ),
      ) as Array<{
        State: { Running: boolean };
        NetworkSettings: {
          Ports: Record<string, Array<{ HostPort: string }> | null>;
        };
      }>;
      const endpoint = new URL(status.API_URL);
      const apiPort =
        endpoint.port || (endpoint.protocol === 'https:' ? '443' : '80');
      if (
        !details[0]?.State.Running ||
        !Object.values(details[0].NetworkSettings.Ports).some((bindings) =>
          bindings?.some((binding) => binding.HostPort === apiPort),
        )
      )
        throw new Error();
    } catch {
      throw new BackendError(
        'Cannot verify the local API container and endpoint',
      );
    }
  }
  return status;
}
async function ensureUnlinked(options: StackOptions): Promise<void> {
  if (options.linked) throw new BackendError('Refusing linked project');
  try {
    await access(
      join(resolve(options.projectRoot), 'supabase', '.temp', 'project-ref'),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new BackendError('Refusing linked project');
}
export async function stackUp(
  options: StackOptions & { exclude?: string[] },
): Promise<void> {
  await ensureUnlinked(options);
  const args = ['start'];
  if (options.exclude?.length)
    args.push('--exclude', options.exclude.join(','));
  await command('supabase', args, options.projectRoot);
  await localStatus(options);
}
export async function stackAt(
  options: StackOptions & { version: string },
): Promise<void> {
  if (!/^\d+$/.test(options.version))
    throw new BackendError('Invalid migration version');
  await localStatus(options);
  await command(
    'supabase',
    ['db', 'reset', '--local', '--no-seed', '--version', options.version],
    options.projectRoot,
  );
}
export async function stackMigrate(options: StackOptions): Promise<void> {
  await localStatus(options);
  await command(
    'supabase',
    ['migration', 'up', '--local'],
    options.projectRoot,
  );
}
export async function stackSeed(
  options: StackOptions & { scenario: string },
): Promise<void> {
  if (!/^[\w-]+$/.test(options.scenario))
    throw new BackendError('Invalid scenario name');
  const status = await localStatus(options);
  const path = join(
    resolve(options.projectRoot),
    'supabase',
    'seeds',
    `${options.scenario}.sql`,
  );
  await access(path);
  await command(
    'psql',
    ['-v', 'ON_ERROR_STOP=1', '-f', path, status.DB_URL],
    options.projectRoot,
  );
}
export async function runCron(
  options: StackOptions & { sql: string },
): Promise<void> {
  const status = await localStatus(options);
  await command(
    'psql',
    ['-v', 'ON_ERROR_STOP=1', '-c', options.sql, status.DB_URL],
    options.projectRoot,
  );
}
export async function stackServeFunctions(
  options: StackOptions,
): Promise<void> {
  const status = await localStatus(options);
  if (
    !status.API_URL ||
    !(status.ANON_KEY || status.PUBLISHABLE_KEY) ||
    !(status.SERVICE_ROLE_KEY || status.SECRET_KEY)
  )
    throw new BackendError(
      'Local function credentials unavailable',
      'unsupported',
    );
  const dir = await mkdtemp(join(tmpdir(), 'backend-functions-'));
  try {
    const envPath = join(dir, 'local.env');
    await writeFile(
      envPath,
      `SUPABASE_URL=${status.API_URL}\nSUPABASE_ANON_KEY=${status.ANON_KEY || status.PUBLISHABLE_KEY}\nSUPABASE_SERVICE_ROLE_KEY=${status.SERVICE_ROLE_KEY || status.SECRET_KEY}\n`,
      { mode: 0o600 },
    );
    await command(
      'supabase',
      ['functions', 'serve', '--env-file', envPath],
      options.projectRoot,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export function normalizeDump(dump: string): string {
  return `${dump
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter(
      (line) =>
        !/^-- (Dumped (from|by)|Started on|Completed on)/.test(line) &&
        !/^\\(un)?restrict\s/.test(line),
    )
    .join('\n')
    .trim()}\n`;
}
export async function stackVerify(
  options: StackOptions & { artifactDir: string },
): Promise<{ matches: boolean; missing: string[]; diff?: string }> {
  await localStatus(options);
  const root = resolve(options.projectRoot);
  const files = await readdir(join(root, 'supabase', 'migrations'));
  const versions = files
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .map((f) => f.split('_')[0]);
  const config = await readFile(join(root, 'supabase', 'config.toml'), 'utf8');
  const projectId = config.match(/^\s*project_id\s*=\s*["']([^"']+)["']/m)?.[1];
  if (!projectId || !/^[\w.-]+$/.test(projectId))
    throw new BackendError('Cannot verify local project identity');
  const recorded = await command(
    'docker',
    [
      'exec',
      `supabase_db_${projectId}`,
      'psql',
      '-U',
      'postgres',
      '-d',
      'postgres',
      '-At',
      '-c',
      'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version',
    ],
    root,
  );
  const applied = new Set(recorded.trim().split(/\s+/));
  const missing = versions.filter((v) => !applied.has(v));
  const dir = await mkdtemp(join(tmpdir(), 'backend-scratch-'));
  let started = false;
  try {
    await cp(join(root, 'supabase'), join(dir, 'supabase'), {
      recursive: true,
      filter: (path) => !path.includes(`${join('supabase', '.temp')}`),
    });
    const configPath = join(dir, 'supabase', 'config.toml');
    let config = await readFile(configPath, 'utf8');
    const id = `scratch_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    config = config.replace(/^project_id\s*=.*$/m, `project_id = "${id}"`);
    if (!/^project_id\s*=/m.test(config))
      config = `project_id = "${id}"\n${config}`;
    // A second stack needs non-conflicting configured ports; leave other settings intact.
    const base = 20000 + Math.floor(Math.random() * 20000);
    let index = 0;
    config = config.replace(
      /^(\s*(?:port|shadow_port|analytics_port|db_port|smtp_port|pop3_port)\s*=\s*)\d+/gm,
      (_line, prefix: string) => `${prefix}${base + index++}`,
    );
    await writeFile(configPath, config);
    started = true;
    await command('supabase', ['db', 'start'], dir);
    const target = normalizeDump(
      await command('supabase', ['db', 'dump', '--local'], root),
    );
    const scratch = normalizeDump(
      await command('supabase', ['db', 'dump', '--local'], dir),
    );
    const matches = missing.length === 0 && target === scratch;
    if (matches) return { matches, missing };
    await mkdir(options.artifactDir, { recursive: true });
    const diff = join(options.artifactDir, 'schema-diff.txt');
    await writeFile(
      diff,
      `Missing migrations: ${missing.join(', ') || 'none'}\n--- target\n${target}+++ scratch\n${scratch}`,
    );
    return { matches, missing, diff };
  } finally {
    if (started)
      await command('supabase', ['stop', '--no-backup'], dir).catch(
        () => undefined,
      );
    await rm(dir, { recursive: true, force: true });
  }
}
