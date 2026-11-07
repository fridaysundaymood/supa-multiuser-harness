import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { BackendError } from './stack.js';

/** Harness project id; every Supabase operation runs under this id and nothing else. */
export const harnessProjectId = 'ak-harness';

/** Harness host-port block, keyed by config section so each service keeps its meaning. */
export const harnessPorts: Record<string, number> = {
  'api.port': 57321,
  'db.port': 57322,
  'studio.port': 57323,
  'db.shadow_port': 57324,
  'analytics.port': 57325,
  'db.pooler.port': 57326,
};

/** Services excluded by default: the mail service binds a fixed host port the pinned CLI does not let us move. */
export const defaultExcludedServices = ['mailpit', 'inbucket'];

/** Sections the pinned CLI (2.75) cannot parse; removing them only affects the local mailer or schema-diff engine. */
const unsupportedSections = ['local_smtp', 'experimental.pgdelta'];

export interface PreparedWorkdir {
  /** Isolated project root; its `supabase/` is the only one the CLI runs in. */
  root: string;
  /** The isolated `supabase/` directory. */
  dir: string;
  projectId: string;
  /** Evidence: every config change made for the harness. */
  info: string[];
}

function sectionOf(line: string): string | undefined {
  const match = /^\s*\[([^\]]+)\]\s*$/.exec(line);
  return match?.[1]?.trim();
}

/**
 * Rewrite a Supabase config for the harness. Pure; touches no disk.
 * - Forces `project_id` to `expectedId`.
 * - Moves known service ports into the harness block by section (not by order).
 * - Removes sections the pinned CLI cannot parse.
 * - Blocks when an unsupported key with a non-empty value would change database behaviour.
 */
export function rewriteConfig(
  source: string,
  expectedId: string = harnessProjectId,
): { text: string; info: string[] } {
  try {
    parseToml(source);
  } catch {
    throw new BackendError('Supabase config is not valid TOML');
  }
  const info: string[] = [];
  const lines = source.split(/\r?\n/);
  const out: string[] = [];
  let section = '';
  let skipping = false;
  let sawProjectId = false;
  for (const line of lines) {
    const header = sectionOf(line);
    if (header !== undefined) {
      section = header;
      skipping = unsupportedSections.includes(header);
      if (skipping) {
        info.push(`[${header}] removed: unsupported by pinned Supabase CLI`);
        continue;
      }
    } else if (/^\s*\[\[?/.test(line)) {
      skipping = false;
    }
    if (skipping) continue;
    if (section === '' && /^\s*project_id\s*=/.test(line)) {
      const current = /=\s*["']([^"']*)["']/.exec(line)?.[1];
      if (current !== expectedId)
        info.push(
          `project_id "${current ?? ''}" replaced with "${expectedId}"`,
        );
      out.push(`project_id = "${expectedId}"`);
      sawProjectId = true;
      continue;
    }
    if (section === 'db' && /^\s*orioledb_version\s*=/.test(line)) {
      const value = /=\s*["']?([^"'\s]*)/.exec(line)?.[1] ?? '';
      if (value !== '')
        throw new BackendError(
          'Unsupported db.orioledb_version changes database engine semantics; upgrade the pinned Supabase CLI',
        );
      info.push(
        'db.orioledb_version (empty) removed: unsupported by pinned Supabase CLI',
      );
      continue;
    }
    const port = /^(\s*port\s*=\s*)(\d+)(.*)$/.exec(line);
    const key = `${section}.port`;
    const mapped = port ? harnessPorts[key] : undefined;
    if (port && mapped !== undefined) {
      info.push(`${key} ${port[2]} -> ${mapped}`);
      out.push(`${port[1]}${mapped}${port[3]}`);
      continue;
    }
    const shadow = /^(\s*shadow_port\s*=\s*)(\d+)(.*)$/.exec(line);
    if (shadow && section === 'db') {
      const next = harnessPorts['db.shadow_port'];
      info.push(`db.shadow_port ${shadow[2]} -> ${next}`);
      out.push(`${shadow[1]}${next}${shadow[3]}`);
      continue;
    }
    out.push(line);
  }
  if (!sawProjectId) out.unshift(`project_id = "${expectedId}"`);
  return { text: out.join('\n'), info };
}

/** Sync project inputs into the isolated workdir without disturbing CLI state. */
export async function prepareWorkdir(
  projectRoot: string,
  expectedId: string = harnessProjectId,
): Promise<PreparedWorkdir> {
  const source = resolve(projectRoot, 'supabase');
  const base = resolve(projectRoot, '.android-kit', 'harness-stack');
  const rewritten = rewriteConfig(
    await readFile(join(source, 'config.toml'), 'utf8'),
    expectedId,
  );
  const parsedId = parseToml(rewritten.text).project_id;
  if (parsedId !== expectedId)
    throw new BackendError(
      `Refusing Supabase project "${String(parsedId)}"; only "${expectedId}" may be started`,
    );
  const dir = join(base, 'supabase');
  await mkdir(dir, { recursive: true });
  for (const name of ['migrations', 'seeds', 'seed.sql', 'functions']) {
    const target = join(dir, name);
    await rm(target, { recursive: true, force: true });
    try {
      await cp(join(source, name), target, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await writeFile(join(dir, 'config.toml'), rewritten.text);
  return { root: base, dir, projectId: expectedId, info: rewritten.info };
}

export async function removeWorkdir(projectRoot: string): Promise<void> {
  await rm(resolve(projectRoot, '.android-kit', 'harness-stack'), {
    recursive: true,
    force: true,
  });
}
