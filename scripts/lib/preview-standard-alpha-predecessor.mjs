import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { recoveryFile, recoveryPathExists } from './preview-alpha-recovery-evidence.mjs';
import { recoveryGroupRunning } from './preview-alpha-recovery-observation.mjs';
import { isProcessRunning } from './process-tree.mjs';

function isQuiescentLaunchdPredecessor(config, otherId, other, read = execFileSync) {
  if (other.origin === undefined || other.origin === 'detached') return true;
  if (other.origin !== 'launchd' || process.platform !== 'darwin') return false;
  const label = `com.catcafe.preview.${otherId}`;
  const plistPath = join(config.stateDir, `${otherId}.plist`);
  if (other.id !== otherId || other.launchdLabel !== label || other.plistPath !== plistPath) return false;
  let out;
  try {
    out = read('launchctl', ['print', `gui/${process.getuid()}/${label}`], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    return err?.status === 113 && /Could not find service/.test(String(err.stderr));
  }
  if (/^\s*pid =/m.test(out) || !/^\s*state = not running\s*$/m.test(out)) return false;
  try {
    if (realpathSync(plistPath) !== plistPath) return false;
    const plist = JSON.parse(
      read('plutil', ['-convert', 'json', '-o', '-', plistPath], {
        encoding: 'utf8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    return plist?.KeepAlive === false && plist?.Label === label;
  } catch {
    return false;
  }
}

function isQuiescentSidecar(path, kind, checkPid, checkGroup) {
  if (!recoveryPathExists(path)) return true;
  const v = recoveryFile(path).value;
  if (kind === 'command' && v?.identityStatus === 'unknown') return true;
  if (kind === 'command' && v?.identityStatus !== 'observed') return false;
  return (
    Number.isSafeInteger(v?.pid) &&
    v.pid > 1 &&
    Number.isSafeInteger(v?.processGroupId) &&
    v.processGroupId > 1 &&
    checkPid(v.pid) === false &&
    checkGroup(v.processGroupId) === false
  );
}

export function isQuiescentHistoricalPredecessor(config, record, otherId, other, deps = {}) {
  const targetStartMs = Date.parse(record?.startedAt);
  const otherStartMs = Date.parse(other?.startedAt);
  const checkPid = deps.isRunning ?? isProcessRunning;
  const checkGroup = deps.groupRunning ?? recoveryGroupRunning;
  if (
    !Number.isFinite(targetStartMs) ||
    !Number.isFinite(otherStartMs) ||
    otherStartMs >= targetStartMs ||
    !Number.isSafeInteger(other.pid) ||
    other.pid <= 1 ||
    checkPid(other.pid) !== false ||
    checkGroup(other.pid) !== false
  )
    return false;
  if (other.completionPath !== undefined) {
    if (typeof other.completionPath !== 'string' || !other.completionPath) return false;
    if (
      !isQuiescentSidecar(`${other.completionPath}.owner.json`, 'owner', checkPid, checkGroup) ||
      !isQuiescentSidecar(`${other.completionPath}.command.json`, 'command', checkPid, checkGroup)
    )
      return false;
  }
  return isQuiescentLaunchdPredecessor(config, otherId, other, deps.readJob);
}
