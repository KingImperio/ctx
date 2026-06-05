# ctx — Universal Agent Resource Manager

A dual-interface tool (MCP server + CLI) that acts as the single gateway between AI agents and their tools. Manages skills, MCPs, and CLIs with zero preloading — tools are discovered on demand.

## Install

```bash
git clone https://github.com/KingImperio/ctx.git ~/ctx
bash ~/ctx/install.sh
```

Termux: same command — installer auto-detects Android and uses `pkg`.

## Quick Start

```bash
ctx setup            # Run once — creates dirs, patches agents, discovers MCPs
ctx suggest "task"   # Find relevant skills/MCPs/CLIs for any task
ctx status           # Full overview
```

## Core Commands

### Suggest (find tools for any task)

```bash
ctx suggest "refactor authentication module"    # Returns relevant skills, MCPs, CLIs
ctx suggest "search the web for AI news"        # Ranked by relevance score
ctx suggest "debug failing tests"               # Max 6 results, threshold 0.08
```

### Skills

```bash
ctx skill list                     # Name + description only
ctx skill get <name>               # Full SKILL.md content
ctx skill add <path>               # Register a skill directory
ctx skill add --file <path>        # Register a SKILL.md file
ctx skill add --content "..."      # Register inline content
ctx skill add --url <url>          # Register from URL
ctx skill remove <name>            # Remove a skill
```

### MCPs

```bash
ctx mcp list                       # List with status (running/stopped)
ctx mcp use <name> <method> [args] # Spawn if needed, call method, auto-cleanup
ctx mcp add <name> <command> [args...] [--env KEY=VAL]  # Register new MCP server
ctx mcp kill <name>                # Force kill a running MCP
ctx mcp status                     # Show processes, PIDs, and uptime
ctx mcp watchdog                   # Kill MCPs idle for 2+ minutes
```

### CLIs

```bash
ctx cli list                       # List registered CLIs
ctx cli run <tool> [args...]        # Execute and return structured output
ctx cli add <name> <binary> [--description "..."]  # Register new CLI tool
ctx cli check                      # Verify all are installed
```

### Discover (auto-absorb from other agents)

```bash
ctx discover                       # Show what's found across all agents
ctx discover --dry-run             # Same, no writes
ctx discover --auto                # Absorb everything automatically
ctx discover --watch               # Watch for new skills, auto-absorb
```

Scans: `~/.claude/skills/`, `~/.openclaude/skills/`, `~/.config/opencode/skills/`, `~/.hermes/skills/`, `~/.cache/opencode/packages/*/skills/`

### Sync (git-based registry sync)

```bash
ctx sync init [remote-url]         # Initialize git sync in ~/.ctx/
ctx sync push                      # Push registries to remote
ctx sync pull                      # Pull from remote
ctx sync status                    # Show sync status
```

### Setup (run once)

```bash
ctx setup                          # Patches all agents, discovers MCPs, generates AGENTS.md
```

Patches: OpenCode config, OpenClaude config, Hermes config, Hermes prompt builder, creates `~/.ctx/AGENTS.md`.

## MCP Server Mode

Run as an MCP server for agent integration:

```bash
ctx --mcp
```

### Available MCP Tools (9)

| Tool | Description |
|------|-------------|
| `ctx_suggest` | Find relevant skills, MCPs, CLIs for a task description |
| `ctx_skill_list` | List all skills with names and descriptions |
| `ctx_skill_get` | Load full SKILL.md content by name |
| `ctx_mcp_use` | Spawn and call an MCP server method |
| `ctx_cli_run` | Execute a registered CLI tool |
| `ctx_discover` | Scan agent configs for new skills/MCPs |
| `ctx_sync` | Sync registries to/from git remote |
| `ctx_hermes` | Manage Hermes prompt builder patch |
| `ctx_status` | System overview (skill/MCP/CLI counts) |

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

## Token Savings

| Agent | Before ctx | After ctx | Saved |
|-------|-----------|-----------|-------|
| OpenCode | ~20,800 | ~4,500 | ~78% |
| Hermes | ~21,700 | ~5,300 | ~76% |
| OpenClaude | ~40,000 | ~18,000 | ~55% |

- Skills accessed on-demand via `ctx_suggest` tool
- Hermes skills catalog patched out (saves ~4K tokens)
- AGENTS.md generated (~213 tokens, replaces full catalog)

## Architecture

### PID Tracking
MCP process state in `~/.ctx/mcps/running.json`. Dead PIDs auto-detected, watchdog kills idle MCPs after 2 minutes.

### MCP Protocol Handshake
`ctx mcp use` sends proper `initialize` → `notifications/initialized` → `tools/call` sequence.

### Suggest Engine
Pure keyword scoring: `score = matches / sqrt(descWords + nameWords)`. No external deps, no AI model. Threshold 0.08, fallback top 2.

### Discovery Engine
Scans 6 agent config locations for SKILL.md files and MCP registrations. Deduplicates by name, compares content hashes.

### Hermes Patch
Patches `build_skills_system_prompt()` to return `""` — saves ~4K tokens per Hermes session.

## File Structure

```
~/.ctx/
├── skills/              # Agent skill files (372+)
├── mcps/
│   ├── registry.json    # Registered MCP servers (13)
│   └── running.json     # PID tracking (auto-managed)
├── clis/
│   └── registry.json    # Registered CLI tools (7)
├── AGENTS.md            # Auto-generated agent instructions (~213 tokens)
└── .git/                # Git sync (optional)
```

## Android / Termux

Works on Termux with no native dependencies. Desktop-only MCPs (Playwright, etc.) fail gracefully. Skills, CLIs, and suggest work fully.

## Known Issues

All HIGH and MEDIUM issues fixed as of 2026-06-05.

**Remaining LOW:**
- **setup.js:27** — patchOpenCodeWithRegistry brace-counting fragile. Brace-counting to find JSON closing brace is thrown off by braces inside string values. Fix: use a proper JSONC parser.
- **openclaude-patch.js:49** — Fragile ownership check. `content.includes('ctx_suggest')` to check if CLAUDE.md is "ours". Another tool referencing ctx_suggest would cause this to incorrectly skip removal.
