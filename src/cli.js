#!/usr/bin/env node
import { SkillManager } from './skill-manager.js';
import { MCPManager } from './mcp-manager.js';
import { CLIManager } from './cli-manager.js';
import { runSetup } from './setup.js';
import { suggest, printSuggestions } from './suggest.js';
import { discover, printDiscovery, watchDiscovery } from './discover.js';
import { syncInit, syncPush, syncPull, syncStatus, printSyncStatus } from './sync.js';
import { patchHermes, unpatchHermes, isHermesPatched } from './hermes-patch.js';

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

  if (category === 'suggest') {
    const task = [command, ...rest].filter(Boolean).join(' ');
    if (!task) {
      console.error('Usage: ctx suggest "<task description>"');
      process.exit(1);
    }
    const results = await suggest(task);
    printSuggestions(results);
    return;
  }

  if (category === 'discover') {
    if (command === '--watch' || command === 'watch') {
      await watchDiscovery();
      return;
    }
    const auto = rest.includes('--auto') || command === '--auto';
    const dryRun = rest.includes('--dry-run') || command === '--dry-run' || !auto;
    const result = await discover({ auto, dryRun });
    printDiscovery(result);
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
    case 'sync':
      await handleSync(command, rest);
      break;
    case 'hermes':
      await handleHermes(command, rest);
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
      const fileIdx = args.indexOf('--file');
      const contentIdx = args.indexOf('--content');
      const urlIdx = args.indexOf('--url');

      const opts = {};
      if (fileIdx !== -1) opts.file = args[fileIdx + 1];
      if (contentIdx !== -1) opts.content = args[contentIdx + 1];
      if (urlIdx !== -1) opts.url = args[urlIdx + 1];

      const sourcePath = (!opts.file && !opts.content && !opts.url) ? args[0] : undefined;
      const name = await skillMgr.add(sourcePath, opts);
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
      if (args.length < 2) { console.error('Usage: ctx mcp add <name> <command> [args...] [--env KEY=VAL]'); process.exit(1); }
      const [name, command, ...rest] = args;
      // Parse --env flags
      const env = {};
      const cmdArgs = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--env' && rest[i + 1]) {
          const [key, ...valParts] = rest[i + 1].split('=');
          env[key] = valParts.join('=');
          i++;
        } else if (rest[i].startsWith('--env=')) {
          const eqVal = rest[i].slice(6);
          const [key, ...valParts] = eqVal.split('=');
          env[key] = valParts.join('=');
        } else {
          cmdArgs.push(rest[i]);
        }
      }
      const descIdx = args.indexOf('--description');
      const description = descIdx !== -1 ? args[descIdx + 1] : '';
      const name2 = await mcpMgr.add(name, command, cmdArgs, env, description);
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
      if (args.length < 2) { console.error('Usage: ctx cli add <name> <binary> [--description "..."]'); process.exit(1); }
      const [name, binary, ...rest] = args;
      const descIdx = rest.indexOf('--description');
      const description = descIdx !== -1 ? rest[descIdx + 1] : rest.filter((a, i) => i !== descIdx + 1).join(' ');
      const name2 = await cliMgr.add(name, binary, description);
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

async function handleSync(cmd, args) {
  switch (cmd) {
    case 'init': {
      const remoteUrl = args[0] || undefined;
      const result = await syncInit(remoteUrl);
      if (result.exitCode === 0) console.log(`✓ ${result.message}`);
      else console.error(`✗ ${result.message}`);
      break;
    }
    case 'push': {
      const result = await syncPush();
      console.log(result.message);
      break;
    }
    case 'pull': {
      const result = await syncPull();
      if (result.exitCode === 0) console.log(result.stdout || 'Pulled successfully');
      else console.error(result.stderr || 'Pull failed');
      break;
    }
    case 'status': {
      const status = await syncStatus();
      printSyncStatus(status);
      break;
    }
    default:
      console.error(`Unknown sync command: ${cmd}`);
      console.error('Usage: ctx sync <init|push|pull|status>');
      process.exit(1);
  }
}

async function handleHermes(cmd, args) {
  switch (cmd) {
    case 'patch': {
      const result = await patchHermes();
      console.log(result.message);
      break;
    }
    case 'unpatch': {
      const result = await unpatchHermes();
      console.log(result.message);
      break;
    }
    case 'status': {
      const result = await isHermesPatched();
      console.log(`Hermes prompt builder: ${result.message}`);
      break;
    }
    default:
      console.error(`Unknown hermes command: ${cmd}`);
      console.error('Usage: ctx hermes <patch|unpatch|status>');
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
  suggest "<task>"               Find relevant skills, MCPs, and CLIs for a task
  discover [--auto] [--dry-run]  Scan all agent configs for new skills/MCPs
  discover --watch               Watch for new skills and auto-absorb
  sync init [remote-url]         Initialize git sync in ~/.ctx/
  sync push                      Push registries to remote
  sync pull                      Pull registries from remote
  sync status                    Show sync status
  hermes patch                   Patch Hermes to skip skills catalog (~4K tokens saved)
  hermes unpatch                 Restore Hermes prompt builder from backup
  hermes status                  Check if Hermes is patched

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
