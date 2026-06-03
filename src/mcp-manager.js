#!/usr/bin/env node
import { spawn } from 'child_process';
import { readFile, writeFile, mkdir, unlink } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';

const CTX_DIR = join(homedir(), '.ctx');
const MCPS_DIR = join(CTX_DIR, 'mcps');
const REGISTRY_FILE = join(MCPS_DIR, 'registry.json');
const RUNNING_FILE = join(MCPS_DIR, 'running.json');
const INACTIVITY_MS = 2 * 60 * 1000;
const KILL_GRACE_MS = 5000;

// ─── PID file helpers ───────────────────────────────────────────────

async function readRunning() {
  try {
    if (!existsSync(RUNNING_FILE)) return {};
    return JSON.parse(await readFile(RUNNING_FILE, 'utf-8'));
  } catch { return {}; }
}

async function writeRunning(data) {
  await mkdir(MCPS_DIR, { recursive: true });
  const tmp = RUNNING_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(data, null, 2));
  const { rename } = await import('fs/promises');
  await rename(tmp, RUNNING_FILE);
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// ─── MCPManager ─────────────────────────────────────────────────────

export class MCPManager {
  constructor() {
    this.registry = new Map();
    this.processes = new Map(); // name → { proc, state, ... }
    this.registryFile = REGISTRY_FILE;
  }

  async loadRegistry() {
    await mkdir(MCPS_DIR, { recursive: true });
    if (!existsSync(this.registryFile)) await this.writeRegistry({});
    const data = JSON.parse(await readFile(this.registryFile, 'utf-8'));
    this.registry.clear();
    for (const [name, entry] of Object.entries(data)) this.registry.set(name, entry);
  }

  async writeRegistry(data) {
    await mkdir(MCPS_DIR, { recursive: true });
    const tmp = this.registryFile + '.tmp';
    await writeFile(tmp, JSON.stringify(data, null, 2));
    const { rename } = await import('fs/promises');
    await rename(tmp, this.registryFile);
  }

  async saveRegistry() {
    const obj = {};
    for (const [name, entry] of this.registry) obj[name] = entry;
    await this.writeRegistry(obj);
  }

  async list() {
    await this.loadRegistry();
    const running = await readRunning();
    const result = [];
    for (const [name, entry] of this.registry) {
      const rEntry = running[name];
      const isRunning = rEntry?.pid && isProcessAlive(rEntry.pid);
      result.push({
        name, description: entry.description || '',
        command: entry.command,
        status: isRunning ? 'running' : 'stopped',
        pid: rEntry?.pid || null, lastUsed: rEntry?.lastUsed || null,
      });
    }
    return result;
  }

  async add(name, command, args = [], env = {}, description = '') {
    await this.loadRegistry();
    if (this.registry.has(name)) throw new Error(`MCP '${name}' already registered`);
    this.registry.set(name, { name, description, command, args, env });
    await this.saveRegistry();
    return name;
  }

  async remove(name) {
    await this.loadRegistry();
    if (!this.registry.has(name)) throw new Error(`MCP '${name}' not found`);
    await this.kill(name);
    this.registry.delete(name);
    await this.saveRegistry();
    return name;
  }

  // ─── Spawn MCP directly via stdio pipes ─────────────────────────

