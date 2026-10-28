#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clearPreviewSettlement, readPreviewSettlement } from './lib/preview-alpha-registration-settlement.mjs';
import { withPreviewMutationLock } from './lib/preview-process-mutex.mjs';
import { previewProcessRecordId } from './lib/preview-process-record-key.mjs';
import { probePort, waitForPort } from './lib/preview-process-runtime.mjs';
import { readPreviewCompletion, stopManagedPreview } from './lib/preview-process-stop.mjs';
import {
  launchDetached,
  launchWithLaunchd,
  ownsLaunchdProcess,
  ownsProcess,
  removeLaunchdJob,
} from './preview-process-launchers.mjs';

const RECORD_VERSION = 1;
const DEFAULT_START_TIMEOUT_MS = 10_000;
const DEFAULT_RECOVERY_TIMEOUT_MS = 20_000;
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

function claimUniqueOption(seenOptions, option) {
  if (seenOptions.has(option)) throw new Error(`duplicate argument: ${option}`);
  seenOptions.add(option);
}

function parseArgs(argv) {
  const action = argv[0];
  const separator = argv.indexOf('--');
  const optionArgs = separator >= 0 ? argv.slice(1, separator) : argv.slice(1);
  const command = separator >= 0 ? argv.slice(separator + 1) : [];
  const options = { action, command, json: false };
  const seenOptions = new Set();
  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];
    if (arg === '--json') {
      claimUniqueOption(seenOptions, arg);
      options.json = true;
      continue;
    }
    if (arg === '--port' || arg === '--cwd' || arg === '--lifetime-seconds') {
      claimUniqueOption(seenOptions, arg);
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
  const id = previewProcessRecordId(cwd, port);
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
    if (value.version !== RECORD_VERSION || value.id !== config.id)
      throw new Error('preview registration is inconsistent');
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function ownsManagedProcess(config, record) {
  return record?.origin === 'launchd' ? ownsLaunchdProcess(config, record) : ownsProcess(record);
}

function report(config, payload, exitCode = 0) {
  if (config.json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  } else {
    process.stdout.write(`[preview-process] ${payload.status} ${payload.cwd}:${payload.port}`);
    if (payload.origin) process.stdout.write(`\norigin: ${payload.origin}`);
    if (payload.logPath) process.stdout.write(`\nlog: ${payload.logPath}`);
    if (payload.settlement) {
      process.stdout.write(`\noriginal process exit: ${payload.settlement.originalExitCode}`);
      process.stdout.write(`\nbusiness exit: ${payload.settlement.businessExitCode ?? 'unknown (legacy)'}`);
      process.stdout.write(`\ncleanup exit: ${payload.settlement.cleanupExitCode ?? 'unknown (legacy)'}`);
      if (payload.settlement.commandGroupStatus)
        process.stdout.write(`\ncommand group: ${payload.settlement.commandGroupStatus} (not a full-stop receipt)`);
      if (payload.settlement.otherResourcesStatus) process.stdout.write('\nother resources: not verified');
      process.stdout.write('\nsaved data: not reverified');
    }
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
    if (!existing.record.completionPath) rmSync(config.recordPath, { force: true });
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
  if (!record.completionPath && record.origin === 'launchd') {
    removeLaunchdJob(config);
    rmSync(config.plistPath, { force: true });
  }
  if (!record.completionPath) rmSync(config.recordPath, { force: true });
  throw new Error(`preview process exited before listening on port ${config.port}; see ${config.logPath}`);
}

async function start(config) {
  const existing = await currentStatus(config);
  if (await handleExistingStart(config, existing)) return;
  if (existing.record?.completionPath) {
    const completion = readPreviewCompletion(existing.record);
    if (
      !completion ||
      completion.exitCode !== 0 ||
      completion.forced ||
      completion.cleanupOwnerStatus === 'unclaimed' ||
      (completion.version !== undefined && completion.version !== 2)
    )
      throw new Error('preview cleanup remains unsettled; preserve its record and run canonical preview stop');
  }
  rmSync(config.recordPath, { force: true });
  clearPreviewSettlement(config);
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const expiresAt = new Date(Date.now() + config.lifetimeSeconds * 1_000).toISOString();
  const completionPath = join(config.stateDir, `${config.id}.${randomUUID()}.completion.json`);
  const launchConfig = {
    ...config,
    command: [
      process.execPath,
      LEASE_RUNNER_PATH,
      '--expires-at',
      expiresAt,
      '--completion-path',
      completionPath,
      '--',
      ...config.command,
    ],
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
    completionPath,
    logPath: config.logPath,
  };
  writeRecord(config, record);
  await finishStartedProcess(config, record);
}

async function status(config) {
  let result = await currentStatus(config);
  if (result.status === 'running' && result.record && !result.record.readyAt) {
    // This legacy lazy readiness write is a record writer too. It must not
    // resurrect an old registration while stop/start owns the same lifecycle.
    try {
      await withPreviewMutationLock(config, async () => {
        result = await currentStatus(config);
        if (result.status === 'running' && result.record && !result.record.readyAt)
          writeRecord(config, { ...result.record, readyAt: new Date().toISOString() });
      });
    } catch (error) {
      if (error.code !== 'PREVIEW_MUTATION_BUSY') throw error;
      result = await currentStatus(config);
    }
  }
  const settlement = !result.record ? readPreviewSettlement(config) : null;
  report(
    config,
    {
      status: result.status === 'stopped' ? (settlement?.status ?? result.status) : result.status,
      registered: result.record !== null,
      cwd: config.cwd,
      port: config.port,
      ...(settlement ? { settlement } : {}),
      ...(result.record
        ? {
            pid: result.record.pid,
            origin: result.record.origin ?? 'detached',
            logPath: result.record.logPath,
            expiresAt: result.record.expiresAt,
          }
        : {}),
    },
    settlement?.status === 'registration_retired'
      ? 3
      : result.status === 'running' || result.status === 'starting'
        ? 0
        : 1,
  );
}

async function stop(config) {
  let result;
  const stopped = await stopManagedPreview(config, async () => {
    result = await currentStatus(config);
    return result;
  });
  const settlement = stopped?.settlement ?? readPreviewSettlement(config);
  report(
    config,
    {
      status: settlement?.status ?? 'stopped',
      cwd: config.cwd,
      port: config.port,
      logPath: result.record?.logPath,
      ...(settlement ? { settlement } : {}),
    },
    settlement?.status === 'registration_retired' ? 3 : 0,
  );
}

try {
  const config = resolveConfig(parseArgs(process.argv.slice(2)));
  if (config.action === 'start') await withPreviewMutationLock(config, () => start(config));
  if (config.action === 'status') await status(config);
  if (config.action === 'stop') await stop(config);
} catch (error) {
  process.stderr.write(`[preview-process] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
