# ctx — Universal Agent Resource Manager

A dual-interface tool (MCP server + CLI) that acts as the single gateway between AI agents and their tools.

## What It Does

ctx manages three resource pools:

- **Skills** — Agent skill files (SKILL.md). Only names/descriptions exposed at startup; full content on demand.
- **MCPs** — MCP server processes. Spawned on first use, PID-tracked via `running.json`, killed after 2 minutes of inactivity via watchdog.
- **CLIs** — Command-line tools. Validated, executed, structured output returned.

No preloading. Zero memory overhead until you actually use something.

## Install

```bash
# Clone to ~/ctx
git clone <repo> ~/ctx

# Run installer
bash ~/ctx/install.sh
```

Or manually:
```bash
cd ~/ctx
bun install          # or npm install
chmod +x install.sh
./install.sh
```

## Quick Start

```bash
ctx setup            # Run once — creates dirs, symlinks, patches agents
ctx status           # See what you have
ctx skill list       # List available skills
ctx mcp list         # List MCP servers
ctx cli list         # List CLI tools
```

## CLI Commands

### Skills

```bash
ctx skill list                     # Name + description only
ctx skill get <name>               # Full SKILL.md content
ctx skill add <path>               # Register a skill directory
ctx skill remove <name>            # Remove a skill
```

### MCPs

```bash
ctx mcp list                       # List with status (running/stopped)
ctx mcp use <name> <method> [args] # Spawn if needed, call method, auto-cleanup
ctx mcp add <name> <command>       # Register new MCP server
ctx mcp kill <name>                # Force kill a running MCP (SIGTERM + SIGKILL)
ctx mcp status                     # Show processes, PIDs, and uptime
ctx mcp watchdog                   # Kill MCPs idle for 2+ minutes (run via cron)
```

### CLIs

```bash
ctx cli list                       # List registered CLIs
ctx cli run <tool> [args...]        # Execute and return structured output
ctx cli add <name> <binary>        # Register new CLI tool
ctx cli check                      # Verify all are installed
```

### System

```bash
ctx setup                          # Run once — patches all agents
ctx status                         # Full overview
```

## MCP Server Mode

Run as an MCP server for agent integration:

```bash
ctx --mcp
```

This exposes five tools to agents:
- `ctx_skill_list` — compact skill index
- `ctx_skill_get` — full skill content by name
- `ctx_mcp_use` — spawn and call MCP servers
- `ctx_cli_run` — execute CLI tools
- `ctx_status` — system overview

### Agent Config

Add to your agent's MCP config:

```json
{
  "ctx": {
    "command": "ctx",
    "args": ["--mcp"]
  }
}
```

## Architecture

### PID File Tracking

MCP process state persists across CLI invocations via `~/.ctx/mcps/running.json`:

```json
{
  "github": {
    "pid": 12345,
    "startedAt": 1780399915928,
    "lastUsed": 1780399915928,
    "command": "node",
    "args": ["server.js"]
  }
}
```

- `ctx mcp use` spawns MCP, writes PID to `running.json`
- `ctx mcp status` reads `running.json`, checks if PIDs are alive via `kill -0`
- Dead PIDs are detected and cleaned automatically

### Inactivity Watchdog

```bash
ctx mcp watchdog    # Check and kill idle MCPs
```

Run via cron every 60 seconds:
```
* * * * * ctx mcp watchdog 2>/dev/null
```

The watchdog:
1. Reads `running.json`
2. Kills any MCP idle for 2+ minutes (SIGTERM, then SIGKILL after 5s)
3. Cleans stale entries (dead PIDs)

### MCP Protocol Handshake

`ctx mcp use` sends the proper MCP `initialize` request before any method call:

```
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05",...}}
→ {"jsonrpc":"2.0","method":"notifications/initialized"}
→ {"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
← {"jsonrpc":"2.0","id":2,"result":{"tools":[...]}}
```

### Known Limitation: MCP Lifecycle

MCP servers are spawned as child processes with piped stdin/stdout. When the CLI exits, the stdin pipe closes (EOF), causing the MCP to exit. This means:

- MCP processes do **not** survive across CLI invocations
- `running.json` persists PID data, but the process is dead on next `ctx mcp status`
- `call()` detects dead PIDs and respawns automatically
- The watchdog cleans stale entries from `running.json`

**Why not keep MCPs alive?** MCP servers read from stdin. Keeping stdin open across process boundaries requires either a daemon process or named pipes with a persistent writer — both add significant complexity for marginal benefit since respawn is fast (<100ms for local MCPs).

## Token Savings

Before ctx, 10 skills were auto-loaded into agent system prompts (~60-70K tokens). After ctx:

- Skills accessed on-demand via `ctx_skill_get` tool
- No skill catalog in system prompt
- Estimated savings: **~60K tokens per session** for OpenCode

## Adding Skills

```bash
# From a directory containing SKILL.md
ctx skill add /path/to/my-skill

# Skills are stored in ~/.ctx/skills/
# Remove with:
ctx skill remove my-skill
```

## Adding MCPs

```bash
ctx mcp add github npx -y @modelcontextprotocol/server-github
ctx mcp add context7 npx -y @upstash/context7-mcp@latest
ctx mcp add playwright npx -y @anthropic-ai/mcp-playwright
```

## Adding CLIs

```bash
ctx cli add gh gh "GitHub CLI"
ctx cli add rg rg "ripgrep fast search"
ctx cli add fd fd "fd-find file finder"
```

## Android / Termux

ctx works on Termux with no native dependencies:

```bash
# Install bun or node in Termux
pkg install nodejs    # or install bun

# Clone and install
git clone <repo> ~/ctx
bash ~/ctx/install.sh
```

MCPs requiring desktop features (Playwright, etc.) will fail gracefully with a platform error. Skills and CLIs work fully.

## File Structure

```
~/.ctx/
├── skills/              # Agent skill files
├── mcps/
│   ├── registry.json    # Registered MCP servers
│   └── running.json     # PID tracking (auto-managed)
├── clis/
│   └── registry.json    # Registered CLI tools
└── AGENTS.md            # Instructions for agents
```

## License

MIT
