#!/usr/bin/env node
import { SkillManager } from './skill-manager.js';
import { MCPManager } from './mcp-manager.js';
import { CLIManager } from './cli-manager.js';
import { suggest } from './suggest.js';
import { discover } from './discover.js';
import { syncInit, syncPush, syncPull, syncStatus } from './sync.js';
import { patchHermes, unpatchHermes, isHermesPatched } from './hermes-patch.js';

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
  {
    name: 'ctx_suggest',
    description: 'Find relevant skills, MCPs, and CLIs for a task description.',
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string', description: 'Natural language task description' } },
      required: ['task'],
    },
  },
  {
    name: 'ctx_tool_brief',
    description: 'List all available tools with one-line descriptions. Use this first to discover what tools exist, then ctx_tool_inspect for full schema.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'ctx_tool_inspect',
    description: 'Get the full JSON schema for a specific tool. Use after ctx_tool_brief to get details before calling a tool.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Tool name (e.g. ctx_skill_get, github:create_issue)' } },
      required: ['name'],
    },
  },
  {
    name: 'ctx_discover',
    description: 'Scan agent configs for skills, MCPs, and plugins. Returns what exists, what is new, and what differs.',
    inputSchema: {
      type: 'object',
      properties: {
        auto: { type: 'boolean', description: 'Auto-import new items (default false)' },
      },
      required: [],
    },
  },
  {
    name: 'ctx_sync',
    description: 'Sync ctx registries with a git remote. Supports init, push, pull, status.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['init', 'push', 'pull', 'status'], description: 'Sync action' },
        remote: { type: 'string', description: 'Remote URL (for init)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'ctx_hermes',
    description: 'Manage Hermes prompt builder patch. Actions: patch, unpatch, status.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['patch', 'unpatch', 'status'] },
      },
      required: ['action'],
    },
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

        case 'ctx_suggest': {
          const results = await suggest(args.task);
          return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
        }

        case 'ctx_tool_brief': {
          // Get brief tool list from all registered MCPs
          const allTools = [];
          const mcps = await mcpMgr.list();
          for (const mcp of mcps) {
            try {
              const result = await mcpMgr.call(mcp.name, 'tools/list', {});
              const tools = result?.tools || [];
              for (const t of tools) {
                allTools.push({
                  server: mcp.name,
                  name: t.name,
                  description: t.description || '',
                });
              }
            } catch {}
          }
          // Add ctx's own tools
          const ownTools = [
            { server: 'ctx', name: 'ctx_suggest', description: 'Find relevant tools for a task' },
            { server: 'ctx', name: 'ctx_tool_brief', description: 'List all tools with one-line descriptions' },
            { server: 'ctx', name: 'ctx_tool_inspect', description: 'Get full JSON schema for a tool' },
            { server: 'ctx', name: 'ctx_skill_list', description: 'List registered skills' },
            { server: 'ctx', name: 'ctx_skill_get', description: 'Load full skill content by name' },
            { server: 'ctx', name: 'ctx_mcp_use', description: 'Spawn and call an MCP server' },
            { server: 'ctx', name: 'ctx_cli_run', description: 'Execute a CLI tool' },
            { server: 'ctx', name: 'ctx_discover', description: 'Scan for new skills/MCPs' },
            { server: 'ctx', name: 'ctx_sync', description: 'Sync registries to/from git remote' },
            { server: 'ctx', name: 'ctx_status', description: 'System overview' },
          ];
          allTools.push(...ownTools);
          return { content: [{ type: 'text', text: JSON.stringify({ tools: allTools, count: allTools.length }, null, 2) }] };
        }

        case 'ctx_tool_inspect': {
          // Find full schema for a specific tool
          const toolName = args.name;
          let found = null;

          // Search MCPs for the tool
          const mcpsForInspect = await mcpMgr.list();
          for (const mcp of mcpsForInspect) {
            try {
              const result = await mcpMgr.call(mcp.name, 'tools/list', {});
              const tools = result?.tools || [];
              const match = tools.find((t) => t.name === toolName || `${mcp.name}:${t.name}` === toolName);
              if (match) {
                found = { server: mcp.name, ...match };
                break;
              }
            } catch {}
          }

          if (!found) {
            return { content: [{ type: 'text', text: JSON.stringify({ error: `Tool '${toolName}' not found in any registered MCP server` }) }] };
          }

          return { content: [{ type: 'text', text: JSON.stringify(found, null, 2) }] };
        }

        case 'ctx_discover': {
          const result = await discover({ auto: args.auto || false, dryRun: !args.auto });
          return { content: [{ type: 'text', text: JSON.stringify(result.report, null, 2) }] };
        }

        case 'ctx_sync': {
          let result;
          switch (args.action) {
            case 'init': result = await syncInit(args.remote); break;
            case 'push': result = await syncPush(); break;
            case 'pull': result = await syncPull(); break;
            case 'status': result = await syncStatus(); break;
            default: result = { exitCode: 1, message: `Unknown action: ${args.action}` };
          }
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'ctx_hermes': {
          let result;
          switch (args.action) {
            case 'patch': result = await patchHermes(); break;
            case 'unpatch': result = await unpatchHermes(); break;
            case 'status': result = await isHermesPatched(); break;
            default: result = { message: `Unknown action: ${args.action}` };
          }
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
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
  const messageQueue = [];
  let processing = false;

  async function processNext() {
    if (processing || messageQueue.length === 0) return;
    processing = true;

    while (messageQueue.length > 0) {
      const request = messageQueue.shift();
      const response = { jsonrpc: '2.0', id: request.id };
      try {
        response.result = await handleRequest(request);
      } catch (err) {
        response.error = { code: -32000, message: err.message };
      }

      process.stdout.write(JSON.stringify(response) + '\n');
    }

    processing = false;
    if (messageQueue.length > 0) processNext();
  }

  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        messageQueue.push(JSON.parse(trimmed));
      } catch { continue; }
    }

    processNext();
  });

  process.stdin.on('end', () => process.exit(0));

  // Keep alive
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}
