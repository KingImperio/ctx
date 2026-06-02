#!/usr/bin/env node
import { readFile, writeFile, mkdir, stat } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { spawn } from 'child_process';

const CTX_DIR = join(homedir(), '.ctx');
const CLIS_DIR = join(CTX_DIR, 'clis');
const REGISTRY_FILE = join(CLIS_DIR, 'registry.json');

export class CLIManager {
  constructor() {
    this.registry = new Map();
    this.registryFile = REGISTRY_FILE;
  }

  async loadRegistry() {
    await mkdir(CLIS_DIR, { recursive: true });
    if (!existsSync(this.registryFile)) {
      await this.writeRegistry({});
    }
    const data = JSON.parse(await readFile(this.registryFile, 'utf-8'));
    this.registry.clear();
    for (const [name, entry] of Object.entries(data)) {
      this.registry.set(name, entry);
    }
  }

  async writeRegistry(data) {
    await mkdir(CLIS_DIR, { recursive: true });
    const tmp = this.registryFile + '.tmp';
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await writeFile(this.registryFile, await readFile(tmp));
    try { await (await import('fs/promises')).unlink(tmp); } catch {}
  }

  async saveRegistry() {
    const obj = {};
    for (const [name, entry] of this.registry) {
      obj[name] = entry;
    }
    await this.writeRegistry(obj);
  }

  async list() {
    await this.loadRegistry();
    const result = [];
    for (const [name, entry] of this.registry) {
      const installed = await this.isInstalled(entry.binary);
      result.push({
        name,
        description: entry.description || '',
        binary: entry.binary,
        installed,
      });
    }
    return result;
  }

  async add(name, binary, description = '', defaultArgs = []) {
    await this.loadRegistry();
    if (this.registry.has(name)) {
      throw new Error(`CLI '${name}' already registered`);
    }
    this.registry.set(name, { name, description, binary, defaultArgs });
    await this.saveRegistry();
    return name;
  }

  async remove(name) {
    await this.loadRegistry();
    if (!this.registry.has(name)) {
      throw new Error(`CLI '${name}' not found`);
    }
    this.registry.delete(name);
    await this.saveRegistry();
    return name;
  }

  async isInstalled(binary) {
    try {
      const proc = spawn('which', [binary], { stdio: ['pipe', 'pipe', 'pipe'] });
      return new Promise((resolve) => {
        proc.on('close', (code) => resolve(code === 0));
        proc.on('error', () => resolve(false));
      });
    } catch {
      return false;
    }
  }

  async run(name, args = []) {
    await this.loadRegistry();
    const entry = this.registry.get(name);
    if (!entry) throw new Error(`CLI '${name}' not registered`);

    const installed = await this.isInstalled(entry.binary);
    if (!installed) {
      throw new Error(`CLI '${name}' (${entry.binary}) is not installed`);
    }

    const allArgs = [...(entry.defaultArgs || []), ...args];

    return new Promise((resolve, reject) => {
      const proc = spawn(entry.binary, allArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      proc.on('close', (code) => {
        resolve({
          tool: name,
          binary: entry.binary,
          args: allArgs,
          exitCode: code,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
        });
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to run '${name}': ${err.message}`));
      });
    });
  }

  async check() {
    await this.loadRegistry();
    const results = [];
    for (const [name, entry] of this.registry) {
      const installed = await this.isInstalled(entry.binary);
      results.push({ name, binary: entry.binary, installed });
    }
    return results;
  }
}
