import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { operations } from '../src/core/operations.js';
import { toolDefinitions } from '../src/core/tools.js';

describe('adapter parity', () => {
  it('exposes every operation through CLI and MCP definitions', async () => {
    const cli = await readFile(
      new URL('../src/cli/index.ts', import.meta.url),
      'utf8',
    );
    const mcp = await readFile(
      new URL('../src/mcp/index.ts', import.meta.url),
      'utf8',
    );
    expect(cli).toContain('operations.includes');
    expect(mcp).toContain('toolDefinitions()');
    expect(toolDefinitions().map((tool) => tool.name)).toEqual(
      operations.map((name) => `backend_${name}`),
    );
  });

  it('imports the package root without starting stdio', async () => {
    const before = process.stdin.listenerCount('data');
    const api = await import('../src/core/index.js');
    // The import itself is the behavior under test.
    expect(process.stdin.listenerCount('data')).toBe(before);
    expect(
      api.toolDefinitions().some((tool) => tool.name === 'backend_status'),
    ).toBe(true);
  });

  it('refuses linked status requests without touching a stack', async () => {
    const result = await toolDefinitions()
      .find((tool) => tool.name === 'backend_status')
      ?.handler({ linked: true });
    expect(result?.status).toBe('blocked');
  });
});
