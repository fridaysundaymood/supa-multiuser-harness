import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { commandExecutable } from './stack.js';

const exec = promisify(execFile);

export async function doctorChecks() {
  const commands: Array<[string, string[], RegExp, string]> = [
    ['node', ['--version'], /^v24\./m, 'Install Node.js 24 LTS'],
    [
      'docker',
      ['info', '--format', '{{.ServerVersion}}'],
      /\d+\.\d+/,
      'Start Docker Desktop or the Docker engine',
    ],
    ['supabase', ['--version'], /^2\./m, 'Install Supabase CLI >=2 <3'],
    [
      'psql',
      ['--version'],
      /psql \(PostgreSQL\) \d+/,
      'Optional: host psql is not required when the container path (docker exec supabase_db_<id> psql) works',
    ],
    [
      'adb',
      ['version'],
      /Android Debug Bridge version/m,
      'Install Android SDK platform-tools',
    ],
    ['java', ['-version'], /version "21[."]/, 'Install JDK 21'],
    ['gradle', ['--version'], /Gradle [89]\./, 'Install Gradle 8 or 9'],
  ];
  return Promise.all(
    commands.map(async ([command, args, expected, remedy]) => {
      try {
        const result = await exec(commandExecutable(command), args, {
          timeout: 15000,
          windowsHide: true,
        });
        const output = `${result.stdout}\n${result.stderr}`;
        return {
          command,
          ok: expected.test(output),
          optional: command === 'psql' || undefined,
          remedy: expected.test(output) ? undefined : remedy,
        };
      } catch {
        return {
          command,
          ok: false,
          optional: command === 'psql' || undefined,
          remedy,
        };
      }
    }),
  );
}
