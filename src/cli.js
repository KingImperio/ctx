#!/usr/bin/env node
import { SkillManager } from './skill-manager.js';
import { MCPManager } from './mcp-manager.js';
import { CLIManager } from './cli-manager.js';
import { runSetup } from './setup.js';

const skillMgr = new SkillManager();
const mcpMgr = new MCPManager();
const cliMgr = new CLIManager();

export async function runCLI(args) {
  const [category, command, ...rest] = args;

  if (!category || category === 'help' || category === '--help') {
    printHelp();
    return;
  }

  if (category === 'setup') {
    console.log('Setting up ctx...\n');
    const results = await runSetup();
    results.forEach((r) => console.log(r));
    console.log('\nDone! Run `ctx status` to see your setup.');
    return;
  }

  if (category === 'status') {
    await printStatus();
    return;
  }

  switch (category) {
    case 'skill':
      await handleSkill(command, rest);
      break;
    case 'mcp':
      await handleMCP(command, rest);
      break;
    case 'cli':
      await handleCLI(command, rest);
      break;
    default:
      console.error(`Unknown command: ${category}`);
      printHelp();
      process.exit(1);
  }
}

async function handleSkill(cmd, args) {
  switch (cmd) {
    case 'list': {
      const skills = await skillMgr.list();
      if (skills.length === 0) {
        console.log('No skills registered. Add one with: ctx skill add <path>');
        return;
      }
      console.log(`Skills (${skills.length}):\n`);
      for (const s of skills) {
        console.log(`  ${s.name}`);
        console.log(`    ${s.description}\n`);
      }
      break;
    }
    case 'get': {
      if (!args[0]) { console.error('Usage: ctx skill get <name>'); process.exit(1); }
      const content = await skillMgr.get(args[0]);
      console.log(content);
      break;
    }
    case 'add': {
      if (!args[0]) { console.error('Usage: ctx skill add <path>'); process.exit(1); }
      const name = await skillMgr.add(args[0]);
      console.log(`✓ Added skill: ${name}`);
      break;
    }
    case 'remove': {
      if (!args[0]) { console.error('Usage: ctx skill remove <name>'); process.exit(1); }
      const name = await skillMgr.remove(args[0]);
      console.log(`✓ Removed skill: ${name}`);
      break;
    }
    default:
      console.error(`Unknown skill command: ${cmd}`);
      console.error('Usage: ctx skill <list|get|add|remove>');
      process.exit(1);
  }
}

async function handleMCP(cmd, args) {
  switch (cmd) {
    case 'list': {
      const mcps = await mcpMgr.list();
      if (mcps.length === 0) {
        console.log('No MCPs registered. Add one with: ctx mcp add <name> <command>');
        return;
      }
      console.log(`MCPs (${mcps.length}):\n`);
      for (const m of mcps) {
        const status = m.status === 'running' ? `[running, pid ${m.pid}]` : '[stopped]';
        console.log(`  ${m.name} ${status}`);
        console.log(`    ${m.description || m.command}\n`);
      }
      break;
    }
    case 'use': {
      if (args.length < 2) { console.error('Usage: ctx mcp use <name> <method> [args]'); process.exit(1); }
      const [name, method, ...rest] = args;
      let callArgs = {};
      if (rest.length > 0) {
        try { callArgs = JSON.parse(rest.join(' ')); } catch { callArgs = { query: rest.join(' ') }; }
      }
      console.log(`Calling ${name}.${method}...`);
      const result = await mcpMgr.call(name, method, callArgs);
      console.log(JSON.stringify(result, null, 2));
      // Exit immediately after response — don't wait for MCP to die
      process.exit(0);
    }
    case 'add': {
      if (args.length < 2) { console.error('Usage: ctx mcp add <name> <command> [args...]'); process.exit(1); }
      const [name, command, ...rest] = args;
      const name2 = await mcpMgr.add(name, command, rest, {}, '');
      console.log(`✓ Added MCP: ${name2}`);
      break;
    }
    case 'kill': {
      if (!args[0]) { console.error('Usage: ctx mcp kill <name>'); process.exit(1); }
      const killed = await mcpMgr.kill(args[0]);
      if (killed) console.log(`✓ Killed MCP: ${args[0]}`);
      else console.log(`MCP '${args[0]}' is not running`);
      break;
    }
    case 'status': {
      const statuses = await mcpMgr.status();
      if (statuses.length === 0) {
        console.log('No MCPs registered.');
        return;
      }
      console.log('MCP Status:\n');
      for (const s of statuses) {
        const status = s.status === 'running' ? `RUNNING (pid ${s.pid})` : 'STOPPED';
        const lastUsed = s.lastUsed ? new Date(s.lastUsed).toISOString() : 'never';
        const uptime = s.uptime ? ` | uptime: ${Math.round(s.uptime / 1000)}s` : '';
        console.log(`  ${s.name}: ${status}${uptime} | last used: ${lastUsed}`);
      }
      break;
    }
    case 'watchdog': {
      const killed = await mcpMgr.watchdog();
      if (killed.length === 0) {
        console.log('No idle MCPs to kill.');
      } else {
        console.log(`Killed ${killed.length} idle MCP(s): ${killed.join(', ')}`);
      }
      break;
    }
    default:
      console.error(`Unknown mcp command: ${cmd}`);
      console.error('Usage: ctx mcp <list|use|add|kill|status|watchdog>');
      process.exit(1);
  }
}

