#!/usr/bin/env node
import { execSync } from 'child_process';
import { readFile, writeFile, copyFile, access } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

function findPromptBuilder() {
  try {
    const result = execSync('find ~ -path "*/hermes*/prompt_builder.py" 2>/dev/null | head -1', {
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
    return result || null;
  } catch {
    return null;
  }
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
  // Look for the function definition and check if it has a docstring
  for (let i = startLine; i < Math.min(startLine + 5, lines.length); i++) {
    if (lines[i].includes('"""') || lines[i].includes("'''")) {
      const quote = lines[i].includes('"""') ? '"""' : "'''";
      // Single-line docstring
      const count = (lines[i].match(new RegExp(quote, 'g')) || []).length;
      if (count >= 2) return i + 1; // single-line docstring
      // Multi-line docstring — find closing
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].includes(quote)) return j + 1;
      }
    }
    // If we hit a non-empty, non-comment line before finding docstring, there's no docstring
    const trimmed = lines[i].trim();
    if (trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('def ') && !trimmed.startsWith(')') && !trimmed.startsWith('->')) {
      return i;
    }
  }
  return startLine + 1;
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
