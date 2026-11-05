import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import {
  hasConflictingLaunchdProcess,
  hasRunningLaunchdJob,
  ownsLaunchdJob,
  ownsLaunchdProcess,
  ownsProcess,
  readProcessIdentity,
  removeLaunchdJob,
} from '../preview-process-launchers.mjs';
import { recoverFailedNamedAlphaCleanup } from './preview-alpha-cleanup-recovery.mjs';
import { recoveryPathExists, sameRecoveryFile, syncRecoveryDirectory } from './preview-alpha-recovery-evidence.mjs';
import { settleStoppedNamedAlphaRegistration } from './preview-alpha-registration-settlement.mjs';
import { cleanupOwnerResultPath } from './preview-cleanup-result.mjs';
import { previewCommandIdentityPath } from './preview-command-identity.mjs';
import { settleCompletedPreviewRegistration } from './preview-completed-registration-settlement.mjs';
import { settleExpiredNamedAlphaLease } from './preview-expired-lease-settlement.mjs';
import { ordinaryRetirementCandidate, retireUnclaimedOrdinaryRegistration } from './preview-ordinary-retirement.mjs';
import { withPreviewMutationLock } from './preview-process-mutex.mjs';
import { processGroupExists, waitForPort, waitForProcessGroupExit } from './preview-process-runtime.mjs';
import { retireUnclaimedAlphaRegistration } from './preview-unclaimed-registration.mjs';

// The runner owns a 30-second drain and a one-second force window. Its caller
// must outlive both; it never bootouts a live runner or kills its cleanup early.
const COMPLETION_TIMEOUT_MS = 35_000;

function ownsRunner(config, record) {
  return record.origin === 'launchd' ? ownsLaunchdProcess(config, record) : ownsProcess(record);
}

export function readPreviewCompletion(record) {
  try {
    const value = JSON.parse(readFileSync(record.completionPath, 'utf8'));
    if (
      value.pid === record.pid &&
      value.expiresAt === record.expiresAt &&
      Number.isInteger(value.exitCode) &&
      typeof value.forced === 'boolean'
    )
      return value;
  } catch {}
  return null;
}

