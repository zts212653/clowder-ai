#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  captureProcessIdentity,
  captureReadableIdentity,
  compareStoredIdentity,
  identityInspectionIsUnreadable,
  observeProcessIdentity,
  spawnedIdentityRefusal,
  waitUntilIdentityGone,
} from './process-identity.mjs';

export { captureProcessIdentity } from './process-identity.mjs';

const STATE_VERSION = 1;

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

export function writeDaemonState({
  paths,
  pid,
  projectRoot,
  deploymentId,
  launchToken,
  logFile,
  ports,
  captureIdentity = captureProcessIdentity,
}) {
  let identity;
  try {
    identity = captureReadableIdentity(pid, { capture: captureIdentity });
  } catch (error) {
    throw new DaemonStateError(error.reason ?? 'spawned-process-identity-unreadable', error.message, error.details);
  }
  const expectedRoot = canonicalPath(projectRoot);
  const refusal = spawnedIdentityRefusal(pid, identity, expectedRoot, launchToken);
  if (refusal) throw new DaemonStateError(refusal.reason, refusal.message, refusal.details);
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

export function inspectDaemonState({
  stateFile,
  expectedProjectRoot,
  expectedDeploymentId,
  captureIdentity = captureProcessIdentity,
}) {
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

  const observed = observeProcessIdentity(state.pid, captureIdentity);
  if (observed.status === 'absent') {
    return { kind: 'stale', reason: 'process-not-running', state };
  }
  if (observed.status === 'unknown') {
    return { kind: 'mismatch', reason: 'process-identity-unreadable', state, error: observed.error };
  }
  const identity = observed.identity;
  const comparison = compareStoredIdentity(state, identity);
  if (comparison !== 'match') {
    const reason = comparison === 'unknown' ? 'process-argv-unavailable' : 'process-identity-mismatch';
    return { kind: 'mismatch', reason, state, identity };
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

function refuseUnverifiedStop(paths, pid) {
  appendAudit(paths, { action: 'stop', outcome: 'unverifiable', pid });
  throw new DaemonStateError('stop-outcome-unknown', `Cannot tell whether PID ${pid} exited`, { pid });
}

/**
 * @param expectedIdentity F300: the exact daemon incarnation the caller opened
 * against. This primitive picks its target by re-reading the state file, so a
 * caller that verified the identity a moment earlier has verified nothing
 * unless the constraint travels with the call -- a legitimate writer can swap
 * the record in between and the signal lands on a daemon nobody authorized.
 */
function matchesExpectedIdentity(expected, state, identity) {
  if (expected.pid !== state.pid) return false;
  if (expected.startedAt && identity?.startedAt && expected.startedAt !== identity.startedAt) return false;
  return !(expected.command && identity?.command && expected.command !== identity.command);
}

export async function stopDaemon({
  paths,
  expectedProjectRoot,
  expectedDeploymentId,
  graceMs = 15_000,
  expectedIdentity,
  captureIdentity = captureProcessIdentity,
}) {
  const inspection = inspectDaemonState({
    stateFile: paths.stateFile,
    expectedProjectRoot,
    expectedDeploymentId,
    captureIdentity,
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
  if (expectedIdentity && !matchesExpectedIdentity(expectedIdentity, state, inspection.identity)) {
    throw new DaemonStateError(
      'target-identity-changed',
      `Daemon at ${paths.stateFile} is no longer the incarnation this stop was opened against`,
      { expected: expectedIdentity, actual: { pid: state.pid, startedAt: inspection.identity?.startedAt } },
    );
  }
  process.kill(state.pid, 'SIGTERM');
  let forced = false;
  if (!(await waitUntilIdentityGone(state, graceMs, captureIdentity))) {
    const beforeKill = inspectDaemonState({
      stateFile: paths.stateFile,
      expectedProjectRoot,
      expectedDeploymentId,
      captureIdentity,
    });
    if (beforeKill.kind === 'running') {
      process.kill(state.pid, 'SIGKILL');
      forced = true;
      if (!(await waitUntilIdentityGone(state, 1_000, captureIdentity))) refuseUnverifiedStop(paths, state.pid);
    } else if (identityInspectionIsUnreadable(beforeKill)) {
      // Signalled, but we cannot see whether it exited: keep the state and claim nothing.
      refuseUnverifiedStop(paths, state.pid);
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
  const observed = observeProcessIdentity(pid);
  if (observed.status === 'absent') {
    return { outcome: 'skipped', reason: 'legacy-process-not-running' };
  }
  if (observed.status === 'unknown') return { outcome: 'skipped', reason: 'legacy-process-identity-unreadable' };
  const identity = observed.identity;
  const expectedRoot = canonicalPath(expectedProjectRoot);
  if (identity.cwd !== expectedRoot) {
    return skipLegacyMigration(paths, 'legacy-owner-mismatch', { pid, foreignCwd: identity.cwd });
  }
  if (identity.argvAvailable === false) return { outcome: 'skipped', reason: 'legacy-process-identity-unreadable' };
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
