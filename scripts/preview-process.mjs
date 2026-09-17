#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probePort, processGroupExists, waitForPort, waitForProcessGroupExit } from './lib/preview-process-runtime.mjs';
import {
  launchDetached,
  launchWithLaunchd,
  ownsLaunchdJob,
  ownsLaunchdProcess,
  ownsProcess,
  removeLaunchdJob,
} from './preview-process-launchers.mjs';

const RECORD_VERSION = 1;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_RECOVERY_TIMEOUT_MS = 20_000;
const STOP_TERM_GRACE_MS = 3_000;
const STOP_KILL_GRACE_MS = 1_000;
const LAUNCHD_LABEL_PREFIX = 'com.catcafe.preview';
const DEFAULT_LIFETIME_SECONDS = 8 * 60 * 60;
const MAX_LIFETIME_SECONDS = 24 * 60 * 60;
const LEASE_RUNNER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'preview-process-lease-runner.mjs');

function usage() {
  return `Usage:
  pnpm preview:process start --port PORT --cwd DIR [--lifetime-seconds N] -- COMMAND [ARGS...]
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
    if (arg === '--port' || arg === '--cwd' || arg === '--lifetime-seconds') {
      options[arg.slice(2)] = optionArgs[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function resolveLifetimeSeconds(options) {
  const lifetimeSeconds = Number(options['lifetime-seconds'] ?? DEFAULT_LIFETIME_SECONDS);
  if (options.action !== 'start') return lifetimeSeconds;
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > MAX_LIFETIME_SECONDS) {
    throw new Error(`--lifetime-seconds must be an integer from 1 to ${MAX_LIFETIME_SECONDS}`);
  }
  return lifetimeSeconds;
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
  if (options.action === 'start' && (!existsSync(cwd) || !statSync(cwd).isDirectory())) {
    throw new Error(`cwd is not a directory: ${cwd}`);
  }
  if (options.action === 'start' && options.command.length === 0) {
    throw new Error('start requires a command after --');
  }
  const lifetimeSeconds = resolveLifetimeSeconds(options);
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
    launchdLabel: `${LAUNCHD_LABEL_PREFIX}.${id}`,
    plistPath: join(stateDir, `${id}.plist`),
    lifetimeSeconds,
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

function ownsManagedProcess(config, record) {
  return record?.origin === 'launchd' ? ownsLaunchdProcess(config, record) : ownsProcess(record);
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
    if (payload.origin) process.stdout.write(`\norigin: ${payload.origin}`);
    if (payload.logPath) process.stdout.write(`\nlog: ${payload.logPath}`);
    process.stdout.write('\n');
  }
  process.exitCode = exitCode;
}

async function currentStatus(config) {
  const record = readRecord(config);
  const reachable = await probePort(config.port);
  if (!record) return { status: reachable ? 'unmanaged' : 'stopped', record: null, reachable };
  const owned = ownsManagedProcess(config, record);
  if (owned && reachable) return { status: 'running', record, reachable };
  if (owned && !record.readyAt) return { status: 'starting', record, reachable };
  if (owned) return { status: 'unavailable', record, reachable };
  return { status: reachable ? 'unmanaged' : 'stopped', record, reachable };
}

function reportManagedStatus(config, status, record) {
  report(config, {
    status,
    cwd: config.cwd,
    port: config.port,
    pid: record.pid,
    origin: record.origin ?? 'detached',
    logPath: record.logPath,
    expiresAt: record.expiresAt,
  });
}

async function handleExistingStart(config, existing) {
  if (existing.status === 'running') {
    reportManagedStatus(config, 'running', existing.record);
    return true;
  }
  if (existing.status === 'starting') {
    const reachable = await waitForPort(config.port, true, DEFAULT_RECOVERY_TIMEOUT_MS);
    if (reachable && ownsManagedProcess(config, existing.record)) {
      const readyRecord = { ...existing.record, readyAt: new Date().toISOString() };
      writeRecord(config, readyRecord);
      reportManagedStatus(config, 'running', readyRecord);
      return true;
    }
    if (ownsManagedProcess(config, existing.record)) {
      reportManagedStatus(config, 'starting', existing.record);
      return true;
    }
    rmSync(config.recordPath, { force: true });
    throw new Error(`preview process exited before listening on port ${config.port}; see ${config.logPath}`);
  }
  if (existing.status === 'unmanaged' || existing.status === 'unavailable') {
    throw new Error(`refusing to replace ${existing.status} target on port ${config.port}`);
  }
  return false;
}

async function finishStartedProcess(config, record) {
  let reachable = await waitForPort(config.port, true, DEFAULT_START_TIMEOUT_MS);
  if (!reachable && ownsManagedProcess(config, record)) {
    reachable = await waitForPort(config.port, true, DEFAULT_RECOVERY_TIMEOUT_MS);
  }
  if (reachable) {
    const readyRecord = { ...record, readyAt: new Date().toISOString() };
    writeRecord(config, readyRecord);
    reportManagedStatus(config, 'running', readyRecord);
    return;
  }
  if (ownsManagedProcess(config, record)) {
    reportManagedStatus(config, 'starting', record);
    return;
  }
  if (record.origin === 'launchd') {
    removeLaunchdJob(config);
    rmSync(config.plistPath, { force: true });
  }
  rmSync(config.recordPath, { force: true });
  throw new Error(`preview process exited before listening on port ${config.port}; see ${config.logPath}`);
}

async function start(config) {
  const existing = await currentStatus(config);
  if (await handleExistingStart(config, existing)) return;
  rmSync(config.recordPath, { force: true });
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const expiresAt = new Date(Date.now() + config.lifetimeSeconds * 1_000).toISOString();
  const launchConfig = {
    ...config,
    command: [process.execPath, LEASE_RUNNER_PATH, '--expires-at', expiresAt, '--', ...config.command],
  };
  const processHandle =
    process.platform === 'darwin' ? await launchWithLaunchd(launchConfig) : await launchDetached(launchConfig);
  const record = {
    version: RECORD_VERSION,
    id: config.id,
    cwd: config.cwd,
    port: config.port,
    command: config.command,
    ...processHandle,
    startedAt: new Date().toISOString(),
    expiresAt,
    logPath: config.logPath,
  };
  writeRecord(config, record);
  await finishStartedProcess(config, record);
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
      ...(result.record
        ? {
            pid: result.record.pid,
            origin: result.record.origin ?? 'detached',
            logPath: result.record.logPath,
            expiresAt: result.record.expiresAt,
          }
        : {}),
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
  if (result.status === 'stopped' && result.record?.origin === 'launchd' && ownsLaunchdJob(config, result.record)) {
    removeLaunchdJob(config);
    rmSync(config.recordPath, { force: true });
    rmSync(config.plistPath, { force: true });
    report(config, { status: 'stopped', cwd: config.cwd, port: config.port, logPath: result.record.logPath });
    return;
  }
  if (!result.record || !ownsManagedProcess(config, result.record)) {
    throw new Error(`refusing to stop ${result.status} port ${config.port}: exact process ownership is not proven`);
  }
  if (result.record.origin === 'launchd') {
    removeLaunchdJob(config);
    if (!(await waitForPort(config.port, false, STOP_TERM_GRACE_MS + STOP_KILL_GRACE_MS))) {
      throw new Error(`failed to stop launchd preview ${config.launchdLabel}; state retained at ${config.recordPath}`);
    }
    rmSync(config.recordPath, { force: true });
    rmSync(config.plistPath, { force: true });
    report(config, { status: 'stopped', cwd: config.cwd, port: config.port, logPath: result.record.logPath });
    return;
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
