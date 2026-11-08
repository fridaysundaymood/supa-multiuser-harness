import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.skipIf(process.platform === 'win32')(
  'runs the CLI through a symlink',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'harness-bin-'));
    try {
      const bin = join(dir, 'backend');
      await symlink(resolve('dist/cli/index.js'), bin, 'file');
      const result = await promisify(execFile)(process.execPath, [
        bin,
        '--help',
      ]);
      expect(result.stdout).toContain('Usage: backend');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
