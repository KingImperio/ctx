#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { SkillManager } from './skill-manager.js';
import { MCPManager } from './mcp-manager.js';
import { CLIManager } from './cli-manager.js';

const HOME = homedir();
const CTX_DIR = join(HOME, '.ctx');

export async function buildAgentsMD() {
  const skillMgr = new SkillManager();
  const mcpMgr = new MCPManager();
  const cliMgr = new CLIManager();

  const skills = await skillMgr.list();
  const mcps = await mcpMgr.list();
  const clis = await cliMgr.list();

  const runningMCPs = mcps.filter((m) => m.status === 'running').length;
  const installedCLIs = clis.filter((c) => c.installed).length;

  const lines = [
    '# ctx — Tool Access',
    '',
    'You have access to one meta-tool: ctx.',
    '',
    '## Before every task',
    'Call ctx_suggest with the user\'s task description.',
    'ctx will return only the skills, MCPs, and CLIs relevant to this task.',
    'Load ONLY what ctx_suggest returns. Never request the full catalog.',
    '',
    '## Adding capabilities',
    'If you encounter a new skill or MCP the user wants to add:',
    'Call ctx_skill_add or ctx_mcp_add — never edit config files directly.',
    '',
    '## If ctx_suggest returns nothing',
    'Tell the user the capability doesn\'t exist in your toolkit.',
    'Offer to add it via ctx_skill_add.',
    '',
    '## Available ctx tools',
    `- ctx_suggest: find relevant tools for a task`,
    `- ctx_skill_get: load a specific skill by name`,
    `- ctx_mcp_use: spawn and call an MCP`,
    `- ctx_cli_run: run a CLI tool`,
    `- ctx_discover: scan for new skills/MCPs across agents`,
    `- ctx_sync: sync registries to/from git remote`,
    '',
    `## Registry status`,
    `- Skills: ${skills.length} registered`,
    `- MCPs: ${mcps.length} registered (${runningMCPs} running)`,
    `- CLIs: ${clis.length} registered (${installedCLIs} installed)`,
  ];

  return lines.join('\n');
}

export async function writeAgentsMD() {
  const content = await buildAgentsMD();
  const dir = join(HOME, '.ctx');
  await mkdir(dir, { recursive: true });

  const filePath = join(dir, 'AGENTS.md');

  // Check if content changed
  try {
    const existing = await readFile(filePath, 'utf-8');
    if (existing === content) return content;
  } catch {}

  // Atomic write
  const tmpPath = filePath + '.tmp';
  await writeFile(tmpPath, content, 'utf-8');
  const { rename } = await import('fs/promises');
  await rename(tmpPath, filePath);

  return content;
}

export function tokenCount(text) {
  // Rough approximation: 1 token ≈ 4 chars or 0.75 words
  return Math.round(text.split(/\s+/).length * 1.33);
}
