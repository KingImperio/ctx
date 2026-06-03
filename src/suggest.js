#!/usr/bin/env node
import { SkillManager } from './skill-manager.js';
import { MCPManager } from './mcp-manager.js';
import { CLIManager } from './cli-manager.js';

const skillMgr = new SkillManager();
const mcpMgr = new MCPManager();
const cliMgr = new CLIManager();

function normalize(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2);
}

function scoreItem(queryWords, nameWords, descWords) {
  const descAndName = [...descWords, ...nameWords];
  const matches = queryWords.filter((qw) => descAndName.some((dw) => {
    // Word boundary match: query word must start or end at a word boundary
    return dw === qw || dw.startsWith(qw) || qw.startsWith(dw);
  }));
  if (matches.length === 0) return 0;
  return matches.length / Math.sqrt(descWords.length + nameWords.length);
}

function splitNameWords(name) {
  return name
    .toLowerCase()
    .split(/[-_]+/)
    .filter((w) => w.length >= 4);
}

export async function suggest(task) {
  const queryWords = normalize(task);
  if (queryWords.length === 0) return { skills: [], mcps: [], clis: [] };

  const results = { skills: [], mcps: [], clis: [] };

  const skills = await skillMgr.list();
  for (const s of skills) {
    const descWords = normalize(s.description);
    const nameWords = splitNameWords(s.name);
    const score = scoreItem(queryWords, nameWords, descWords);
    if (score > 0) results.skills.push({ name: s.name, description: s.description, score: Math.round(score * 100) / 100 });
  }

  const mcps = await mcpMgr.list();
  for (const m of mcps) {
    const descWords = normalize(m.description || m.command);
    const nameWords = splitNameWords(m.name);
    const score = scoreItem(queryWords, nameWords, descWords);
    if (score > 0) results.mcps.push({ name: m.name, description: m.description || m.command, score: Math.round(score * 100) / 100 });
  }

  const clis = await cliMgr.list();
  for (const c of clis) {
    const descWords = normalize(c.description || '');
    const nameWords = splitNameWords(c.name);
    const score = scoreItem(queryWords, nameWords, descWords);
    if (score > 0) results.clis.push({ name: c.name, description: c.description || c.binary, score: Math.round(score * 100) / 100 });
  }

  // Sort each group by score descending
  results.skills.sort((a, b) => b.score - a.score);
  results.mcps.sort((a, b) => b.score - a.score);
  results.clis.sort((a, b) => b.score - a.score);

  // Apply threshold (0.08) and max 6 results total
  const THRESHOLD = 0.08;
  const MAX_RESULTS = 6;

  let qualified = [
    ...results.skills.filter((s) => s.score >= THRESHOLD).map((s) => ({ ...s, type: 'skill' })),
    ...results.mcps.filter((m) => m.score >= THRESHOLD).map((m) => ({ ...m, type: 'mcp' })),
    ...results.clis.filter((c) => c.score >= THRESHOLD).map((c) => ({ ...c, type: 'cli' })),
  ];

  qualified.sort((a, b) => b.score - a.score);
  qualified = qualified.slice(0, MAX_RESULTS);

  // Fallback: if fewer than 2 qualified, take top 2 regardless
  if (qualified.length < 2) {
    const all = [
      ...results.skills.map((s) => ({ ...s, type: 'skill' })),
      ...results.mcps.map((m) => ({ ...m, type: 'mcp' })),
      ...results.clis.map((c) => ({ ...c, type: 'cli' })),
    ];
    all.sort((a, b) => b.score - a.score);
    qualified = all.slice(0, Math.max(2, qualified.length));
  }

  // Rebuild grouped results from qualified
  const output = { skills: [], mcps: [], clis: [] };
  for (const item of qualified) {
    const { type, ...rest } = item;
    output[type + 's'].push(rest);
  }

  return output;
}

export function printSuggestions(results) {
  const hasResults =
    results.skills.length > 0 || results.mcps.length > 0 || results.clis.length > 0;

  if (!hasResults) {
    console.log('No matching tools found for this task');
    return;
  }

  if (results.skills.length > 0) {
    console.log('Skills:');
    for (const s of results.skills) {
      console.log(`  [skill] ${s.name} — ${s.description} (score: ${s.score})`);
    }
  }

  if (results.mcps.length > 0) {
    console.log('MCPs:');
    for (const m of results.mcps) {
      console.log(`  [mcp] ${m.name} — ${m.description} (score: ${m.score})`);
    }
  }

  if (results.clis.length > 0) {
    console.log('CLIs:');
    for (const c of results.clis) {
      console.log(`  [cli] ${c.name} — ${c.description} (score: ${c.score})`);
    }
  }
}
