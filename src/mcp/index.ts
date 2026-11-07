#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { toolDefinitions } from '../core/tools.js';

const tools = toolDefinitions();
const server = new Server(
  { name: 'backend', version: '1.0.0' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  })),
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = tools.find(({ name }) => name === request.params.name);
  if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);
  const result = await tool.handler(request.params.arguments ?? {});
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    isError: result.status !== 'pass',
  };
});
await server.connect(new StdioServerTransport());
