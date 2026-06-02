#!/usr/bin/env node
import { SkillManager } from './skill-manager.js';
import { MCPManager } from './mcp-manager.js';
import { CLIManager } from './cli-manager.js';

const skillMgr = new SkillManager();
const mcpMgr = new MCPManager();
const cliMgr = new CLIManager();

const tools = [
  {
    name: 'ctx_skill_list',
    description: 'List all available skills with name and one-line description. Call this first before ctx_skill_get.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'ctx_skill_get',
    description: 'Get full SKILL.md content for a specific skill by name.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Skill name' } },
      required: ['name'],
    },
  },
  {
    name: 'ctx_mcp_use',
    description: 'Spawn an MCP server if needed, call a method, and return the result. Manages lifecycle automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'MCP server name' },
        method: { type: 'string', description: 'Method to call' },
        args: { type: 'object', description: 'Method arguments' },
      },
      required: ['name', 'method'],
    },
  },
  {
    name: 'ctx_cli_run',
    description: 'Execute a registered CLI tool and return structured output.',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'CLI tool name' },
        args: { type: 'array', items: { type: 'string' }, description: 'Arguments' },
      },
      required: ['tool'],
    },
  },
  {
    name: 'ctx_status',
    description: 'Get full system status: skills count, MCPs running, CLIs available.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

async function handleRequest(request) {
  const { method, params } = request;

  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ctx', version: '0.1.0' },
      };

    case 'notifications/initialized':
      return {};

    case 'tools/list':
      return { tools };

    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments || {};

      switch (toolName) {
        case 'ctx_skill_list': {
          const skills = await skillMgr.list();
          return { content: [{ type: 'text', text: JSON.stringify(skills, null, 2) }] };
        }

        case 'ctx_skill_get': {
          const content = await skillMgr.get(args.name);
          return { content: [{ type: 'text', text: content }] };
        }

        case 'ctx_mcp_use': {
          const result = await mcpMgr.call(args.name, args.method, args.args || {});
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'ctx_cli_run': {
          const result = await cliMgr.run(args.tool, args.args || []);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'ctx_status': {
          const skills = await skillMgr.list();
          const mcps = await mcpMgr.list();
          const clis = await cliMgr.list();
          const status = {
            skills: { total: skills.length },
            mcps: {
              total: mcps.length,
              running: mcps.filter((m) => m.status === 'running').length,
              stopped: mcps.filter((m) => m.status === 'stopped').length,
            },
            clis: {
              total: clis.length,
              installed: clis.filter((c) => c.installed).length,
              missing: clis.filter((c) => !c.installed).length,
            },
          };
          return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
        }

        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }
    }

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

// MCP Server using stdio JSON-RPC
export async function startMCPServer() {
  let buffer = '';

  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', async (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let request;
      try {
        request = JSON.parse(trimmed);
      } catch {
        continue;
      }

      const response = { jsonrpc: '2.0', id: request.id };
      try {
        response.result = await handleRequest(request);
      } catch (err) {
        response.error = { code: -32000, message: err.message };
      }

      process.stdout.write(JSON.stringify(response) + '\n');
    }
  });

  process.stdin.on('end', () => process.exit(0));

  // Keep alive
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}
