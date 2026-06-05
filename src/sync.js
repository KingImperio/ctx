#!/usr/bin/env node
import { existsSync } from 'fs';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { execFileSync } from 'child_process';

const HOME = homedir();
const CTX_DIR = join(HOME, '.ctx');

function git(args) {
  try {
    const stdout = execFileSync('git', args, { cwd: CTX_DIR, encoding: 'utf-8', timeout: 30000 });
    return { stdout: stdout.trim(), exitCode: 0 };
  } catch (err) {
    return { stdout: '', stderr: err.stderr?.trim() || err.message, exitCode: err.status || 1 };
  }
}

export async function isSyncInitialized() {
  return existsSync(join(CTX_DIR, '.git'));
}

async function ensureGitignore() {
  const gitignorePath = join(CTX_DIR, '.gitignore');
  const content = `# Process state — machine-specific
running.json
ipc/

# Secret env vars in MCP configs
*.env
.env
*/secrets*

# Temp files from atomic writes
*.tmp
`;
  await writeFile(gitignorePath, content);
}

function isValidGitUrl(url) {
  // Allow: https://, http://, git://, ssh://, and user@host:path format
  return /^(https?:\/\/|git:\/\/|ssh:\/\/|git@[\w.-]+:)/.test(url);
}

export async function syncInit(remoteUrl) {
  if (!existsSync(CTX_DIR)) {
    await mkdir(CTX_DIR, { recursive: true });
  }

  const result = git('init');
  if (result.exitCode !== 0) return result;

  await ensureGitignore();

  git('add -A');
  git('commit -m "ctx: initial registry snapshot"');

  if (remoteUrl) {
    if (!isValidGitUrl(remoteUrl)) {
      return { exitCode: 1, message: `Invalid git URL: ${remoteUrl}` };
    }
    const existing = git('remote get-url origin');
    if (existing.exitCode === 0) {
      git(`remote set-url origin "${remoteUrl}"`);
    } else {
      git(`remote add origin "${remoteUrl}"`);
    }
    git('push -u origin HEAD');
  }

  return { exitCode: 0, message: 'Sync initialized' };
}

export async function syncPush() {
  if (!(await isSyncInitialized())) {
    return { exitCode: 0, message: 'No remote configured' };
  }

  git('add -A');

  // Check if there are changes
  const status = git('diff --cached --quiet');
  if (status.exitCode === 0) {
    return { exitCode: 0, message: 'No changes to push' };
  }

  const commitMsg = `ctx: sync ${new Date().toISOString().slice(0, 19)}`;
  git(`commit -m "${commitMsg}"`);

  const pushResult = git('push origin HEAD');
  if (pushResult.exitCode !== 0) {
    return { exitCode: 1, message: `Push failed: ${pushResult.stderr}` };
  }

  return { exitCode: 0, message: 'Pushed to remote' };
}

export async function syncPull() {
  if (!(await isSyncInitialized())) {
    return { exitCode: 0, message: 'No remote configured' };
  }

  const result = git('pull --rebase origin HEAD');
  return result;
}

export async function syncStatus() {
  if (!(await isSyncInitialized())) {
    return { initialized: false, dirty: false, branch: '', remote: '', ahead: 0, behind: 0 };
  }

  const branch = git('rev-parse --abbrev-ref HEAD');
  const remote = git('remote get-url origin');
  const ahead = git('rev-list @{upstream}..HEAD --count 2>/dev/null || echo 0');
  const behind = git('rev-list HEAD..@{upstream} --count 2>/dev/null || echo 0');
  const status = git('status --porcelain');

  return {
    initialized: true,
    dirty: status.stdout.length > 0,
    branch: branch.stdout,
    remote: remote.exitCode === 0 ? remote.stdout : '(none)',
    ahead: parseInt(ahead.stdout) || 0,
    behind: parseInt(behind.stdout) || 0,
  };
}

export async function cloneFromRemote(remoteUrl) {
  const result = git(`clone "${remoteUrl}" "${CTX_DIR}"`);
  return result;
}

export function printSyncStatus(status) {
  if (!status.initialized) {
    console.log('Git sync not initialized. Run: ctx sync init');
    return;
  }

  console.log('═══════════════════════════════════');
  console.log('  ctx sync status');
  console.log('═══════════════════════════════════\n');
  console.log(`  Branch:   ${status.branch}`);
  console.log(`  Remote:   ${status.remote}`);
  console.log(`  Ahead:    ${status.ahead} commits`);
  console.log(`  Behind:   ${status.behind} commits`);
  console.log(`  Dirty:    ${status.dirty ? 'yes' : 'no'}`);
}
