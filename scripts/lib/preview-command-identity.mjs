import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import {
  recoveryFile,
  recoveryHash,
  recoveryPathExists,
  writeRecoveryBytes,
} from './preview-alpha-recovery-evidence.mjs';
import { recoveryGroupRunning } from './preview-alpha-recovery-observation.mjs';
import { readProcBirth } from './process-birth-identity.mjs';

export const previewCommandIdentityPath = (completionPath) => `${completionPath}.command.json`;

/** Bounded kernel observation at spawn; the requested argv is not identity proof. */
export function observePreviewCommand(pid, parentPid, run = spawnSync) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || process.platform === 'win32') return null;
  const result = run('ps', ['-ww', '-p', String(pid), '-o', 'pid=,ppid=,pgid=,stat=,lstart=,command='], {
    encoding: 'utf8',
    timeout: 2000,
    maxBuffer: 32768,
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
  });
  const match = result.stdout
    ?.trim()
    .match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+([^\n]+)$/);
  if (
    result.error ||
    result.signal ||
    result.status !== 0 ||
    result.stderr?.trim() ||
    !match ||
    Number(match[1]) !== pid ||
    Number(match[2]) !== parentPid ||
    Number(match[3]) !== pid ||
    match[4].startsWith('Z')
  )
    return null;
  const time = Date.parse(`${match[5].replace(/\s+/g, ' ')} UTC`);
  if (!Number.isFinite(time)) return null;
  const startedAt = new Date(time).toISOString();
  return { parentPid, processGroupId: Number(match[3]), startedAt, command: match[6], ...readProcBirth(pid) };
}

export function recordPreviewCommand(
  { completionPath, expiresAt, command, childPid },
  observe = observePreviewCommand,
) {
  const identity = observe(childPid, process.pid);
  const bytes = Buffer.from(
    `${JSON.stringify({
      v: 1,
      kind: 'preview-command-identity',
      completionPath,
      supervisorPid: process.pid,
      expiresAt,
      command,
      launchCwd: process.cwd(),
      pid: childPid ?? null,
      processGroupId: identity?.processGroupId ?? null,
      identityStatus: identity ? 'observed' : 'unknown',
      identity,
      recordedAt: new Date().toISOString(),
    })}\n`,
  );
  const path = previewCommandIdentityPath(completionPath);
  writeRecoveryBytes(path, bytes);
  return { path, sha256: recoveryHash(bytes), processGroupId: identity?.processGroupId ?? null };
}

export function previewCommandGroupStatus(receipt, read = recoveryGroupRunning) {
  if (!receipt?.processGroupId) return 'unknown';
  try {
    const running = read(receipt.processGroupId);
    return running === true ? 'present' : running === false ? 'absent' : 'unknown';
  } catch {
    return 'unknown';
  }
}

function sameLaunchDirectory(recorded, observed) {
  if (typeof recorded !== 'string' || typeof observed !== 'string') return false;
  // Node's cwd is physical; canonical callers may retain an OS directory alias.
  // Preserve identical legacy spelling, otherwise require current physical equality.
  return recorded === observed || realpathSync(recorded) === realpathSync(observed);
}

export function readBoundPreviewCommand(record, completion) {
  const path = previewCommandIdentityPath(record.completionPath);
  if (!completion.commandIdentity && !recoveryPathExists(path)) return null; // Legacy gap stays explicit.
  const snapshot = recoveryFile(path);
  const value = snapshot.value;
  if (
    completion.commandIdentity?.path !== path ||
    completion.commandIdentity.sha256 !== snapshot.sha256 ||
    value.v !== 1 ||
    value.kind !== 'preview-command-identity' ||
    value.completionPath !== record.completionPath ||
    value.supervisorPid !== record.pid ||
    value.expiresAt !== record.expiresAt ||
    !sameLaunchDirectory(record.cwd, value.launchCwd) ||
    JSON.stringify(value.command) !== JSON.stringify(record.command) ||
    !['observed', 'unknown'].includes(value.identityStatus) ||
    (value.identityStatus === 'observed'
      ? !Number.isSafeInteger(value.pid) ||
        value.pid <= 1 ||
        value.processGroupId !== value.pid ||
        value.identity?.processGroupId !== value.pid ||
        value.identity.parentPid !== record.pid ||
        !Number.isFinite(Date.parse(value.identity.startedAt))
      : value.identity !== null || value.processGroupId !== null) ||
    !['present', 'absent', 'unknown'].includes(completion.commandGroupStatus)
  )
    throw new Error('preview command birth receipt does not belong to this nonce');
  return snapshot;
}
