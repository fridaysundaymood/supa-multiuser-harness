#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { executeOperation, operations } from '../core/operations.js';

const server = new McpServer({ name: 'backend', version: '1.0.0' });
for (const operation of operations) {
  server.registerTool(
    `backend_${operation}`,
    {
      description: `Run backend ${operation.replaceAll('_', ' ')}`,
      inputSchema: {
        projectRoot: z.string().optional(),
        file: z.string().optional(),
        version: z.string().optional(),
        scenario: z.string().optional(),
        sql: z.string().optional(),
        email: z.string().optional(),
        password: z.string().optional(),
        exclude: z.array(z.string()).optional(),
        linked: z.boolean().optional(),
      },
    },
    async (options) => {
      const result = await executeOperation(operation, options);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        isError: result.status !== 'pass',
      };
    },
  );
}
await server.connect(new StdioServerTransport());
