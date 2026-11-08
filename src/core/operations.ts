import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  createResult,
  newRunId,
  type Result,
  runArtifactDir,
  type Status,
  writeArtifactIndex,
} from '@budaknyenyel/kit-schema';
import { parse } from 'yaml';
import {
  type AutomaticAttackOptions,
  runAutomaticAttacks,
} from './automatic-attacks.js';
import { discoverCatalog, runCatalogAttacks } from './catalog-attacks.js';
import { readBackendConfig } from './config.js';
import { doctorChecks } from './doctor.js';
import { mintUser } from './identity.js';
import {
  runCron,
  stackAt,
  stackDown,
  stackMigrate,
  stackSeed,
  stackServeFunctions,
  stackUp,
  stackVerify,
} from './stack.js';
import {
  type AttackOptions,
  type RaceOptions,
  runAttacks,
  runRaces,
  runScenario,
  type ScenarioOptions,
} from './suites.js';
import { status as stackStatus } from './tools.js';
import { prepareWorkdir } from './workdir.js';

export const operations = [
  'doctor',
  'status',
  'stack_up',
  'stack_down',
  'stack_verify',
  'stack_at',
  'stack_seed',
  'stack_migrate',
  'stack_serve_functions',
  'mint_user',
  'init_scenario',
  'default_suite',
  'run_scenario',
  'run_attacks',
  'run_races',
  'run_cron',
] as const;
export type Operation = (typeof operations)[number];

/** Operations that start, query, mutate or stop the local stack; they run only in the isolated workdir. */
const STACK_OPERATIONS = new Set<string>([
  'stack_up',
  'stack_down',
  'stack_verify',
  'stack_at',
  'stack_seed',
  'stack_migrate',
  'stack_serve_functions',
  'mint_user',
  'init_scenario',
  'default_suite',
  'run_scenario',
  'run_attacks',
  'run_races',
  'run_cron',
]);

