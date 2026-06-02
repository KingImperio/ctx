#!/usr/bin/env node
import { readdir, readFile, writeFile, mkdir, rename, unlink, rm, stat, symlink } from 'fs/promises';
import { join, basename } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { tmpdir } from 'os';

// Extract description from SKILL.md content
function extractSkillDescription(content) {
  if (!content) return '(no description)';
  const fmMatch = content.match(/^---\s*\n[\s\S]*?description:\s*(.+?)\n[\s\S]*?---/);
  if (fmMatch) return fmMatch[1].trim().slice(0, 120);
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---')) continue;
    return trimmed.slice(0, 120);
  }
  return '(no description)';
}

// Extract name from SKILL.md content or filename
function extractSkillName(content, fallback) {
  if (!content) return fallback;
  const nameMatch = content.match(/^---\s*\n[\s\S]*?name:\s*(.+?)\n/);
  if (nameMatch) return nameMatch[1].trim();
  return fallback;
}

const CTX_DIR = join(homedir(), '.ctx');
const SKILLS_DIR = join(CTX_DIR, 'skills');

export class SkillManager {
  constructor() {
    this.skillsDir = SKILLS_DIR;
  }

  async ensureDir() {
    await mkdir(this.skillsDir, { recursive: true });
  }

  async list() {
    await this.ensureDir();
    const entries = await readdir(this.skillsDir, { withFileTypes: true });
    const skills = [];

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skillMd = join(this.skillsDir, entry.name, 'SKILL.md');
      if (!existsSync(skillMd)) continue;

      try {
        const content = await readFile(skillMd, 'utf-8');
        const desc = this.extractDescription(content);
        skills.push({ name: entry.name, description: desc });
      } catch {
        skills.push({ name: entry.name, description: '(unreadable)' });
      }
    }

    return skills;
  }

  async get(name) {
    const skillMd = join(this.skillsDir, name, 'SKILL.md');
    if (!existsSync(skillMd)) {
      throw new Error(`Skill '${name}' not found`);
    }
    return await readFile(skillMd, 'utf-8');
  }

  async add(sourcePath, { file, content, url } = {}) {
    await this.ensureDir();

    let skillContent = '';
    let name = '';

    if (url) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);
      skillContent = await response.text();
      const urlPath = new URL(url).pathname;
      const parts = urlPath.split('/').filter(Boolean);
      name = extractSkillName(skillContent, parts[parts.length - 1]?.replace(/\.md$/, '') || 'skill');
    } else if (file) {
      skillContent = await readFile(file, 'utf-8');
      name = extractSkillName(skillContent, basename(file, '.md'));
    } else if (content) {
      skillContent = content;
      name = extractSkillName(skillContent, 'skill');
    } else if (sourcePath) {
      name = basename(sourcePath);
      const target = join(this.skillsDir, name);
      if (existsSync(target)) throw new Error(`Skill '${name}' already exists`);
      const srcStat = await stat(sourcePath);
      if (!srcStat.isDirectory()) throw new Error(`Source must be a directory containing SKILL.md`);
      const skillMd = join(sourcePath, 'SKILL.md');
      if (!existsSync(skillMd)) throw new Error(`Source directory must contain SKILL.md`);
      await symlink(sourcePath, target, 'dir');
      return name;
    } else {
      throw new Error('Provide source path, --file, --content, or --url');
    }

    if (!name || name === 'SKILL') {
      throw new Error('Could not determine skill name. Ensure content has a "name:" field in frontmatter.');
    }

    const target = join(this.skillsDir, name);
    if (existsSync(target)) throw new Error(`Skill '${name}' already exists`);

    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'SKILL.md'), skillContent);
    return name;
  }

  async remove(name) {
    const target = join(this.skillsDir, name);
    if (!existsSync(target)) {
      throw new Error(`Skill '${name}' not found`);
    }
    const st = await stat(target);
    if (st.isDirectory()) {
      await rm(target, { recursive: true, force: true });
    } else {
      await unlink(target);
    }
    return name;
  }

  extractDescription(content) {
    // Try frontmatter description first
    const fmMatch = content.match(/^---\s*\n[\s\S]*?description:\s*(.+?)\n[\s\S]*?---/);
    if (fmMatch) return fmMatch[1].trim();

    // Try first non-heading, non-empty line
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---')) continue;
      return trimmed.slice(0, 120);
    }
    return '(no description)';
  }
}
