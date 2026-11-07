import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function doctorChecks() {
  const commands: Array<[string, string[], RegExp, string]> = [
    [process.execPath, ['--version'], /^v24\./m, 'Install Node.js 24 LTS'],
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
      'Install PostgreSQL client tools and add psql to PATH',
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
        const result = await exec(command, args, {
          timeout: 15000,
          windowsHide: true,
        });
        const output = `${result.stdout}\n${result.stderr}`;
        return {
          command,
          ok: expected.test(output),
          remedy: expected.test(output) ? undefined : remedy,
        };
      } catch {
        return { command, ok: false, remedy };
      }
    }),
  );
}
