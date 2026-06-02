#!/usr/bin/env node
import { spawn, execSync } from 'child_process';
import { readFile, writeFile, mkdir, unlink } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { homedir, platform } from 'os';

const CTX_DIR = join(homedir(), '.ctx');
const MCPS_DIR = join(CTX_DIR, 'mcps');
const REGISTRY_FILE = join(MCPS_DIR, 'registry.json');
const RUNNING_FILE = join(MCPS_DIR, 'running.json');
const INACTIVITY_MS = 2 * 60 * 1000; // 2 minutes
const KILL_GRACE_MS = 5000; // 5 seconds after SIGTERM

// ─── PID file helpers ───────────────────────────────────────────────

async function readRunning() {
  try {
    if (!existsSync(RUNNING_FILE)) return {};
    return JSON.parse(await readFile(RUNNING_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

async function writeRunning(data) {
  await mkdir(MCPS_DIR, { recursive: true });
  const tmp = RUNNING_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(data, null, 2));
  const { rename } = await import('fs/promises');
  await rename(tmp, RUNNING_FILE);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─── MCPManager ─────────────────────────────────────────────────────

export class MCPManager {
  constructor() {
    this.registry = new Map();
    this.processes = new Map();
    this.registryFile = REGISTRY_FILE;
  }

  async loadRegistry() {
    await mkdir(MCPS_DIR, { recursive: true });
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
    await mkdir(MCPS_DIR, { recursive: true });
    const tmp = this.registryFile + '.tmp';
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await writeFile(this.registryFile, await readFile(tmp));
    try { await unlink(tmp); } catch {}
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
    const running = await readRunning();
    const result = [];
    for (const [name, entry] of this.registry) {
      const rEntry = running[name];
      const isRunning = rEntry?.pid && isProcessAlive(rEntry.pid);
      result.push({
        name,
        description: entry.description || '',
        command: entry.command,
        status: isRunning ? 'running' : 'stopped',
        pid: rEntry?.pid || null,
        lastUsed: rEntry?.lastUsed || null,
      });
    }
    return result;
  }

  async add(name, command, args = [], env = {}, description = '') {
    await this.loadRegistry();
    if (this.registry.has(name)) {
      throw new Error(`MCP '${name}' already registered`);
    }
    this.registry.set(name, { name, description, command, args, env });
    await this.saveRegistry();
    return name;
  }

  async remove(name) {
    await this.loadRegistry();
    if (!this.registry.has(name)) {
      throw new Error(`MCP '${name}' not found`);
    }
    await this.kill(name);
    this.registry.delete(name);
    await this.saveRegistry();
    return name;
  }

  // ─── Spawn via daemon wrapper ───────────────────────────────────

  async spawn(name) {
    await this.loadRegistry();
    const entry = this.registry.get(name);
    if (!entry) throw new Error(`MCP '${name}' not registered`);

    if (platform() === 'android' && entry.platform === 'desktop') {
      throw new Error(`MCP '${name}' not available on this platform`);
    }

    // Check running.json for existing PID
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

    // Clean up stale FIFOs
    await cleanupFIFO(name);

    const cmd = entry.command;
    const args = entry.args || [];
    const daemonScript = join(new URL('.', import.meta.url).pathname, 'mcp-daemon.sh');

    // Spawn daemon wrapper (detached, unref'd)
    const daemonArgs = [daemonScript, name, cmd, ...args];
    let proc;
    try {
      proc = spawn('bash', daemonArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      proc.unref();
    } catch (err) {
      throw new Error(`Failed to spawn MCP daemon for '${name}': ${err.message}`);
    }

    // Read PID from daemon stdout
    const pidStr = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Daemon startup timeout')), 5000);
      let buf = '';
      proc.stdout.on('data', (chunk) => {
        buf += chunk.toString();
        const match = buf.match(/^(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]);
        }
      });
      proc.on('error', (err) => { clearTimeout(timeout); reject(err); });
      proc.on('exit', (code) => {
        if (!buf.match(/^\d+/)) {
          clearTimeout(timeout);
          reject(new Error(`Daemon exited with code ${code}`));
        }
      });
    });

    const mcpPid = parseInt(pidStr, 10);

    const state = {
      process: { pid: mcpPid },
      lastUsed: Date.now(),
      timer: null,
      buffer: '',
      pending: null,
      idCounter: 0,
      initialized: false,
      reqPath: fifoPath(name, 'req'),
      resPath: fifoPath(name, 'res'),
      resReader: null,
    };

    // Read responses from the response FIFO
    const { createReadStream } = await import('fs');
    const resReader = createReadStream(state.resPath, { encoding: 'utf-8' });
    state.resReader = resReader;

    resReader.on('data', (chunk) => {
      state.buffer += chunk;
      const lines = state.buffer.split('\n');
      state.buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (state.pending && msg.id === state.pending.id) {
            state.pending.resolve(msg);
            state.pending = null;
          }
        } catch {}
      }
    });

    this.processes.set(name, state);

    // Write PID to running.json
    running[name] = {
      pid: mcpPid,
      startedAt: Date.now(),
      lastUsed: Date.now(),
      command: cmd,
      args,
    };
    await writeRunning(running);

    this.startInactivityTimer(name);
    return { pid: mcpPid };
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
    try { state.process.kill('SIGTERM'); } catch {}
    setTimeout(() => {
      try {
        const s = this.processes.get(name);
        if (s?.process) s.process.kill('SIGKILL');
      } catch {}
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
      id: ++state.idCounter,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'ctx', version: '0.1.0' },
      },
    };

    await this._sendAndWait(state, initReq);

    const notif = { jsonrpc: '2.0', method: 'notifications/initialized' };
    state.process.stdin.write(JSON.stringify(notif) + '\n');
    state.initialized = true;
  }

  _sendAndWait(state, request) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        state.pending = null;
        reject(new Error(`MCP handshake timed out after 15s`));
      }, 15000);

      state.pending = {
        id: request.id,
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
      };

      try {
        state.process.stdin.write(JSON.stringify(request) + '\n');
      } catch (err) {
        state.pending = null;
        clearTimeout(timeout);
        reject(new Error(`Failed to write to MCP: ${err.message}`));
      }
    });
  }

  // ─── Call with PID tracking + init handshake ────────────────────

  async call(name, method, args = {}) {
    await this.loadRegistry();
    const entry = this.registry.get(name);
    if (!entry) throw new Error(`MCP '${name}' not registered`);

    if (!this.processes.has(name)) {
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

    const id = ++state.idCounter;
    const request = {
      jsonrpc: '2.0',
      id,
      method: method.startsWith('tools/') ? method : `tools/call`,
      params: method.startsWith('tools/') ? args : { name: method, arguments: args },
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        state.pending = null;
        reject(new Error(`MCP '${name}' call timed out after 30s`));
      }, 30000);

      state.pending = {
        id,
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
      };

      try {
        state.process.stdin.write(JSON.stringify(request) + '\n');
      } catch (err) {
        state.pending = null;
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

  // ─── Kill with PID file tracking ────────────────────────────────

  async kill(name) {
    const state = this.processes.get(name);
    if (state) {
      if (state.timer) clearTimeout(state.timer);
      try {
        state.process.kill('SIGTERM');
        setTimeout(() => {
          try { state.process.kill('SIGKILL'); } catch {}
        }, KILL_GRACE_MS);
      } catch {}
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
    for (const [name] of Object.entries(running)) {
      await this.kill(name);
    }
  }

  // ─── Status from running.json ───────────────────────────────────

  async status() {
    await this.loadRegistry();
    const running = await readRunning();
    const result = [];
    for (const [name, entry] of this.registry) {
      const rEntry = running[name];
      const isRunning = rEntry?.pid && isProcessAlive(rEntry.pid);
      const pid = rEntry?.pid || null;
      const lastUsed = rEntry?.lastUsed || null;
      const startedAt = rEntry?.startedAt || null;
      let uptime = null;
      if (isRunning && startedAt) {
        uptime = Date.now() - startedAt;
      }
      result.push({
        name,
        description: entry.description || '',
        status: isRunning ? 'running' : 'stopped',
        pid,
        uptime,
        lastUsed,
      });
    }
    return result;
  }

  // ─── Watchdog: kill idle + stale MCPs ───────────────────────────

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

    // Clean stale entries (dead PIDs)
    let cleaned = false;
    for (const [name, rEntry] of Object.entries(running)) {
      if (rEntry.pid && !isProcessAlive(rEntry.pid)) {
        delete running[name];
        cleaned = true;
      }
    }

    if (killed.length > 0 || cleaned) {
      await writeRunning(running);
    }

    return killed;
  }
}
