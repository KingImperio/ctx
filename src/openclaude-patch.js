#!/usr/bin/env node
import { writeFile, readFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const HOME = homedir();
const CLAUDE_MD = join(HOME, 'CLAUDE.md');
const CTX_AGENTS_MD = join(HOME, '.ctx', 'AGENTS.md');

const CONTENT = `# CLAUDE.md — ctx Integration

This project uses ctx (Universal Agent Resource Manager).

Before every task, use the ctx tools to find relevant skills, MCPs, and CLIs:
- \`ctx_suggest\`: find relevant tools for a task
- \`ctx_skill_get\`: load a specific skill by name
- \`ctx_mcp_use\`: spawn and call an MCP
- \`ctx_cli_run\`: run a CLI tool
- \`ctx_discover\`: scan for new skills/MCPs
- \`ctx_sync\`: sync registries to/from git remote

Always use ctx tools instead of direct filesystem access or shell commands.
See ~/.ctx/AGENTS.md for full details.
`;

export async function patchOpenClaude() {
  if (existsSync(CLAUDE_MD)) {
    return { patched: false, message: 'CLAUDE.md already exists' };
  }

  await writeFile(CLAUDE_MD, CONTENT);
  return { patched: true, message: `Created ${CLAUDE_MD}` };
}

export async function unpatchOpenClaude() {
  if (!existsSync(CLAUDE_MD)) {
    return { restored: false, message: 'No CLAUDE.md found' };
  }

  // Only remove if it's our content
  const content = await readFile(CLAUDE_MD, 'utf-8');
  if (!content.includes('ctx_suggest')) {
    return { restored: false, message: 'CLAUDE.md exists but is not ours — not removing' };
  }

  await unlink(CLAUDE_MD);
  return { restored: true, message: `Removed ${CLAUDE_MD}` };
}
