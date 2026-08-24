#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const STATE_VERSION = 1;
const TOKEN_ARG = '--cat-cafe-daemon-token=';

export class DaemonStateError extends Error {
  constructor(reason, message, details = {}) {
    super(message);
    this.name = 'DaemonStateError';
    this.reason = reason;
    this.details = details;
  }
}

function canonicalPath(path) {
  return realpathSync(resolve(path));
}

function validateDeploymentId(deploymentId) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(deploymentId)) {
    throw new DaemonStateError('invalid-deployment-id', `Invalid deployment id: ${deploymentId}`);
  }
}

export function daemonStatePaths({ homeDir = homedir(), projectRoot, deploymentId }) {
  validateDeploymentId(deploymentId);
  const canonicalRoot = canonicalPath(projectRoot);
  const rootHash = createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 12);
  const namespaceDir = join(resolve(homeDir), '.cat-cafe', 'daemons', `${deploymentId}-${rootHash}`);
  return {
    namespaceDir,
    stateFile: join(namespaceDir, 'daemon.json'),
    auditFile: join(namespaceDir, 'stop-audit.jsonl'),
  };
}

function psField(pid, field) {
  return execFileSync('ps', ['-p', String(pid), '-o', `${field}=`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function processCwd(pid) {
  const procCwd = `/proc/${pid}/cwd`;
  try {
    return canonicalPath(readlinkSync(procCwd));
  } catch {
    const output = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const cwd = output
      .split('\n')
      .find((line) => line.startsWith('n'))
      ?.slice(1);
    if (!cwd) throw new Error(`Cannot resolve cwd for PID ${pid}`);
    return canonicalPath(cwd);
  }
}

export function captureProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`Invalid PID: ${pid}`);
  process.kill(pid, 0);
  const startedAt = psField(pid, 'lstart').replace(/\s+/g, ' ');
  const command = psField(pid, 'command');
  if (!startedAt || !command) throw new Error(`Cannot inspect PID ${pid}`);
  return { startedAt, command, cwd: processCwd(pid) };
}

function atomicWriteJson(file, value) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tempFile = `${file}.${process.pid}.tmp`;
  writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tempFile, file);
}

function appendAudit(paths, event) {
  mkdirSync(paths.namespaceDir, { recursive: true, mode: 0o700 });
  appendFileSync(paths.auditFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, {
    mode: 0o600,
  });
}

function stateFromIdentity({
  pid,
  identity,
  projectRoot,
  deploymentId,
  launchToken,
  logFile,
  ports,
  legacyMigrated = false,
}) {
  return {
    version: STATE_VERSION,
    deploymentId,
    projectRoot: canonicalPath(projectRoot),
    pid,
    process: { ...identity, launchToken },
    ports,
    logFile: resolve(logFile),
    launchedAt: new Date().toISOString(),
    legacyMigrated,
  };
}

export function writeDaemonState({ paths, pid, projectRoot, deploymentId, launchToken, logFile, ports }) {
  const identity = captureProcessIdentity(pid);
  const expectedRoot = canonicalPath(projectRoot);
  if (identity.cwd !== expectedRoot || !identity.command.includes(`${TOKEN_ARG}${launchToken}`)) {
    throw new DaemonStateError(
      'spawned-process-identity-mismatch',
      `PID ${pid} is not the daemon spawned for ${expectedRoot}`,
    );
  }
  const state = stateFromIdentity({
    pid,
    identity,
    projectRoot: expectedRoot,
    deploymentId,
    launchToken,
    logFile,
    ports,
  });
  atomicWriteJson(paths.stateFile, state);
  return state;
}

