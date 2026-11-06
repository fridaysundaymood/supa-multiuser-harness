import { mkdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import {
  createResult,
  newRunId,
  type Result,
  runArtifactDir,
  type Status,
  writeArtifactIndex,
} from '@android-kit/schema';
import { parse } from 'yaml';
import {
  type AutomaticAttackOptions,
  runAutomaticAttacks,
} from './automatic-attacks.js';
import { readBackendConfig } from './config.js';
import { doctor } from './doctor.js';
import { mintUser } from './identity.js';
import {
  runCron,
  stackAt,
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

export const operations = [
  'doctor',
  'stack_up',
  'stack_verify',
  'stack_at',
  'stack_seed',
  'stack_migrate',
  'stack_serve_functions',
  'mint_user',
  'run_scenario',
  'run_attacks',
  'run_races',
  'run_cron',
] as const;
export type Operation = (typeof operations)[number];
export async function executeOperation(
  operation: Operation,
  options: Record<string, unknown> = {},
): Promise<Result> {
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
    const config = await readBackendConfig(projectRoot);
    const stackRoot = config.supabaseDir
      ? resolve(projectRoot, config.supabaseDir)
      : projectRoot;
    await mkdir(artifactDir, { recursive: true });
    let output: unknown;
    switch (operation) {
      case 'doctor': {
        const checks = await doctor();
        output = checks;
        if (checks.some((check) => !check.ok)) status = 'blocked';
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
      case 'run_scenario':
      case 'run_attacks':
      case 'run_races': {
        if (typeof options.file !== 'string')
          throw new Error('A scenario file is required');
        const definition: unknown = parse(
          await readFile(resolve(projectRoot, options.file), 'utf8'),
        );
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
