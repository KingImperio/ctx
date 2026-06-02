#!/usr/bin/env node
import { mkdir, readdir, rename, symlink, unlink, writeFile, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';

const HOME = homedir();
const CTX_DIR = join(HOME, '.ctx');
const SKILLS_DIR = join(CTX_DIR, 'skills');
const MCPS_DIR = join(CTX_DIR, 'mcps');
const CLIS_DIR = join(CTX_DIR, 'clis');
const CLAUDE_SKILLS = join(HOME, '.claude', 'skills');

export async function runSetup() {
  const results = [];

  // 1. Create directories
  for (const dir of [SKILLS_DIR, MCPS_DIR, CLIS_DIR]) {
    await mkdir(dir, { recursive: true });
    results.push(`✓ Created ${dir}`);
  }

  // 2. Migrate any existing skills from ~/.claude/skills/ into ~/.ctx/skills/
  //    then REMOVE the directory — agents must NOT discover skills via filesystem
  const openclaudeSkills = join(HOME, '.openclaude', 'skills');
  for (const dir of [CLAUDE_SKILLS, openclaudeSkills]) {
    if (existsSync(dir)) {
      try {
        const st = await (await import('fs/promises')).lstat(dir);
        if (st.isSymbolicLink()) {
          await unlink(dir);
          results.push(`✓ Removed symlink ${dir} — skills must go through ctx`);
        } else if (st.isDirectory()) {
          const entries = await readdir(dir);
          for (const entry of entries) {
            const src = join(dir, entry);
            const dst = join(SKILLS_DIR, entry);
            if (!existsSync(dst)) {
              try { await rename(src, dst); } catch {}
            }
          }
          await (await import('fs/promises')).rm(dir, { recursive: true, force: true });
          results.push(`✓ Migrated skills from ${dir} and removed directory`);
        }
      } catch (err) {
        results.push(`⚠ Could not process ${dir}: ${err.message}`);
      }
    }
  }

  // 3. Populate default CLI registry
  const defaultClis = {
    gh: { name: 'gh', description: 'GitHub CLI', binary: 'gh', defaultArgs: [] },
    git: { name: 'git', description: 'Git version control', binary: 'git', defaultArgs: [] },
    fzf: { name: 'fzf', description: 'Fuzzy finder', binary: 'fzf', defaultArgs: [] },
    jq: { name: 'jq', description: 'JSON processor', binary: 'jq', defaultArgs: [] },
    rg: { name: 'rg', description: 'ripgrep fast search', binary: 'rg', defaultArgs: [] },
    fd: { name: 'fd', description: 'fd-find fast file finder', binary: 'fd', defaultArgs: [] },
    bat: { name: 'bat', description: 'bat cat replacement', binary: 'bat', defaultArgs: [] },
  };
  const cliRegistry = join(CLIS_DIR, 'registry.json');
  if (!existsSync(cliRegistry)) {
    await writeFile(cliRegistry, JSON.stringify(defaultClis, null, 2));
    results.push('✓ Populated default CLI registry (gh, git, fzf, jq, rg, fd, bat)');
  }

  // 4. Populate default MCP registry
  const defaultMcps = {
    github: {
      name: 'github',
      description: 'GitHub MCP server (requires gh CLI)',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: {},
    },
    context7: {
      name: 'context7',
      description: 'Context7 documentation MCP',
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@latest'],
      env: {},
    },
    playwright: {
      name: 'playwright',
      description: 'Playwright browser automation MCP',
      command: 'npx',
      args: ['-y', '@anthropic-ai/mcp-playwright'],
      env: {},
    },
  };
  const mcpRegistry = join(MCPS_DIR, 'registry.json');
  if (!existsSync(mcpRegistry)) {
    await writeFile(mcpRegistry, JSON.stringify(defaultMcps, null, 2));
    results.push('✓ Populated default MCP registry (github, context7, playwright)');
  }

  // 5. Patch OpenCode
  const opencodeConfig = join(HOME, '.config', 'opencode', 'opencode.jsonc');
  if (existsSync(opencodeConfig)) {
    try {
      let content = await readFile(opencodeConfig, 'utf-8');
      if (!content.includes('"ctx"')) {
        // OpenCode uses "mcp" key with nested objects
        // Use brace-counting to find the correct closing brace of the mcp block
        const mcpStart = content.indexOf('"mcp"');
        if (mcpStart !== -1) {
          const openBrace = content.indexOf('{', mcpStart);
          if (openBrace !== -1) {
            let depth = 0;
            let closeBrace = -1;
            for (let i = openBrace; i < content.length; i++) {
              if (content[i] === '{') depth++;
              if (content[i] === '}') {
                depth--;
                if (depth === 0) { closeBrace = i; break; }
              }
            }
            if (closeBrace !== -1) {
              // Insert ctx entry before the closing brace
              const before = content.slice(0, closeBrace);
              const after = content.slice(closeBrace);
              // Ensure trailing comma on previous entry
              const trimmed = before.trimEnd();
              const needsComma = !trimmed.endsWith(',');
              const insert = needsComma ? `,\n    "ctx": {\n      "type": "local",\n      "command": [\n        "ctx",\n        "--mcp"\n      ],\n      "enabled": true\n    }\n` : `\n    "ctx": {\n      "type": "local",\n      "command": [\n        "ctx",\n        "--mcp"\n      ],\n      "enabled": true\n    }\n`;
              content = before + insert + after;
              await writeFile(opencodeConfig, content);
              results.push('✓ Patched OpenCode config — added ctx MCP server');
            } else {
              results.push('⚠ Could not find closing brace of mcp block');
            }
          } else {
            results.push('⚠ Could not find opening brace of mcp block');
          }
        } else {
          results.push('⚠ Could not find mcp block in OpenCode config');
        }
      } else {
        results.push('→ OpenCode already has ctx configured');
      }
    } catch (err) {
      results.push(`⚠ Could not patch OpenCode: ${err.message}`);
    }
  } else {
    results.push('→ OpenCode not found, skipping');
  }

  // 6. Patch OpenClaude
  const openclaudeConfig = join(HOME, '.openclaude', 'settings.json');
  if (existsSync(openclaudeConfig)) {
    try {
      let content = await readFile(openclaudeConfig, 'utf-8');
      const config = JSON.parse(content);
      if (!config.mcpServers?.ctx) {
        config.mcpServers = config.mcpServers || {};
        config.mcpServers.ctx = {
          command: 'ctx',
          args: ['--mcp'],
          env: {},
        };
        await writeFile(openclaudeConfig, JSON.stringify(config, null, 2));
        results.push('✓ Patched OpenClaude config — added ctx MCP server');
      } else {
        results.push('→ OpenClaude already has ctx configured');
      }
    } catch (err) {
      results.push(`⚠ Could not patch OpenClaude: ${err.message}`);
    }
  } else {
    results.push('→ OpenClaude not found, skipping');
  }

  // 7. Patch Hermes
  const hermesConfig = join(HOME, '.hermes', 'config.yaml');
  if (existsSync(hermesConfig)) {
    try {
      let content = await readFile(hermesConfig, 'utf-8');
      if (!content.includes('"ctx"') && !content.match(/^  ctx:/m)) {
        // Find the mcp_servers block and add ctx as a proper mapping entry
        // mcp_servers is a YAML mapping, not a list — each entry is "name:\n  command: ..."
        const lines = content.split('\n');
        let inMcpServers = false;
        let mcpIndent = 0;
        let insertLine = -1;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line.match(/^mcp_servers:/)) {
            inMcpServers = true;
            mcpIndent = 0;
            continue;
          }
          if (inMcpServers) {
            // Check if we've left the mcp_servers block (same or lesser indent, non-empty)
            const match = line.match(/^(\s*)\S/);
            if (match && match[1].length <= mcpIndent && !line.match(/^\s*$/)) {
              // We've exited the block — insert before this line
              insertLine = i;
              break;
            }
            // Track the last line of the block
            if (line.trim() !== '') {
              insertLine = i + 1;
            }
          }
        }

        if (insertLine === -1) {
          // mcp_servers is empty or at end — append after it
          const idx = lines.findIndex((l) => l.match(/^mcp_servers:/));
          if (idx !== -1) {
            lines.splice(idx + 1, 0,
              '  ctx:',
              '    command: ctx',
              '    args:',
              '    - --mcp',
              '    enabled: true'
            );
            content = lines.join('\n');
          }
        } else {
          lines.splice(insertLine, 0,
            '  ctx:',
            '    command: ctx',
            '    args:',
            '    - --mcp',
            '    enabled: true'
          );
          content = lines.join('\n');
        }
        await writeFile(hermesConfig, content);
        results.push('✓ Patched Hermes config — added ctx MCP server');
      } else {
        results.push('→ Hermes already has ctx configured');
      }
    } catch (err) {
      results.push(`⚠ Could not patch Hermes: ${err.message}`);
    }
  } else {
    results.push('→ Hermes not found, skipping');
  }

  // 8. Create AGENTS.md
  const agentsMd = `# ctx — Universal Agent Resource Manager

You have access to the ctx tool for managing skills, MCPs, and CLIs.

## Skills
- Call \`ctx_skill_list\` first to see available skills (name + description only)
- Call \`ctx_skill_get\` with a skill name to get full SKILL.md content
- Never load skills directly from disk — always go through ctx

## MCPs
- Call \`ctx_mcp_use\` to spawn and use an MCP server
- ctx handles spawning, lifecycle, and cleanup automatically
- MCPs are killed after 2 minutes of inactivity
- Never start MCP processes directly — always go through ctx

## CLIs
- Call \`ctx_cli_run\` to execute registered CLI tools
- Returns structured output (stdout, stderr, exitCode)
- Never shell out to CLIs directly — always go through ctx

## Status
- Call \`ctx_status\` to see full system overview
`;
  await writeFile(join(CTX_DIR, 'AGENTS.md'), agentsMd);
  results.push('✓ Created ~/.ctx/AGENTS.md');

  return results;
}
