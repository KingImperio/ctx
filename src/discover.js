#!/usr/bin/env node
import { readdir, readFile, writeFile, mkdir, copyFile, stat, access } from 'fs/promises';
import { join, basename, relative } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { SkillManager } from './skill-manager.js';
import { MCPManager } from './mcp-manager.js';

const HOME = homedir();
const CTX_DIR = join(HOME, '.ctx');
const SKILLS_DIR = join(CTX_DIR, 'skills');
const MCPS_DIR = join(CTX_DIR, 'mcps');

const SKILL_SOURCES = [
  join(HOME, '.claude', 'skills'),
  join(HOME, '.openclaude', 'skills'),
  join(HOME, '.config', 'opencode', 'skills'),
  join(HOME, '.hermes', 'skills'),
  join(HOME, '.cache', 'opencode', 'packages'),
  join(HOME, 'ctx', 'skills'),
];

// --- Helpers ---

function contentHash(text) {
  return createHash('md5').update(text).digest('hex').slice(0, 12);
}

async function fileExists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function safeReadFile(path) {
  try { return await readFile(path, 'utf-8'); } catch { return null; }
}

async function safeStat(path) {
  try { return await stat(path); } catch { return null; }
}

// Simple JSONC parser — strip comments and trailing commas
function parseJSONC(text) {
  // Strip single-line comments (not inside strings)
  let result = '';
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { result += ch; escape = false; continue; }
    if (ch === '\\' && inString) { result += ch; escape = true; continue; }
    if (ch === '"') { inString = !inString; result += ch; continue; }
    if (!inString && ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      result += '\n';
      continue;
    }
    result += ch;
  }
  // Strip trailing commas before } or ]
  result = result.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(result);
}

// Targeted YAML parser for mcp_servers block only
function parseHermesMCPServers(text) {
  const servers = {};
  const lines = text.split('\n');
  let inMcp = false;
  let currentName = null;
  let currentBlock = [];

  for (const line of lines) {
    const isMcpStart = /^mcp_servers:\s*$/.test(line);
    if (isMcpStart) { inMcp = true; continue; }

    if (inMcp) {
      // Exit if we hit a top-level key (no indent or different section)
      if (line.match(/^[a-z_]+:/) && !line.startsWith(' ')) {
        // Flush last block
        if (currentName) parseYAMLBlock(currentName, currentBlock, servers);
        break;
      }

      // New server entry: "  name:" (2-space indent, no deeper)
      const nameMatch = line.match(/^  (\S[^:]*):\s*$/);
      if (nameMatch) {
        if (currentName) parseYAMLBlock(currentName, currentBlock, servers);
        currentName = nameMatch[1];
        currentBlock = [];
        continue;
      }

      if (currentName) currentBlock.push(line);
    }
  }

  // Flush last block
  if (currentName) parseYAMLBlock(currentName, currentBlock, servers);

  return servers;
}

