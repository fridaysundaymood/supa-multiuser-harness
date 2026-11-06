import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { operations } from '../src/core/operations.js';

describe('adapter parity', () => {
  it('registers every core operation for MCP and the CLI', async () => {
    const cli = await readFile(
      new URL('../src/cli/index.ts', import.meta.url),
      'utf8',
    );
    const mcp = await readFile(
      new URL('../src/mcp/index.ts', import.meta.url),
      'utf8',
    );
    expect(cli).toContain('operations.includes');
    expect(mcp).toContain('for (const operation of operations)');
    expect(operations).toHaveLength(12);
  });
});