function parseState(stateFile) {
  try {
    return JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch (error) {
    throw new DaemonStateError('malformed-state', `Cannot parse daemon state ${stateFile}`, {
      cause: error.message,
    });
  }
}

function identityMatches(state, identity) {
  const stored = state.process;
  if (!stored || stored.startedAt !== identity.startedAt || stored.cwd !== identity.cwd) return false;
  if (stored.command !== identity.command) return false;
  return !stored.launchToken || identity.command.includes(`${TOKEN_ARG}${stored.launchToken}`);
}

function isLegacyDaemonCommand(command, expectedRoot) {
  const match = command.match(/^(?:\S*\/)?(?:ba|z)?sh\s+(\S*scripts\/start-dev\.sh)(?:\s|$)/);
  if (!match) return false;
  try {
    return canonicalPath(resolve(expectedRoot, match[1])) === join(expectedRoot, 'scripts', 'start-dev.sh');
  } catch {
    return false;
  }
}

function skipLegacyMigration(paths, reason, details) {
  appendAudit(paths, { action: 'migrate-legacy', outcome: 'skipped', reason, ...details });
  return { outcome: 'skipped', reason, ...details };
}

export function inspectDaemonState({ stateFile, expectedProjectRoot, expectedDeploymentId }) {
  if (!existsSync(stateFile)) return { kind: 'missing' };
  let state;
  try {
    state = parseState(stateFile);
  } catch (error) {
    return { kind: 'invalid', reason: error.reason, error };
  }

  const expectedRoot = canonicalPath(expectedProjectRoot);
  if (
    state.version !== STATE_VERSION ||
    state.projectRoot !== expectedRoot ||
    state.deploymentId !== expectedDeploymentId ||
    !Number.isSafeInteger(state.pid) ||
    state.pid <= 1
  ) {
    return { kind: 'mismatch', reason: 'state-owner-mismatch', state };
  }

  let identity;
  try {
    identity = captureProcessIdentity(state.pid);
  } catch {
    return { kind: 'stale', reason: 'process-not-running', state };
  }
  if (!identityMatches(state, identity)) {
    return { kind: 'mismatch', reason: 'process-identity-mismatch', state, identity };
  }
  return { kind: 'running', state, identity };
}

export function refusalFromInspection(inspection) {
  const reason = inspection.kind === 'missing' ? 'no-state' : (inspection.reason ?? 'unsafe-state');
  return new DaemonStateError(reason, `Refusing daemon operation: ${reason}`, { inspection });
}

export function prepareDaemonStart({ paths, expectedProjectRoot, expectedDeploymentId }) {
  const inspection = inspectDaemonState({
    stateFile: paths.stateFile,
    expectedProjectRoot,
    expectedDeploymentId,
  });
  if (inspection.kind === 'missing') return { outcome: 'ready' };
  if (inspection.kind === 'stale') {
    rmSync(paths.stateFile, { force: true });
    appendAudit(paths, { action: 'prepare', outcome: 'stale-cleared', pid: inspection.state?.pid });
    return { outcome: 'stale-cleared' };
  }
  if (inspection.kind === 'running') {
    throw new DaemonStateError('already-running', `Daemon is already running (PID ${inspection.state.pid})`, {
      inspection,
    });
  }
  appendAudit(paths, { action: 'prepare', outcome: 'refused', reason: inspection.reason });
  throw refusalFromInspection(inspection);
}

const delay = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function waitUntilIdentityGone(state, graceMs) {
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    try {
      if (!identityMatches(state, captureProcessIdentity(state.pid))) return true;
    } catch {
      return true;
    }
    await delay(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  return false;
}

export async function stopDaemon({ paths, expectedProjectRoot, expectedDeploymentId, graceMs = 15_000 }) {
  const inspection = inspectDaemonState({
    stateFile: paths.stateFile,
    expectedProjectRoot,
    expectedDeploymentId,
  });
  if (inspection.kind === 'missing') throw new DaemonStateError('no-state', `No daemon state: ${paths.stateFile}`);
  if (inspection.kind === 'stale') {
    rmSync(paths.stateFile, { force: true });
    appendAudit(paths, { action: 'stop', outcome: 'stale-cleared', pid: inspection.state?.pid });
    return { outcome: 'stale-cleared', pid: inspection.state?.pid };
  }
  if (inspection.kind !== 'running') {
    appendAudit(paths, { action: 'stop', outcome: 'refused', reason: inspection.reason });
    throw refusalFromInspection(inspection);
  }

  const { state } = inspection;
  process.kill(state.pid, 'SIGTERM');
  let forced = false;
  if (!(await waitUntilIdentityGone(state, graceMs))) {
    const beforeKill = inspectDaemonState({
      stateFile: paths.stateFile,
      expectedProjectRoot,
      expectedDeploymentId,
    });
    if (beforeKill.kind === 'running') {
      process.kill(state.pid, 'SIGKILL');
      forced = true;
      await waitUntilIdentityGone(state, 1_000);
    }
  }
  rmSync(paths.stateFile, { force: true });
  appendAudit(paths, { action: 'stop', outcome: 'terminated', pid: state.pid, forced });
  return { outcome: 'terminated', pid: state.pid, forced, logFile: state.logFile };
}

export function migrateLegacyDaemonState({
  paths,
  legacyPidFile,
  legacyLogPathFile,
  expectedProjectRoot,
  expectedDeploymentId,
}) {
  if (expectedDeploymentId !== 'runtime') return { outcome: 'skipped', reason: 'legacy-runtime-only' };
  if (existsSync(paths.stateFile)) return { outcome: 'skipped', reason: 'namespaced-state-exists' };
  if (!existsSync(legacyPidFile)) return { outcome: 'skipped', reason: 'legacy-state-missing' };

  const pid = Number.parseInt(readFileSync(legacyPidFile, 'utf8').trim(), 10);
  let identity;
  try {
    identity = captureProcessIdentity(pid);
  } catch {
    return { outcome: 'skipped', reason: 'legacy-process-not-running' };
  }
  const expectedRoot = canonicalPath(expectedProjectRoot);
  if (identity.cwd !== expectedRoot) {
    return skipLegacyMigration(paths, 'legacy-owner-mismatch', { pid, foreignCwd: identity.cwd });
  }
  if (!isLegacyDaemonCommand(identity.command, expectedRoot)) {
    return skipLegacyMigration(paths, 'legacy-command-mismatch', { pid });
  }
  const logFile = existsSync(legacyLogPathFile)
    ? readFileSync(legacyLogPathFile, 'utf8').trim()
    : join(expectedRoot, 'cat-cafe-daemon.log');
  const state = stateFromIdentity({
    pid,
    identity,
    projectRoot: expectedRoot,
    deploymentId: 'runtime',
    launchToken: null,
    logFile,
    ports: {},
    legacyMigrated: true,
  });
  atomicWriteJson(paths.stateFile, state);
  rmSync(legacyPidFile, { force: true });
  rmSync(legacyLogPathFile, { force: true });
  appendAudit(paths, { action: 'migrate-legacy', outcome: 'migrated', pid });
  return { outcome: 'migrated', pid };
}