function parseYAMLBlock(name, lines, servers) {
  let command = '';
  let args = [];
  let env = {};
  let enabled = true;

  let section = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed === 'command:' || trimmed.startsWith('command: ')) {
      const val = trimmed.slice('command:'.length).trim();
      if (val) command = val.replace(/^["']|["']$/g, '');
      section = 'command';
      continue;
    }
    if (trimmed === 'args:') { section = 'args'; continue; }
    if (trimmed === 'env:') { section = 'env'; continue; }
    if (trimmed.startsWith('enabled:')) {
      enabled = trimmed.slice('enabled:'.length).trim() !== 'false';
      section = null;
      continue;
    }

    if (section === 'args' && trimmed.startsWith('- ')) {
      args.push(trimmed.slice(2).replace(/^["']|["']$/g, ''));
    }
    if (section === 'env' && trimmed.includes(':')) {
      const [key, ...rest] = trimmed.split(':');
      env[key.trim()] = rest.join(':').trim().replace(/^["']|["']$/g, '');
    }
  }

  if (command) {
    servers[name] = { name, command, args, env, enabled, source: 'hermes' };
  }
}

// Extract description from SKILL.md content
function extractSkillDescription(content) {
  if (!content) return '(no description)';
  // Try frontmatter
  const fmMatch = content.match(/^---\s*\n[\s\S]*?description:\s*(.+?)\n[\s\S]*?---/);
  if (fmMatch) return fmMatch[1].trim().slice(0, 120);
  // Try first non-heading, non-empty line
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---')) continue;
    return trimmed.slice(0, 120);
  }
  return '(no description)';
}

// Extract name from SKILL.md content or filename
function extractSkillName(content, filename) {
  if (!content) return basename(filename, '.md');
  const nameMatch = content.match(/^---\s*\n[\s\S]*?name:\s*(.+?)\n/);
  if (nameMatch) return nameMatch[1].trim();
  return basename(filename, '.md');
}

// --- Discovery Functions ---

export async function discoverSkills() {
  const results = [];
  const ctxSkills = new Set();

  // Load existing ctx skills for dedup
  if (existsSync(SKILLS_DIR)) {
    try {
      const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() || e.isSymbolicLink()) ctxSkills.add(e.name);
      }
    } catch {}
  }

  // Helper to scan a directory for SKILL.md files
  async function scanDir(dir, source, recursive = false) {
    if (!await fileExists(dir)) return;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory() && recursive) {
          await scanDir(fullPath, source, true);
          continue;
        }
        if (entry.name === 'SKILL.md' || entry.name.endsWith('.md')) {
          const content = await safeReadFile(fullPath);
          if (!content) continue;
          const name = extractSkillName(content, entry.name);
          const desc = extractSkillDescription(content);
          const hash = contentHash(content);
          results.push({
            name,
            description: desc,
            contentHash: hash,
            existsInCtx: ctxSkills.has(name),
            source,
            path: fullPath,
          });
        }
      }
    } catch {}
  }

  // 1. ~/.claude/skills/
  await scanDir(join(HOME, '.claude', 'skills'), 'claude');

  // 2. ~/.openclaude/skills/
  await scanDir(join(HOME, '.openclaude', 'skills'), 'openclaude');

  // 3. ~/.config/opencode/skills/
  await scanDir(join(HOME, '.config', 'opencode', 'skills'), 'opencode');

  // 4. ~/.hermes/skills/ (recursive)
  await scanDir(join(HOME, '.hermes', 'skills'), 'hermes', true);

  // 5. ~/.cache/opencode/packages/*/skills/ and plugin .opencode/skills/
  const packagesDir = join(HOME, '.cache', 'opencode', 'packages');
  if (await fileExists(packagesDir)) {
    try {
      const pkgs = await readdir(packagesDir, { withFileTypes: true });
      for (const pkg of pkgs) {
        if (!pkg.isDirectory()) continue;
        // Check package root for skills
        const pkgSkillsDir = join(packagesDir, pkg.name, 'skills');
        await scanDir(pkgSkillsDir, `plugin:${pkg.name}`);

        // Check nested node_modules for .opencode/skills
        const nmDir = join(packagesDir, pkg.name, 'node_modules');
        if (await fileExists(nmDir)) {
          try {
            const modules = await readdir(nmDir, { withFileTypes: true });
            for (const mod of modules) {
              if (!mod.isDirectory()) continue;
              const omoSkills = join(nmDir, mod.name, '.opencode', 'skills');
              await scanDir(omoSkills, `plugin:${pkg.name}/${mod.name}`);

              // Also check packages/*/plugin/skills/ (oh-my-openagent pattern)
              const pluginSkills = join(nmDir, mod.name, 'packages');
              if (await fileExists(pluginSkills)) {
                try {
                  const subPkgs = await readdir(pluginSkills, { withFileTypes: true });
                  for (const sp of subPkgs) {
                    if (!sp.isDirectory()) continue;
                    const spSkills = join(pluginSkills, sp.name, 'plugin', 'skills');
                    await scanDir(spSkills, `plugin:${pkg.name}/${mod.name}/${sp.name}`);
                  }
                } catch {}
              }
            }
          } catch {}
        }
      }
    } catch {}
  }

  // 6. ~/ctx/skills/ (source of truth — already managed)
  await scanDir(join(HOME, 'ctx', 'skills'), 'ctx-source');

  return results;
}