async function handleCLI(cmd, args) {
  switch (cmd) {
    case 'list': {
      const clis = await cliMgr.list();
      if (clis.length === 0) {
        console.log('No CLIs registered. Add one with: ctx cli add <name> <binary>');
        return;
      }
      console.log(`CLIs (${clis.length}):\n`);
      for (const c of clis) {
        const status = c.installed ? '✓' : '✗';
        console.log(`  ${status} ${c.name} (${c.binary})`);
        if (c.description) console.log(`    ${c.description}`);
      }
      console.log();
      break;
    }
    case 'run': {
      if (!args[0]) { console.error('Usage: ctx cli run <tool> [args...]'); process.exit(1); }
      const [tool, ...rest] = args;
      const result = await cliMgr.run(tool, rest);
      if (result.stdout) console.log(result.stdout);
      if (result.stderr) console.error(result.stderr);
      if (result.exitCode !== 0) process.exit(result.exitCode);
      break;
    }
    case 'add': {
      if (args.length < 2) { console.error('Usage: ctx cli add <name> <binary>'); process.exit(1); }
      const [name, binary, ...rest] = args;
      const name2 = await cliMgr.add(name, binary, rest.join(' '));
      console.log(`✓ Added CLI: ${name2}`);
      break;
    }
    case 'check': {
      const results = await cliMgr.check();
      console.log('CLI Installation Check:\n');
      for (const r of results) {
        const status = r.installed ? '✓ installed' : '✗ NOT FOUND';
        console.log(`  ${r.name} (${r.binary}): ${status}`);
      }
      console.log();
      break;
    }
    default:
      console.error(`Unknown cli command: ${cmd}`);
      console.error('Usage: ctx cli <list|run|add|check>');
      process.exit(1);
  }
}

async function printStatus() {
  console.log('═══════════════════════════════════');
  console.log('  ctx — Universal Agent Resource Manager');
  console.log('═══════════════════════════════════\n');

  try {
    const skills = await skillMgr.list();
    console.log(`Skills: ${skills.length} registered`);
  } catch (err) {
    console.log(`Skills: error — ${err.message}`);
  }

  try {
    const mcps = await mcpMgr.list();
    const running = mcps.filter((m) => m.status === 'running').length;
    console.log(`MCPs:   ${mcps.length} registered (${running} running)`);
  } catch (err) {
    console.log(`MCPs:   error — ${err.message}`);
  }

  try {
    const clis = await cliMgr.list();
    const installed = clis.filter((c) => c.installed).length;
    console.log(`CLIs:   ${clis.length} registered (${installed} installed)`);
  } catch (err) {
    console.log(`CLIs:   error — ${err.message}`);
  }

  console.log(`\nConfig: ~/.ctx/`);
}

function printHelp() {
  console.log(`
ctx — Universal Agent Resource Manager

USAGE:
  ctx <command> [options]

COMMANDS:
  setup                          Run once — patches agents, creates dirs, symlinks
  status                         Full overview: skills, MCPs, CLIs

  skill list                     List skills (name + description only)
  skill get <name>               Get full SKILL.md content
  skill add <path>               Register a new skill directory
  skill remove <name>            Remove a skill

  mcp list                       List MCPs with status (running/stopped)
  mcp use <name> <method> [args] Call MCP method (spawns if needed)
  mcp add <name> <command>       Register new MCP server
  mcp kill <name>                Force kill a running MCP (SIGTERM + SIGKILL)
  mcp status                     Show all MCP processes, PIDs, and uptime
  mcp watchdog                   Kill MCPs idle for 2+ minutes (run via cron)

  cli list                       List registered CLI tools
  cli run <tool> [args...]       Execute CLI tool, return structured output
  cli add <name> <binary>        Register new CLI tool
  cli check                      Verify all CLIs are installed

  --mcp                          Start as MCP server (stdio transport)

OPTIONS:
  help, --help                   Show this help message
`);
}
