import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

const sqlCalls = vi.hoisted(() => [] as string[]);
vi.mock('../src/core/stack.js', () => ({
  BackendError: class BackendError extends Error {},
  localStatus: async () => ({
    API_URL: 'http://127.0.0.1:57321',
    ANON_KEY: 'anon',
  }),
  command: async (_program: string, args: string[]) => {
    const sql = args[args.indexOf('-c') + 1];
    if (sql.startsWith('SELECT json_build_object'))
      return JSON.stringify({
        tables: [
          {
            schema: 'public',
            name: 'x$probe$; SELECT 1; --',
            kind: 'r',
            rls: true,
          },
        ],
        functions: [],
      });
    sqlCalls.push(sql);
    return '0\n0\n[]';
  },
}));
vi.mock('../src/core/signing.js', () => ({
  detectSigningKey: () => ({ algorithm: 'HS256', secret: 'synthetic' }),
}));

import { runCatalogAttacks } from '../src/core/catalog-attacks.js';

it('uses a fresh dollar quote that cannot be closed by a catalog identifier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'harness-probe-'));
  const originalFetch = globalThis.fetch;
  try {
    await mkdir(join(root, 'supabase'));
    await writeFile(
      join(root, 'supabase', 'config.toml'),
      'project_id = "local"\n',
    );
    globalThis.fetch = async () => new Response('[]', { status: 401 });
    sqlCalls.length = 0;
    await runCatalogAttacks({ projectRoot: root });
    await runCatalogAttacks({ projectRoot: root });
    const tags = sqlCalls.map(
      (sql) => sql.match(/DO (\$probe_[a-f0-9]+\$)/)?.[1],
    );
    expect(tags[0]).toBeTruthy();
    expect(tags[1]).toBeTruthy();
    expect(tags[0]).not.toBe(tags[1]);
    for (let i = 0; i < sqlCalls.length; i++) {
      expect(sqlCalls[i]).toContain('x$probe$; SELECT 1; --');
      expect(sqlCalls[i].split(tags[i]!).length).toBe(3);
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});