function signalOwnedRunner(config, record) {
  const identity = readProcessIdentity(record.pid);
  if (
    (record.origin === 'launchd' && hasConflictingLaunchdProcess(config, record)) ||
    (identity &&
      (identity.processStartedAt !== record.processStartedAt || identity.processCommand !== record.processCommand))
  ) {
    throw new Error('refusing to stop preview: exact process ownership is not proven');
  }
  if (identity && !readPreviewCompletion(record)) {
    // POSIX signals only the supervisor; it owns the command group's drain.
    try {
      // Windows SIGTERM terminates Node immediately; it cannot run the
      // supervisor's POSIX drain handler. Kill the proven owned tree, but
      // retain the missing receipt below instead of certifying resource cleanup.
      if (process.platform === 'win32') {
        const killed = spawnSync('taskkill.exe', ['/PID', String(record.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        if (killed.status !== 0 && processGroupExists(record)) throw new Error('owned preview tree did not stop');
        return;
      }
      process.kill(record.pid, 'SIGTERM');
    } catch (error) {
      // Expiry can finish between the identity read and this signal. Its
      // completion receipt still has to pass below; absence is never success.
      if (error?.code !== 'ESRCH') throw error;
    }
  }
}

function runnerIsActive(config, record) {
  return ownsRunner(config, record) || (record.origin === 'launchd' && hasRunningLaunchdJob(config, record));
}

async function stopWithCompletion(config, record) {
  signalOwnedRunner(config, record);
  const deadline = Date.now() + COMPLETION_TIMEOUT_MS;
  while (runnerIsActive(config, record) && Date.now() < deadline) {
    if (record.origin === 'launchd' && hasConflictingLaunchdProcess(config, record)) {
      throw new Error(`preview launchd job changed; state retained at ${config.recordPath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const completion = readPreviewCompletion(record);
  const explicitCleanup =
    completion?.version === 2 && completion.cleanupOwnerStatus === 'complete' && completion.cleanupExitCode === 0;
  const unclaimed = ordinaryRetirementCandidate(config, record, completion);
  if (
    runnerIsActive(config, record) ||
    !completion ||
    (completion.version !== undefined && completion.version !== 2) ||
    (completion.cleanupOwnerStatus === 'unclaimed' && !unclaimed) ||
    (completion.exitCode !== 0 && !explicitCleanup && !unclaimed) ||
    (completion.version === 2 && completion.cleanupExitCode !== null && !explicitCleanup) ||
    completion.forced
  ) {
    throw new Error(`preview cleanup incomplete or failed; state retained at ${config.recordPath}`);
  }
  if (!(await waitForPort(config.port, false, 1_000))) {
    throw new Error(`port ${config.port} remains occupied after cleanup; state retained at ${config.recordPath}`);
  }
  return completion;
}

function killOwnedGroup(record, signal, ownershipAlreadyProven = false) {
  if (!ownershipAlreadyProven && !ownsProcess(record)) return false;
  try {
    if (process.platform === 'win32') {
      return (
        spawnSync('taskkill.exe', ['/PID', String(record.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          .status === 0
      );
    }
    process.kill(-record.pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function stopLegacy(config, { record, status }) {
  if (status === 'stopped' && record.origin === 'launchd' && ownsLaunchdJob(config, record)) {
    // Older runners have no cleanup receipt; a dead process is not enough to
    // retroactively claim their Redis cleanup succeeded.
    throw new Error(`legacy preview has no cleanup completion evidence; state retained at ${config.recordPath}`);
  }
  if (!ownsRunner(config, record)) {
    throw new Error(`refusing to stop ${status} port ${config.port}: exact process ownership is not proven`);
  }
  if (record.origin === 'launchd') {
    process.kill(record.pid, 'SIGTERM');
    await waitForProcessGroupExit(record, COMPLETION_TIMEOUT_MS);
    throw new Error(`legacy preview has no cleanup completion evidence; state retained at ${config.recordPath}`);
  }
  killOwnedGroup(record, 'SIGTERM');
  if (!(await waitForProcessGroupExit(record, 3_000))) {
    killOwnedGroup(record, 'SIGKILL', true);
    await waitForProcessGroupExit(record, 1_000);
  }
  if (processGroupExists(record) || !(await waitForPort(config.port, false, 1_000))) {
    throw new Error(`failed to stop owned preview process group ${record.pid}; state retained at ${config.recordPath}`);
  }
}

async function stopLocked(config, result, { recovery } = {}) {
  const { record, status } = result;
  if (!record && status === 'stopped') return;
  if (!record) throw new Error(`refusing to stop ${status} port ${config.port}: exact process ownership is not proven`);
  let recovered;
  let settlement;
  let verifySettlement;
  const finishFailed = async () => {
    // Existing Redis recovery journals retain their original non-replay and
    // saved-result semantics. A no-lease settlement never downgrades them.
    const retired = recoveryPathExists(`${record.completionPath}.recovery`)
      ? null
      : await settleStoppedNamedAlphaRegistration(config, record, recovery);
    if (retired) {
      recovered = retired.record;
      settlement = retired.summary;
      verifySettlement = retired.assertReadyToRelease;
    } else recovered = await recoverFailedNamedAlphaCleanup(config, record, recovery);
  };
  const completion = record.completionPath && readPreviewCompletion(record);
  const finishOrdinary = async () => {
    const retired = await retireUnclaimedOrdinaryRegistration(config, record, recovery);
    return releaseRegistration(config, record, retired.record, retired.summary, retired.assertReadyToRelease);
  };
  if (ordinaryRetirementCandidate(config, record, completion)) return finishOrdinary();
  if (completion?.cleanupOwnerStatus === 'unclaimed' && record.command?.includes('--instance'))
    return retireUnclaimedAlphaRegistration(config, record, recovery ?? {}, (retired) =>
      releaseRegistration(config, record, retired.record, retired.summary, retired.assertReadyToRelease),
    );
  if (completion?.exitCode > 0 && !completion.forced && record.command?.includes('--instance')) {
    const expired = await settleExpiredNamedAlphaLease(config, record, recovery ?? {}, (retired) =>
      releaseRegistration(config, record, retired.record, retired.summary, retired.assertReadyToRelease),
    );
    if (expired) return expired.result;
    await finishFailed();
  } else if (record.completionPath) {
    const completed = await stopWithCompletion(config, record);
    if (ordinaryRetirementCandidate(config, record, completed)) return finishOrdinary();
    if (completed.exitCode !== 0) {
      if (record.command?.includes('--instance')) await finishFailed();
      else {
        const retired = settleCompletedPreviewRegistration(config, record, recovery);
        recovered = retired.record;
        settlement = retired.summary;
        verifySettlement = retired.assertReadyToRelease;
      }
    }
  } else await stopLegacy(config, result);
  return releaseRegistration(config, record, recovered, settlement, verifySettlement);
}

function releaseRegistration(config, record, recovered, settlement, verifySettlement) {
  if (recovered) sameRecoveryFile(recovered);
  if (record.origin === 'launchd') {
    removeLaunchdJob(config);
    if (!settlement) rmSync(config.plistPath, { force: true });
  }
  verifySettlement?.();
  rmSync(config.recordPath, { force: true });
  if (settlement && record.origin === 'launchd') rmSync(config.plistPath, { force: true });
  if (settlement) syncRecoveryDirectory(config.stateDir);
  if (record.completionPath && !recovered) {
    rmSync(record.completionPath, { force: true });
    rmSync(cleanupOwnerResultPath(record.completionPath), { force: true });
    rmSync(previewCommandIdentityPath(record.completionPath), { force: true });
  }
  return settlement ? { settlement } : undefined;
}

export async function stopManagedPreview(config, result, deps = {}) {
  if (typeof result !== 'function' && !result.record && result.status === 'stopped') return;
  return withPreviewMutationLock(config, async () => {
    const current = typeof result === 'function' ? await result() : result;
    if (
      current.record &&
      JSON.stringify(JSON.parse(readFileSync(config.recordPath, 'utf8'))) !== JSON.stringify(current.record)
    )
      throw new Error('preview record changed before its stop acquired ownership');
    return stopLocked(config, current, deps);
  });
}