async function containedFile(
  root: string,
  file: string,
  creating: boolean,
): Promise<string> {
  const target = resolve(root, file);
  const inside = (base: string, path: string) => {
    const rel = relative(base, path);
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if (!inside(root, target))
    throw Object.assign(new Error('File must be inside the project root'), {
      status: 'blocked',
    });
  const realRoot = await realpath(root);
  const actual = await realpath(creating ? dirname(target) : target);
  if (!inside(realRoot, actual))
    throw Object.assign(new Error('File must be inside the project root'), {
      status: 'blocked',
    });
  return target;
}
export async function executeOperation(
  operation: Operation,
  options: Record<string, unknown> = {},
): Promise<Result> {
  if (operation === 'status') return stackStatus(options);
  const startedAt = new Date();
  const runId = newRunId();
  const projectRoot = resolve(
    typeof options.projectRoot === 'string'
      ? options.projectRoot
      : process.cwd(),
  );
  const artifactDir = runArtifactDir(projectRoot, runId, 'backend');
  let status: Status = 'pass';
  let summary = 'Operation completed';
  let evidence: unknown[] = [];
  const artifacts: string[] = [];
  try {
    if (options.linked)
      throw Object.assign(new Error('Linked projects are forbidden'), {
        status: 'blocked',
      });
    const file =
      operation === 'init_scenario'
        ? await containedFile(
            projectRoot,
            typeof options.file === 'string'
              ? options.file
              : 'harness-scenario.yaml',
            true,
          )
        : (operation === 'run_scenario' ||
              operation === 'run_attacks' ||
              operation === 'run_races') &&
            typeof options.file === 'string'
          ? await containedFile(projectRoot, options.file, false)
          : undefined;
    const config = await readBackendConfig(projectRoot);
    const sourceRoot = config.supabaseDir
      ? resolve(projectRoot, config.supabaseDir)
      : projectRoot;
    // Every stack-touching operation runs against an isolated copy; the project's own supabase/ is never started.
    const stackRoot = STACK_OPERATIONS.has(operation)
      ? (await prepareWorkdir(sourceRoot)).root
      : sourceRoot;
    await mkdir(artifactDir, { recursive: true });
    let output: unknown;
    switch (operation) {
      case 'doctor': {
        const checks = await doctorChecks();
        output = checks;
        if (checks.some((check) => !check.ok && !check.optional))
          status = 'blocked';
        break;
      }
      case 'stack_up':
        output = await stackUp({
          projectRoot: stackRoot,
          exclude: Array.isArray(options.exclude)
            ? (options.exclude as string[])
            : undefined,
        });
        break;
      case 'stack_down':
        output = await stackDown({ projectRoot: stackRoot });
        break;
      case 'stack_verify': {
        const result = await stackVerify({
          projectRoot: stackRoot,
          artifactDir,
        });
        if (!result.matches) status = 'fail';
        if (result.diff)
          artifacts.push(
            relative(projectRoot, result.diff).split('\\').join('/'),
          );
        output = { matches: result.matches, missing: result.missing };
        break;
      }
      case 'stack_at':
        output = await stackAt({
          projectRoot: stackRoot,
          version: String(options.version ?? ''),
        });
        break;
      case 'stack_seed':
        output = await stackSeed({
          projectRoot: stackRoot,
          scenario: String(options.scenario ?? ''),
        });
        break;
      case 'stack_migrate':
        output = await stackMigrate({ projectRoot: stackRoot });
        break;
      case 'stack_serve_functions':
        output = await stackServeFunctions({ projectRoot: stackRoot });
        break;
      case 'run_cron':
        output = await runCron({
          projectRoot: stackRoot,
          sql: String(options.sql ?? ''),
        });
        break;
      case 'mint_user':
        await mintUser({
          projectRoot: stackRoot,
          email: String(options.email ?? ''),
          password:
            typeof options.password === 'string' ? options.password : undefined,
        });
        output = {
          message:
            'Identity created; credentials are available only to in-process callers.',
        };
        break;
      case 'init_scenario': {
        const catalog = await discoverCatalog({ projectRoot: stackRoot });
        const target = file!;
        const resources = [
          ...catalog.tables.map(
            (table) =>
              `# table ${JSON.stringify(`${table.schema}.${table.name}`)}`,
          ),
          ...catalog.functions.map(
            (fn) => `# RPC ${JSON.stringify(`${fn.schema}.${fn.name}`)}`,
          ),
        ];
        const template = [
          '# Local-only scenario. Supply synthetic credentials and adapt the requests and assertions.',
          '# Tokens must carry the intended role, subject and claims. Never commit credentials.',
          '# Discovered resources:',
          ...resources,
          'connection:',
          '  baseUrl: http://127.0.0.1:57321',
          '  apiKey: ""',
          '  tokens:',
          '    actor: ""',
          'steps:',
          '  - kind: request',
          '    name: local API discovery',
          '    request:',
          '      actor: actor',
          '      path: /rest/v1/',
          '    checks:',
          '      - kind: status',
          '        equals: 200',
          '',
        ].join('\n');
        await writeFile(target, template, { flag: 'wx', mode: 0o600 });
        output = {
          file: relative(projectRoot, target).split('\\').join('/'),
          resources: resources.length,
        };
        break;
      }
      case 'default_suite':
        output = await runCatalogAttacks({
          projectRoot: stackRoot,
          strict: options.strict === true,
        });
        break;
      case 'run_scenario':
      case 'run_attacks':
      case 'run_races': {
        if (typeof options.file !== 'string') {
          if (operation === 'run_attacks') {
            output = await runCatalogAttacks({
              projectRoot: stackRoot,
              strict: options.strict === true,
            });
            break;
          }
          throw Object.assign(
            new Error(
              operation === 'run_races'
                ? 'Race checks require an explicit race options file; create race.yaml and run backend run races race.yaml'
                : 'Cross-user checks require an explicit scenario file; run backend init-scenario harness-scenario.yaml and edit it',
            ),
            { status: 'unsupported' },
          );
        }
        const definition: unknown = parse(await readFile(file!, 'utf8'));
        if (operation === 'run_scenario')
          output = await runScenario(definition as ScenarioOptions);
        else if (operation === 'run_attacks')
          output =
            definition &&
            typeof definition === 'object' &&
            'policies' in definition
              ? await runAutomaticAttacks(definition as AutomaticAttackOptions)
              : await runAttacks(definition as AttackOptions);
        else output = await runRaces(definition as RaceOptions);
        break;
      }
    }
    if (
      output &&
      typeof output === 'object' &&
      'status' in output &&
      ['pass', 'fail', 'flaky', 'blocked', 'unsupported', 'error'].includes(
        String(output.status),
      )
    )
      status = output.status as Status;
    evidence = output === undefined ? [] : [output];
    summary = status === 'pass' ? 'Operation completed' : `Operation ${status}`;
    if (
      (operation === 'default_suite' ||
        (operation === 'run_attacks' && typeof options.file !== 'string')) &&
      output &&
      typeof output === 'object' &&
      'summary' in output &&
      output.summary &&
      typeof output.summary === 'object' &&
      'inconclusive' in output.summary &&
      Number(output.summary.inconclusive) > 0
    )
      summary += `; ${output.summary.inconclusive} inconclusive checks. Seed rows with a scenario (backend run scenario).`;
  } catch (error) {
    const requested =
      error && typeof error === 'object' && 'status' in error
        ? error.status
        : undefined;
    status =
      requested === 'blocked' || requested === 'unsupported'
        ? requested
        : 'error';
    summary =
      status === 'error'
        ? 'Operation failed; check inputs and local prerequisites'
        : String((error as Error).message);
    console.error(
      JSON.stringify({ level: 'error', operation, message: summary }),
    );
  }
  const index = await writeArtifactIndex(
    projectRoot,
    runId,
    'backend',
    artifacts,
  );
  return createResult({
    tool: 'backend',
    operation,
    run_id: runId,
    status,
    summary,
    evidence,
    artifacts: [...artifacts, index],
    startedAt,
  });
}
