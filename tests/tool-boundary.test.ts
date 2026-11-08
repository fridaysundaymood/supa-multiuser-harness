import { expect, it } from 'vitest';
import { toolDefinitions } from '../src/core/tools.js';

it('does not expose launch-fixed projectRoot in MCP input', () => {
  for (const tool of toolDefinitions({ projectRoot: '/fixed/project' })) {
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.properties).not.toHaveProperty('projectRoot');
  }
});
