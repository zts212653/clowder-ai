import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isInitialPencilProbeRollout,
  isPencilProbeCommand,
  isStalePencilProbe,
  PENCIL_EXECUTABLE,
  PENCIL_PROBE_IDLE_MS,
  PENCIL_PROBE_MAX_BYTES,
  pencilCodexExecutable,
  samePencilProbeWitness,
} from './pencil-codex-probe-policy.mjs';

function run(command, args, allowEmptyLsof = false) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (allowEmptyLsof && command === '/usr/sbin/lsof' && error.status === 1 && !String(error.stderr).trim()) {
      return String(error.stdout).trim();
    }
    throw error;
  }
}

export function readPencilProcessRows(exec = run) {
  return exec('/bin/ps', ['-axo', 'pid=,ppid=,command='])
    .split('\n')
    .flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
    });
}

function descendantsOf(rootPid, processes) {
  const found = [];
  const seen = new Set([rootPid]);
  const frontier = [rootPid];
  while (frontier.length > 0) {
    const pid = frontier.pop();
    for (const child of processes.filter((row) => row.ppid === pid && !seen.has(row.pid))) {
      seen.add(child.pid);
      found.push(child);
      frontier.push(child.pid);
    }
  }
  return found;
}

function isIdleProbeHelper(command) {
  return (
    command === '<defunct>' ||
    command === 'npm exec @playwright/mcp@latest' ||
    /^\/Applications\/(?:Pencil|ChatGPT)\.app\/\S+\/(?:mcp-server-darwin-arm64|node_repl)$/.test(command) ||
    /^node \/\S+\/node_modules\/\.bin\/playwright-mcp$/.test(command)
  );
}

function readProcessIdentity(pid, exec) {
  const row = exec('/bin/ps', ['-p', String(pid), '-o', 'ppid=,pcpu=,comm=']).match(/^(\d+)\s+([\d.]+)\s+(.+)$/);
  const startedAt = exec('/bin/ps', ['-p', String(pid), '-o', 'lstart=']);
  if (!row || !startedAt) throw new Error('process identity unavailable');
  return { ppid: Number(row[1]), cpuPercent: Number(row[2]), executable: row[3], startedAt };
}

export function readPencilProbeRollout(filePath, { homeDir = os.homedir(), nowMs = Date.now() } = {}) {
  const sessionRoot = path.join(homeDir, '.codex', 'sessions') + path.sep;
  const real = realpathSync(filePath);
  if (real !== filePath || !real.startsWith(sessionRoot) || !real.endsWith('.jsonl')) return null;
  const fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size <= 0 || before.size > PENCIL_PROBE_MAX_BYTES) return null;
    if (nowMs - before.mtimeMs < PENCIL_PROBE_IDLE_MS) return null;
    const buffer = Buffer.alloc(before.size + 1);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead !== before.size) return null;
    const content = buffer.subarray(0, bytesRead).toString('utf8');
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) return null;
    if (!isInitialPencilProbeRollout(content)) return null;
    return { path: real, size: after.size, mtimeMs: after.mtimeMs, dev: after.dev, ino: after.ino, probeOnly: true };
  } finally {
    closeSync(fd);
  }
}

/** All uncertain OS reads preserve the process; no prompt text enters findings or logs. */
export function inspectPencilProbe(
  row,
  processes,
  { exec = run, readRollout = readPencilProbeRollout, nowMs = Date.now() } = {},
) {
  if (!isPencilProbeCommand(row.command) || row.elapsedSeconds * 1000 < PENCIL_PROBE_IDLE_MS) return null;
  if (!processes.some((parent) => parent.pid === row.ppid && parent.command === PENCIL_EXECUTABLE)) return null;
  try {
    const identity = readProcessIdentity(row.pid, exec);
    const parent = readProcessIdentity(row.ppid, exec);
    if (
      identity.ppid !== row.ppid ||
      identity.executable !== pencilCodexExecutable(row.command) ||
      parent.executable !== PENCIL_EXECUTABLE ||
      identity.cpuPercent !== 0
    )
      return null;
    if (exec('/bin/ps', ['-p', String(row.pid), '-o', 'args=']) !== row.command) return null;
    const descendants = descendantsOf(row.pid, processes);
    if (descendants.some((child) => !isIdleProbeHelper(child.command))) return null;
    const ids = [
      row.pid,
      ...descendants.filter((child) => child.command !== '<defunct>').map((child) => child.pid),
    ].join(',');
    if (exec('/usr/sbin/lsof', ['-a', '-p', ids, '-iTCP', '-Fp'], true)) return null;
    const files = exec('/usr/sbin/lsof', ['-p', String(row.pid), '-Fn'])
      .split('\n')
      .filter((line) => line.startsWith('n') && line.includes('/.codex/sessions/') && line.endsWith('.jsonl'))
      .map((line) => line.slice(1));
    if (files.length !== 1) return null;
    const rollout = readRollout(files[0], { nowMs });
    if (!rollout) return null;
    return {
      startedAt: identity.startedAt,
      executable: identity.executable,
      parentExecutable: parent.executable,
      parentStartedAt: parent.startedAt,
      cpuPercent: 0,
      noTcpConnections: true,
      safeDescendants: true,
      descendants: descendants.map(({ pid, ppid, command }) => ({ pid, ppid, command })).sort((a, b) => a.pid - b.pid),
      rollout,
    };
  } catch {
    return null;
  }
}

export function enrichPencilProbes(processes, options = {}) {
  if ((options.platform ?? process.platform) !== 'darwin') return processes;
  const deadline = Date.now() + 30_000;
  let inspected = 0;
  return processes.map((row) => {
    if (!isPencilProbeCommand(row.command) || row.elapsedSeconds * 1000 < PENCIL_PROBE_IDLE_MS) return row;
    if (inspected >= 64 || Date.now() >= deadline) return row;
    inspected++;
    return { ...row, pencilProbe: inspectPencilProbe(row, processes, options) };
  });
}

export function revalidatePencilFinding(finding, options = {}) {
  try {
    const processes = (options.listProcesses ?? readPencilProcessRows)();
    const current = processes.find((row) => row.pid === finding.pid);
    if (!current || current.ppid !== finding.ppid || current.command !== finding.command) return false;
    const row = { ...current, elapsedSeconds: finding.elapsedSeconds };
    row.pencilProbe = inspectPencilProbe(row, processes, options);
    return (
      isStalePencilProbe(row, processes, options.nowMs) && samePencilProbeWitness(finding.pencilProbe, row.pencilProbe)
    );
  } catch {
    return false;
  }
}
