import { resolve } from 'node:path';
import { createResult, newRunId, type Result } from '@budaknyenyel/kit-schema';
import { readBackendConfig } from './config.js';
import { executeOperation, operations } from './operations.js';
import { assertLocalUrl, BackendError, command, localStatus } from './stack.js';
import { prepareWorkdir } from './workdir.js';

export async function status(
  options: Record<string, unknown> = {},
): Promise<Result> {
  const startedAt = new Date();
  let state: Result['status'] = 'pass';
  let summary = 'Local stack status';
  let evidence: unknown[] = [];
  try {
    if (options.linked) throw new BackendError('Refusing linked project');
    const root = resolve(
      typeof options.projectRoot === 'string'
        ? options.projectRoot
        : process.cwd(),
    );
    const config = await readBackendConfig(root);
    const sourceRoot = config.supabaseDir
      ? resolve(root, config.supabaseDir)
      : root;
    const projectRoot = (await prepareWorkdir(sourceRoot)).root;
    let endpoints: Record<string, string>;
    try {
      endpoints = await localStatus({
        projectRoot,
        linked: Boolean(options.linked),
      });
    } catch (error) {
      if (
        error instanceof BackendError &&
        error.message ===
          'Local Supabase stack is not running or status is unavailable'
      ) {
        evidence = [{ running: false, ports: {}, appliedMigrations: null }];
        return createResult({
          tool: 'backend',
          operation: 'status',
          run_id: newRunId(),
          status: state,
          summary,
          evidence,
          artifacts: [],
          startedAt,
        });
      }
      throw error;
    }
    const ports: Record<string, number> = {};
    for (const [key, value] of Object.entries(endpoints)) {
      if (!key.endsWith('_URL')) continue;
      const url = new URL(value);
      assertLocalUrl(value, ['http:', 'https:', 'postgres:', 'postgresql:']);
      const port =
        url.port ||
        (url.protocol === 'https:'
          ? '443'
          : url.protocol === 'http:'
            ? '80'
            : '5432');
      ports[key] = Number(port);
    }
    const count = await command(
      'psql',
      [
        '-At',
        '-v',
        'ON_ERROR_STOP=1',
        '-c',
        'SELECT count(*) FROM supabase_migrations.schema_migrations',
        endpoints.DB_URL,
      ],
      projectRoot,
    );
    const appliedMigrations = Number(count.trim());
    if (!/^\d+$/.test(count.trim()) || !Number.isSafeInteger(appliedMigrations))
      throw new Error('Invalid migration count');
    evidence = [{ running: true, ports, appliedMigrations }];
  } catch (error) {
    state = error instanceof BackendError ? error.status : 'error';
    summary =
      error instanceof BackendError
        ? error.message
        : 'Unable to read local stack status';
  }
  return createResult({
    tool: 'backend',
    operation: 'status',
    run_id: newRunId(),
    status: state,
    summary,
    evidence,
    artifacts: [],
    startedAt,
  });
}

export function doctor(options: Record<string, unknown> = {}): Promise<Result> {
  return executeOperation('doctor', options);
}

const inputSchema = {
  type: 'object' as const,
  properties: {
    file: {
      type: 'string',
      description:
        'Scenario file path; omit for the default attack suite or the default init-scenario destination.',
    },
    version: { type: 'string' },
    scenario: { type: 'string' },
    sql: { type: 'string' },
    email: { type: 'string' },
    password: { type: 'string' },
    exclude: { type: 'array', items: { type: 'string' } },
    linked: { type: 'boolean' },
    strict: {
      type: 'boolean',
      description: 'Fail the default suite on inconclusive checks.',
    },
  },
  additionalProperties: false,
};

export function toolDefinitions(options: Record<string, unknown> = {}) {
  return operations.map((operation) => ({
    name: `backend_${operation}`,
    description:
      operation === 'default_suite'
        ? 'Run the default local security suite'
        : operation === 'run_attacks'
          ? 'Run the default local security suite, or probes from a scenario file'
          : operation === 'init_scenario'
            ? 'Create a starter scenario file without overwriting an existing file'
            : `Run backend ${operation.replaceAll('_', ' ')}`,
    inputSchema,
    handler: (input: Record<string, unknown> = {}) =>
      operation === 'status'
        ? status({
            ...input,
            ...options,
            projectRoot: options.projectRoot ?? process.cwd(),
          })
        : executeOperation(operation, {
            ...input,
            ...options,
            projectRoot: options.projectRoot ?? process.cwd(),
          }),
  }));
}
