#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const RECORD_VERSION = 1;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_RECOVERY_TIMEOUT_MS = 20_000;
const STOP_TERM_GRACE_MS = 3_000;
const STOP_KILL_GRACE_MS = 1_000;
const SENSITIVE_ENV_KEYS = [
  'CAT_CAFE_INVOCATION_ID',
  'CAT_CAFE_CALLBACK_TOKEN',
  'CAT_CAFE_SUPERVISOR_PARENT_PID',
  'CAT_CAFE_AGENT_KEY_FILES',
];

function usage() {
  return `Usage:
  pnpm preview:process start --port PORT --cwd DIR -- COMMAND [ARGS...]
  pnpm preview:process status --port PORT --cwd DIR [--json]
  pnpm preview:process stop --port PORT --cwd DIR [--json]`;
}

function parseArgs(argv) {
  const action = argv[0];
  const separator = argv.indexOf('--');
  const optionArgs = separator >= 0 ? argv.slice(1, separator) : argv.slice(1);
  const command = separator >= 0 ? argv.slice(separator + 1) : [];
  const options = { action, command, json: false };
  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--port' || arg === '--cwd') {
      options[arg.slice(2)] = optionArgs[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function resolveConfig(options) {
  if (!['start', 'status', 'stop'].includes(options.action)) throw new Error(usage());
  if (!/^\d+$/.test(options.port ?? '')) throw new Error('--port must be an integer from 1 to 65535');
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('--port must be an integer from 1 to 65535');
  }
  if (!options.cwd) throw new Error('--cwd is required');
  const cwd = resolve(options.cwd);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
  if (options.action === 'start' && options.command.length === 0) {
    throw new Error('start requires a command after --');
  }
  const stateDir = resolve(
    process.env.CAT_CAFE_PREVIEW_PROCESS_DIR ?? join(homedir(), '.cat-cafe', 'preview-processes'),
  );
  const id = createHash('sha256').update(`${cwd}\0${port}`).digest('hex').slice(0, 16);
  return {
    ...options,
    cwd,
    port,
    id,
    stateDir,
    recordPath: join(stateDir, `${id}.json`),
    logPath: join(stateDir, `${id}.log`),
  };
}

function writeRecord(config, record) {
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const temporaryPath = `${config.recordPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, config.recordPath);
}

function readRecord(config) {
  try {
    const value = JSON.parse(readFileSync(config.recordPath, 'utf8'));
    return value.version === RECORD_VERSION && value.id === config.id ? value : null;
  } catch {
    return null;
  }
}

function readProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const started = spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' });
  const command = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  if (started.status !== 0 || command.status !== 0) return null;
  const processStartedAt = started.stdout.trim();
  const processCommand = command.stdout.trim();
  return processStartedAt && processCommand ? { processStartedAt, processCommand } : null;
}

function ownsProcess(record) {
  const current = readProcessIdentity(record?.pid);
  return Boolean(
    current && current.processStartedAt === record.processStartedAt && current.processCommand === record.processCommand,
  );
}

function processGroupExists(record) {
  if (process.platform === 'win32') return ownsProcess(record);
  const processes = spawnSync('ps', ['-axo', 'pgid=,stat='], { encoding: 'utf8' });
  if (processes.status === 0) {
    return processes.stdout.split('\n').some((line) => {
      const [processGroupId, state] = line.trim().split(/\s+/, 2);
      return Number(processGroupId) === record.pid && state && !state.startsWith('Z');
    });
  }
  try {
    process.kill(-record.pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function probePort(port, timeoutMs = 250) {
  return new Promise((resolveProbe) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (reachable) => {
      socket.destroy();
      resolveProbe(reachable);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function waitForPort(port, expected, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if ((await probePort(port)) === expected) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  } while (Date.now() < deadline);
  return false;
}

async function waitForProcessGroupExit(record, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!processGroupExists(record)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  } while (Date.now() < deadline);
  return !processGroupExists(record);
}

async function captureIdentity(pid) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const identity = readProcessIdentity(pid);
    if (identity) return identity;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return null;
}

function cleanChildEnv() {
  const env = { ...process.env };
  for (const key of SENSITIVE_ENV_KEYS) delete env[key];
  return env;
}

function killOwnedGroup(record, signal, ownershipAlreadyProven = false) {
  if (!ownershipAlreadyProven && !ownsProcess(record)) return false;
  try {
    process.kill(process.platform === 'win32' ? record.pid : -record.pid, signal);
    return true;
  } catch {
    return false;
  }
}

function report(config, payload, exitCode = 0) {
  if (config.json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stdout.write(`[preview-process] ${payload.status} ${payload.cwd}:${payload.port}`);
    if (payload.logPath) process.stdout.write(`\nlog: ${payload.logPath}`);
    process.stdout.write('\n');
  }
  process.exitCode = exitCode;
}

async function currentStatus(config) {
  const record = readRecord(config);
  const reachable = await probePort(config.port);
  if (!record) return { status: reachable ? 'unmanaged' : 'stopped', record: null, reachable };
  const owned = ownsProcess(record);
  if (owned && reachable) return { status: 'running', record, reachable };
  if (owned && !record.readyAt) return { status: 'starting', record, reachable };
  if (owned) return { status: 'unavailable', record, reachable };
  return { status: reachable ? 'unmanaged' : 'stopped', record, reachable };
}

async function start(config) {
  const existing = await currentStatus(config);
  if (existing.status === 'running') {
    report(config, { status: 'running', cwd: config.cwd, port: config.port, logPath: existing.record.logPath });
    return;
  }
  if (existing.status === 'starting') {
    const reachable = await waitForPort(config.port, true, DEFAULT_RECOVERY_TIMEOUT_MS);
    if (reachable && ownsProcess(existing.record)) {
      const readyRecord = { ...existing.record, readyAt: new Date().toISOString() };
      writeRecord(config, readyRecord);
      report(config, {
        status: 'running',
        cwd: config.cwd,
        port: config.port,
        pid: readyRecord.pid,
        logPath: readyRecord.logPath,
      });
      return;
    }
    if (ownsProcess(existing.record)) {
      report(config, {
        status: 'starting',
        cwd: config.cwd,
        port: config.port,
        pid: existing.record.pid,
        logPath: existing.record.logPath,
      });
      return;
    }
    rmSync(config.recordPath, { force: true });
    throw new Error(`preview process exited before listening on port ${config.port}; see ${config.logPath}`);
  }
  if (existing.status === 'unmanaged' || existing.status === 'unavailable') {
    throw new Error(`refusing to replace ${existing.status} target on port ${config.port}`);
  }
  rmSync(config.recordPath, { force: true });
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const logFd = openSync(config.logPath, 'a', 0o600);
  let child;
  try {
    child = spawn(config.command[0], config.command.slice(1), {
      cwd: config.cwd,
      detached: true,
      env: cleanChildEnv(),
      stdio: ['ignore', logFd, logFd],
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();
  const identity = await captureIdentity(child.pid);
  if (!identity) throw new Error(`started PID ${child.pid} but could not capture its process identity`);
  const record = {
    version: RECORD_VERSION,
    id: config.id,
    cwd: config.cwd,
    port: config.port,
    command: config.command,
    pid: child.pid,
    ...identity,
    startedAt: new Date().toISOString(),
    logPath: config.logPath,
  };
  writeRecord(config, record);
  let reachable = await waitForPort(config.port, true, DEFAULT_START_TIMEOUT_MS);
  if (!reachable && ownsProcess(record)) {
    reachable = await waitForPort(config.port, true, DEFAULT_RECOVERY_TIMEOUT_MS);
  }
  if (!reachable) {
    if (ownsProcess(record)) {
      report(config, {
        status: 'starting',
        cwd: config.cwd,
        port: config.port,
        pid: child.pid,
        logPath: config.logPath,
      });
      return;
    }
    rmSync(config.recordPath, { force: true });
    throw new Error(`preview process exited before listening on port ${config.port}; see ${config.logPath}`);
  }
  const readyRecord = { ...record, readyAt: new Date().toISOString() };
  writeRecord(config, readyRecord);
  report(config, { status: 'running', cwd: config.cwd, port: config.port, pid: child.pid, logPath: config.logPath });
}

async function status(config) {
  const result = await currentStatus(config);
  if (result.status === 'running' && result.record && !result.record.readyAt) {
    writeRecord(config, { ...result.record, readyAt: new Date().toISOString() });
  }
  report(
    config,
    {
      status: result.status,
      cwd: config.cwd,
      port: config.port,
      ...(result.record ? { pid: result.record.pid, logPath: result.record.logPath } : {}),
    },
    result.status === 'running' || result.status === 'starting' ? 0 : 1,
  );
}

async function stop(config) {
  const result = await currentStatus(config);
  if (!result.record && result.status === 'stopped') {
    report(config, { status: 'stopped', cwd: config.cwd, port: config.port });
    return;
  }
  if (!result.record || !ownsProcess(result.record)) {
    throw new Error(`refusing to stop ${result.status} port ${config.port}: exact process ownership is not proven`);
  }
  killOwnedGroup(result.record, 'SIGTERM');
  if (!(await waitForProcessGroupExit(result.record, STOP_TERM_GRACE_MS))) {
    killOwnedGroup(result.record, 'SIGKILL', true);
    await waitForProcessGroupExit(result.record, STOP_KILL_GRACE_MS);
  }
  if (processGroupExists(result.record)) {
    throw new Error(
      `failed to stop owned preview process group ${result.record.pid}; state retained at ${config.recordPath}`,
    );
  }
  await waitForPort(config.port, false, STOP_KILL_GRACE_MS);
  rmSync(config.recordPath, { force: true });
  report(config, { status: 'stopped', cwd: config.cwd, port: config.port, logPath: result.record.logPath });
}

try {
  const config = resolveConfig(parseArgs(process.argv.slice(2)));
  if (config.action === 'start') await start(config);
  if (config.action === 'status') await status(config);
  if (config.action === 'stop') await stop(config);
} catch (error) {
  process.stderr.write(`[preview-process] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
