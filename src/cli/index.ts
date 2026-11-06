#!/usr/bin/env node
import { exitCodeFor } from '@android-kit/schema';
import {
  executeOperation,
  type Operation,
  operations,
} from '../core/operations.js';

const args = process.argv.slice(2);
const json = args.includes('--json');
const words: string[] = [];
const options: Record<string, unknown> = {};
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === undefined) break;
  if (arg === '--json') continue;
  if (arg.startsWith('--')) {
    const name = arg
      .slice(2)
      .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    if (name === 'linked') options.linked = true;
    else options[name] = args[++i];
  } else words.push(arg);
}
const key = words
  .slice(0, words[0] === 'doctor' || words[0] === 'mint-user' ? 1 : 2)
  .join('_')
  .replaceAll('-', '_');
const positional = words.slice(key === 'doctor' || key === 'mint_user' ? 1 : 2);
if (key === 'stack_at') options.version = positional[0];
if (key === 'stack_seed') options.scenario = positional[0];
if (key.startsWith('run_') && key !== 'run_cron') options.file = positional[0];
if (!operations.includes(key as Operation)) {
  console.error('Unknown command');
  process.exitCode = 2;
} else {
  const result = await executeOperation(key as Operation, options);
  console.log(
    json
      ? JSON.stringify(result)
      : `${result.status}: ${result.summary}\n${JSON.stringify(result.evidence, null, 2)}`,
  );
  process.exitCode = exitCodeFor(result.status);
}
