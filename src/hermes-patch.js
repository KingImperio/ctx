#!/usr/bin/env node
import { execSync } from 'child_process';
import { readFile, writeFile, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

function findPromptBuilder() {
  const knownPaths = [
    join(homedir(), '.hermes', 'prompt_builder.py'),
    join(homedir(), '.local', 'lib', 'hermes', 'prompt_builder.py'),
  ];
  for (const p of knownPaths) {
    try {
      if (existsSync(p)) return p;
    } catch {}
  }
  return null;
}

function findFunctionLine(content, funcName) {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(`def ${funcName}(`)) return i;
  }
  return -1;
}

function findDocstringEnd(content, startLine) {
  const lines = content.split('\n');
  // First find the end of the function signature (the line with `):` or `-> str:`)
  let sigEnd = startLine;
  for (let i = startLine; i < Math.min(startLine + 10, lines.length); i++) {
    if (lines[i].match(/\):?\s*->/)) { sigEnd = i; break; }
    if (lines[i].match(/^\s+\):?\s*$/)) { sigEnd = i; break; }
  }
  // Now search for docstring starting from after the signature
  for (let i = sigEnd + 1; i < Math.min(sigEnd + 5, lines.length); i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
      const quote = trimmed.startsWith('"""') ? '"""' : "'''";
      // Single-line docstring (opens and closes on same line)
      const afterOpen = trimmed.slice(trimmed.indexOf(quote) + 3);
      if (afterOpen.includes(quote)) return i + 1;
      // Multi-line docstring — find closing
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].includes(quote)) return j + 1;
      }
    }
    // If we hit a non-empty, non-comment, non-blank line before finding docstring, there's no docstring
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith(')')) {
      return i;
    }
  }
  return sigEnd + 2; // fallback: after signature + blank line
}

export async function patchHermes() {
  const filePath = findPromptBuilder();
  if (!filePath) {
    return { patched: false, message: 'Hermes prompt_builder.py not found' };
  }

  const content = await readFile(filePath, 'utf-8');
  const backupPath = filePath + '.ctx-backup';

  // Check if already patched
  const funcLine = findFunctionLine(content, 'build_skills_system_prompt');
  if (funcLine === -1) {
    return { patched: false, message: 'build_skills_system_prompt function not found' };
  }

  const lines = content.split('\n');

  // Check if already has return "" as first statement after docstring
  const docEnd = findDocstringEnd(content, funcLine);
  const firstStatement = lines[docEnd]?.trim();
  if (firstStatement === 'return ""') {
    return { patched: false, message: 'Already patched' };
  }

  // Create backup if not exists
  if (!existsSync(backupPath)) {
    await copyFile(filePath, backupPath);
  }

  // Insert return "" after docstring
  lines.splice(docEnd, 0, '    return ""');

  await writeFile(filePath, lines.join('\n'));

  return { patched: true, message: `Patched ${filePath}`, backupPath };
}

export async function unpatchHermes() {
  const filePath = findPromptBuilder();
  if (!filePath) {
    return { restored: false, message: 'Hermes prompt_builder.py not found' };
  }

  const backupPath = filePath + '.ctx-backup';
  if (!existsSync(backupPath)) {
    return { restored: false, message: 'No backup found at ' + backupPath };
  }

  await copyFile(backupPath, filePath);

  return { restored: true, message: `Restored from ${backupPath}` };
}

export async function isHermesPatched() {
  const filePath = findPromptBuilder();
  if (!filePath) return { patched: false, message: 'Hermes not found' };

  const content = await readFile(filePath, 'utf-8');
  const funcLine = findFunctionLine(content, 'build_skills_system_prompt');
  if (funcLine === -1) return { patched: false, message: 'Function not found' };

  const lines = content.split('\n');
  const docEnd = findDocstringEnd(content, funcLine);
  const firstStatement = lines[docEnd]?.trim();

  return {
    patched: firstStatement === 'return ""',
    message: firstStatement === 'return ""' ? 'Patched' : 'Not patched',
  };
}