  async spawn(name) {
    await this.loadRegistry();
    const entry = this.registry.get(name);
    if (!entry) throw new Error(`MCP '${name}' not registered`);

    // Kill any existing instance
    const running = await readRunning();
    const rEntry = running[name];
    if (rEntry?.pid && isProcessAlive(rEntry.pid)) {
      try { process.kill(rEntry.pid, 'SIGTERM'); } catch {}
      await new Promise(r => setTimeout(r, 200));
      if (isProcessAlive(rEntry.pid)) {
        try { process.kill(rEntry.pid, 'SIGKILL'); } catch {}
      }
      delete running[name];
      await writeRunning(running);
    } else if (rEntry) {
      delete running[name];
      await writeRunning(running);
    }

    // Spawn MCP directly with stdio pipes
    const cmd = entry.command;
    const args = entry.args || [];
    const env = { ...process.env, ...entry.env };

    let proc;
    try {
      proc = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
    } catch (err) {
      throw new Error(`Failed to spawn MCP '${name}': ${err.message}`);
    }

    // Setup response buffer
    let buffer = '';
    const pendingMap = new Map(); // id → { resolve, reject }
    const idCounter = { value: 0 };
    let initialized = false;

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.id && pendingMap.has(msg.id)) {
            const pending = pendingMap.get(msg.id);
            pendingMap.delete(msg.id);
            pending.resolve(msg);
          }
        } catch {}
      }
    });

    proc.on('error', (err) => {
      console.error(`[ctx] MCP '${name}' process error: ${err.message}`);
      this.processes.delete(name);
    });

    proc.on('exit', (code) => {
      this.processes.delete(name);
      this._removeFromRunning(name);
    });

    const state = {
      proc,
      lastUsed: Date.now(),
      timer: null,
      buffer: '',
      pendingMap,
      idCounter,
      initialized: false,
    };

    this.processes.set(name, state);

    // Write PID to running.json
    running[name] = {
      pid: proc.pid,
      startedAt: Date.now(),
      lastUsed: Date.now(),
      command: cmd,
      args,
    };
    await writeRunning(running);

    this.startInactivityTimer(name);
    return { pid: proc.pid };
  }

  startInactivityTimer(name) {
    const state = this.processes.get(name);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => this.inactivityKill(name), INACTIVITY_MS);
    if (state.timer.unref) state.timer.unref();
  }

  async inactivityKill(name) {
    const state = this.processes.get(name);
    if (!state) return;
    console.error(`[ctx] MCP '${name}' killed after 2min inactivity`);
    try { state.proc.kill('SIGTERM'); } catch {}
    setTimeout(() => {
      try { if (state.proc && !state.proc.killed) state.proc.kill('SIGKILL'); } catch {}
    }, KILL_GRACE_MS);
    this.processes.delete(name);
    await this._removeFromRunning(name);
  }

  // ─── MCP protocol handshake ─────────────────────────────────────

  async _initialize(name) {
    const state = this.processes.get(name);
    if (!state || state.initialized) return;

    const initReq = {
      jsonrpc: '2.0',
      id: ++state.idCounter.value,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ctx', version: '0.1.0' },
      },
    };

    await this._sendAndWait(state, initReq);

    const notif = { jsonrpc: '2.0', method: 'notifications/initialized' };
    state.proc.stdin.write(JSON.stringify(notif) + '\n');
    state.initialized = true;
  }

  _sendAndWait(state, request) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        state.pendingMap.delete(request.id);
        reject(new Error(`MCP handshake timed out after 15s`));
      }, 15000);

      state.pendingMap.set(request.id, {
        resolve: (msg) => {
          clearTimeout(timeout);
          if (msg.error) {
            reject(new Error(`MCP init error: ${msg.error.message || JSON.stringify(msg.error)}`));
          } else {
            resolve(msg.result);
          }
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      try {
        state.proc.stdin.write(JSON.stringify(request) + '\n');
      } catch (err) {
        state.pendingMap.delete(request.id);
        clearTimeout(timeout);
        reject(new Error(`Failed to write to MCP: ${err.message}`));
      }
    });
  }

  // ─── Call with init handshake ────────────────────────────────────

  async call(name, method, args = {}) {
    await this.loadRegistry();
    const entry = this.registry.get(name);
    if (!entry) throw new Error(`MCP '${name}' not registered`);

    if (!this.processes.has(name)) {
      // Check running.json
      const running = await readRunning();
      const rEntry = running[name];
      if (rEntry?.pid && isProcessAlive(rEntry.pid)) {
        try { process.kill(rEntry.pid, 'SIGTERM'); } catch {}
        await new Promise(r => setTimeout(r, 200));
        if (isProcessAlive(rEntry.pid)) {
          try { process.kill(rEntry.pid, 'SIGKILL'); } catch {}
        }
        delete running[name];
        await writeRunning(running);
      }
      await this.spawn(name);
    }

    const state = this.processes.get(name);
    if (!state) throw new Error(`MCP '${name}' failed to start`);

    if (!state.initialized) {
      await this._initialize(name);
    }

    state.lastUsed = Date.now();
    this.startInactivityTimer(name);
    this._touchRunning(name);

    const id = ++state.idCounter.value;
    const request = {
      jsonrpc: '2.0',
      id,
      method: method.startsWith('tools/') ? method : `tools/call`,
      params: method.startsWith('tools/') ? args : { name: method, arguments: args },
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        state.pendingMap.delete(id);
        reject(new Error(`MCP '${name}' call timed out after 30s`));
      }, 30000);

      state.pendingMap.set(id, {
        resolve: (msg) => {
          clearTimeout(timeout);
          if (msg.error) {
            reject(new Error(`MCP error: ${msg.error.message || JSON.stringify(msg.error)}`));
          } else {
            resolve(msg.result);
          }
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      try {
        state.proc.stdin.write(JSON.stringify(request) + '\n');
      } catch (err) {
        state.pendingMap.delete(id);
        clearTimeout(timeout);
        reject(new Error(`Failed to write to MCP '${name}': ${err.message}`));
      }
    });
  }

  async _touchRunning(name) {
    try {
      const running = await readRunning();
      if (running[name]) {
        running[name].lastUsed = Date.now();
        await writeRunning(running);
      }
    } catch {}
  }

  async _removeFromRunning(name) {
    try {
      const running = await readRunning();
      delete running[name];
      await writeRunning(running);
    } catch {}
  }

  // ─── Kill ───────────────────────────────────────────────────────

  async kill(name) {
    const state = this.processes.get(name);
    if (state) {
      if (state.timer) clearTimeout(state.timer);
      try { state.proc.kill('SIGTERM'); } catch {}
      setTimeout(() => {
        try { if (state.proc && !state.proc.killed) state.proc.kill('SIGKILL'); } catch {}
      }, KILL_GRACE_MS);
      this.processes.delete(name);
    }

    const running = await readRunning();
    const rEntry = running[name];
    if (rEntry?.pid) {
      if (isProcessAlive(rEntry.pid)) {
        try { process.kill(rEntry.pid, 'SIGTERM'); } catch {}
        await new Promise(r => setTimeout(r, KILL_GRACE_MS));
        if (isProcessAlive(rEntry.pid)) {
          try { process.kill(rEntry.pid, 'SIGKILL'); } catch {}
        }
      }
      delete running[name];
      await writeRunning(running);
      return true;
    }
    return !!state;
  }

  async killAll() {
    const running = await readRunning();
    for (const [name] of Object.entries(running)) await this.kill(name);
  }

  // ─── Status ─────────────────────────────────────────────────────

  async status() {
    await this.loadRegistry();
    const running = await readRunning();
    const result = [];
    for (const [name, entry] of this.registry) {
      const rEntry = running[name];
      const isRunning = rEntry?.pid && isProcessAlive(rEntry.pid);
      let uptime = null;
      if (isRunning && rEntry?.startedAt) uptime = Date.now() - rEntry.startedAt;
      result.push({
        name, description: entry.description || '',
        status: isRunning ? 'running' : 'stopped',
        pid: rEntry?.pid || null, uptime, lastUsed: rEntry?.lastUsed || null,
      });
    }
    return result;
  }

  // ─── Watchdog ───────────────────────────────────────────────────

  async watchdog() {
    const running = await readRunning();
    const now = Date.now();
    const killed = [];
    for (const [name, rEntry] of Object.entries(running)) {
      const idleMs = now - (rEntry.lastUsed || rEntry.startedAt || 0);
      if (idleMs > INACTIVITY_MS) {
        console.error(`[ctx] watchdog: killing '${name}' (idle ${Math.round(idleMs / 1000)}s)`);
        if (rEntry.pid && isProcessAlive(rEntry.pid)) {
          try { process.kill(rEntry.pid, 'SIGTERM'); } catch {}
          await new Promise(r => setTimeout(r, KILL_GRACE_MS));
          if (isProcessAlive(rEntry.pid)) {
            try { process.kill(rEntry.pid, 'SIGKILL'); } catch {}
          }
        }
        delete running[name];
        killed.push(name);
      }
    }
    let cleaned = false;
    for (const [name, rEntry] of Object.entries(running)) {
      if (rEntry.pid && !isProcessAlive(rEntry.pid)) { delete running[name]; cleaned = true; }
    }
    if (killed.length > 0 || cleaned) await writeRunning(running);
    return killed;
  }
}
