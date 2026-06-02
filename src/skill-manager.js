#!/usr/bin/env node
import { readdir, readFile, writeFile, mkdir, rename, unlink, stat, symlink } from 'fs/promises';
import { join, basename } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { tmpdir } from 'os';

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

  async add(sourcePath) {
    await this.ensureDir();
    const name = basename(sourcePath);
    const target = join(this.skillsDir, name);

    if (existsSync(target)) {
      throw new Error(`Skill '${name}' already exists`);
    }

    const srcStat = await stat(sourcePath);
    if (!srcStat.isDirectory()) {
      throw new Error(`Source must be a directory containing SKILL.md`);
    }

    const skillMd = join(sourcePath, 'SKILL.md');
    if (!existsSync(skillMd)) {
      throw new Error(`Source directory must contain SKILL.md`);
    }

    // Atomic: write a temp marker, then symlink
    await symlink(sourcePath, target);
    return name;
  }

  async remove(name) {
    const target = join(this.skillsDir, name);
    if (!existsSync(target)) {
      throw new Error(`Skill '${name}' not found`);
    }
    await unlink(target);
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