export async function discoverMCPs() {
  const results = [];

  // Load existing ctx MCPs for dedup
  const ctxMCPs = new Set();
  const ctxRegistry = join(MCPS_DIR, 'registry.json');
  if (existsSync(ctxRegistry)) {
    try {
      const data = JSON.parse(await readFile(ctxRegistry, 'utf-8'));
      for (const name of Object.keys(data)) ctxMCPs.add(name);
    } catch {}
  }

  // 1. OpenCode — JSONC
  const opencodeConfig = join(HOME, '.config', 'opencode', 'opencode.jsonc');
  if (await fileExists(opencodeConfig)) {
    try {
      const raw = await readFile(opencodeConfig, 'utf-8');
      const config = parseJSONC(raw);
      const mcpBlock = config.mcp || {};
      for (const [name, entry] of Object.entries(mcpBlock)) {
        const command = Array.isArray(entry.command) ? entry.command[0] : (entry.command || '');
        const args = Array.isArray(entry.command) ? entry.command.slice(1) : (entry.args || []);
        const env = entry.environment || entry.env || {};
        results.push({
          name,
          command,
          args,
          env,
          description: `${name} MCP (from opencode)`,
          existsInCtx: ctxMCPs.has(name),
          source: 'opencode',
        });
      }
    } catch {}
  }

  // 2. OpenClaude — projects[HOME].mcpServers
  const openclaudeState = join(HOME, '.openclaude.json');
  if (await fileExists(openclaudeState)) {
    try {
      const data = JSON.parse(await readFile(openclaudeState, 'utf-8'));
      const projectMcps = data.projects?.[HOME]?.mcpServers || {};
      for (const [name, entry] of Object.entries(projectMcps)) {
        if (ctxMCPs.has(name)) continue; // dedup against ctx
        results.push({
          name,
          command: entry.command || '',
          args: entry.args || [],
          env: entry.env || {},
          description: `${name} MCP (from openclaude)`,
          existsInCtx: false,
          source: 'openclaude',
        });
      }
    } catch {}
  }

  // 3. Hermes — YAML mcp_servers block
  const hermesConfig = join(HOME, '.hermes', 'config.yaml');
  if (await fileExists(hermesConfig)) {
    try {
      const raw = await readFile(hermesConfig, 'utf-8');
      const servers = parseHermesMCPServers(raw);
      for (const [name, entry] of Object.entries(servers)) {
        if (ctxMCPs.has(name)) continue;
        results.push({
          name,
          command: entry.command,
          args: entry.args,
          env: entry.env,
          description: `${name} MCP (from hermes)`,
          existsInCtx: false,
          source: 'hermes',
        });
      }
    } catch {}
  }

  return results;
}

export async function discoverPlugins() {
  const results = [];
  const ctxSkills = new Set();

  if (existsSync(SKILLS_DIR)) {
    try {
      const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
      for (const e of entries) ctxSkills.add(e.name);
    } catch {}
  }

  // OpenCode plugins from config
  const opencodeConfig = join(HOME, '.config', 'opencode', 'opencode.jsonc');
  if (await fileExists(opencodeConfig)) {
    try {
      const raw = await readFile(opencodeConfig, 'utf-8');
      const config = parseJSONC(raw);
      const plugins = config.plugin || [];
      for (const name of plugins) {
        results.push({ name, source: 'opencode-config', existsInCtx: false });
      }
    } catch {}
  }

  // Installed packages
  const packagesDir = join(HOME, '.cache', 'opencode', 'packages');
  if (await fileExists(packagesDir)) {
    try {
      const pkgs = await readdir(packagesDir, { withFileTypes: true });
      for (const pkg of pkgs) {
        if (!pkg.isDirectory() || pkg.name.startsWith('.')) continue;
        const existing = results.find((p) => pkg.name.startsWith(p.name));
        if (!existing) {
          results.push({ name: pkg.name, source: 'opencode-packages', existsInCtx: false });
        }
      }
    } catch {}
  }

  return results;
}

// --- Core Discovery ---

export async function discover({ auto = false, dryRun = false } = {}) {
  const skillMgr = new SkillManager();
  const mcpMgr = new MCPManager();

  const skills = await discoverSkills();
  const mcps = await discoverMCPs();
  const plugins = await discoverPlugins();

  const newSkills = skills.filter((s) => !s.existsInCtx);
  const existingSkills = skills.filter((s) => s.existsInCtx);
  const newMCPs = mcps.filter((m) => !m.existsInCtx);
  const existingMCPs = mcps.filter((m) => m.existsInCtx);

  const report = {
    skills: skills.map((s) => ({
      name: s.name,
      description: s.description,
      source: s.source,
      existsInCtx: s.existsInCtx,
      contentHash: s.contentHash,
    })),
    mcps: mcps.map((m) => ({
      name: m.name,
      description: m.description,
      source: m.source,
      existsInCtx: m.existsInCtx,
    })),
    plugins: plugins.map((p) => ({
      name: p.name,
      source: p.source,
      existsInCtx: p.existsInCtx,
    })),
    summary: {
      skillsNew: newSkills.length,
      skillsExisting: existingSkills.length,
      mcpsNew: newMCPs.length,
      mcpsExisting: existingMCPs.length,
      pluginsNew: plugins.filter((p) => !p.existsInCtx).length,
      pluginsExisting: plugins.filter((p) => p.existsInCtx).length,
    },
  };

  if (dryRun || !auto) {
    return { report, imported: [] };
  }

  // Auto-import new skills
  const imported = [];
  for (const skill of newSkills) {
    try {
      const targetDir = join(SKILLS_DIR, skill.name);
      if (existsSync(targetDir)) continue;

      // Read the source file
      const content = await safeReadFile(skill.path);
      if (!content) continue;

      // Create skill dir and write SKILL.md
      await mkdir(targetDir, { recursive: true });
      await writeFile(join(targetDir, 'SKILL.md'), content);
      imported.push(skill.name);
    } catch {}
  }

  // Auto-import new MCPs
  const mcpRegistry = join(MCPS_DIR, 'registry.json');
  let existingRegistry = {};
  if (existsSync(mcpRegistry)) {
    try { existingRegistry = JSON.parse(await readFile(mcpRegistry, 'utf-8')); } catch {}
  }

  for (const mcp of newMCPs) {
    if (existingRegistry[mcp.name]) continue;
    existingRegistry[mcp.name] = {
      name: mcp.name,
      description: mcp.description,
      command: mcp.command,
      args: mcp.args,
      env: mcp.env,
    };
    imported.push(`mcp:${mcp.name}`);
  }

  if (imported.length > 0) {
    await writeFile(mcpRegistry, JSON.stringify(existingRegistry, null, 2));
  }

  return { report, imported };
}

export function printDiscovery(result) {
  const { report, imported } = result;

  console.log('═══════════════════════════════════');
  console.log('  ctx discover');
  console.log('═══════════════════════════════════\n');

  console.log(`Found ${report.summary.skillsNew} new skills, ${report.summary.skillsExisting} existing`);
  console.log(`Found ${report.summary.mcpsNew} new MCPs, ${report.summary.mcpsExisting} existing`);
  console.log(`Found ${report.summary.pluginsNew} new plugins, ${report.summary.pluginsExisting} existing\n`);

  if (report.skills.length > 0) {
    console.log('Skills:');
    for (const s of report.skills) {
      const status = s.existsInCtx ? '(exists)' : '(NEW)';
      console.log(`  ${status} ${s.name} — ${s.description.slice(0, 60)} [${s.source}]`);
    }
    console.log();
  }

  if (report.mcps.length > 0) {
    console.log('MCPs:');
    for (const m of report.mcps) {
      const status = m.existsInCtx ? '(exists)' : '(NEW)';
      console.log(`  ${status} ${m.name} — ${m.description} [${m.source}]`);
    }
    console.log();
  }

  if (report.plugins.length > 0) {
    console.log('Plugins:');
    for (const p of report.plugins) {
      const status = p.existsInCtx ? '(exists)' : '(NEW)';
      console.log(`  ${status} ${p.name} [${p.source}]`);
    }
    console.log();
  }

  if (imported && imported.length > 0) {
    console.log(`Absorbed: ${imported.join(', ')}`);
  } else if (report.summary.skillsNew === 0 && report.summary.mcpsNew === 0) {
    console.log('No new items to absorb.');
  }
}

// --- Watch Mode ---

const WATCH_INTERVAL = 3000; // 3 seconds debounce

export async function watchDiscovery() {
  const { watch } = await import('fs');

  console.log('═══════════════════════════════════');
  console.log('  ctx discover --watch');
  console.log('═══════════════════════════════════\n');
  console.log('Watching for new skills across all agent directories...\n');

  const watchedDirs = SKILL_SOURCES.filter((dir) => {
    // For packages dir, we watch the top level
    if (dir.includes('packages')) return existsSync(dir);
    return existsSync(dir);
  });

  const watchers = [];
  let debounceTimer = null;

  function scheduleAbsorb(filename) {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      console.log(`[watch] New skill detected: ${filename}`);
      try {
        const { report, imported } = await discover({ auto: true, dryRun: false });
        if (imported.length > 0) {
          console.log(`[watch] Absorbed: ${imported.join(', ')}`);
        } else {
          console.log(`[watch] No new items to absorb (already exists or not a skill)`);
        }
      } catch (err) {
        console.error(`[watch] Error: ${err.message}`);
      }
    }, WATCH_INTERVAL);
  }

  for (const dir of watchedDirs) {
    try {
      const watcher = watch(dir, { recursive: true }, (eventType, filename) => {
        if (filename && filename.endsWith('SKILL.md')) {
          scheduleAbsorb(filename);
        }
      });
      watchers.push(watcher);
      console.log(`  Watching: ${dir}`);
    } catch (err) {
      console.log(`  Skipped: ${dir} (${err.message})`);
    }
  }

  if (watchers.length === 0) {
    console.log('No directories to watch.');
    return;
  }

  console.log(`\nWatching ${watchers.length} directories. Press Ctrl+C to stop.\n`);

  // Keep alive
  process.on('SIGINT', () => {
    console.log('\nStopping watcher...');
    for (const w of watchers) w.close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    for (const w of watchers) w.close();
    process.exit(0);
  });
}
