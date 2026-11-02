import { readFileSync } from 'node:fs';

export function cleanupOwnerResultPath(completionPath) {
  return completionPath ? `${completionPath}.owner.json` : null;
}

/** A failed command with no cleanup claim is never a successful cleanup receipt. */
export function isUnclaimedPreviewFailure(completion) {
  const code = (number) => Number.isInteger(number) && number >= 1 && number <= 255;
  return (
    completion?.version === 2 &&
    completion.forced === false &&
    completion.cleanupOwnerStatus === 'unclaimed' &&
    completion.cleanupExitCode === null &&
    code(completion.commandExitCode) &&
    completion.exitCode === completion.commandExitCode &&
    completion.runnerExitCode === completion.commandExitCode
  );
}

/** Known old/current ordinary receipts; missing version never launders damaged v2 fields. */
export function ordinaryUnclaimedReceiptFormat(value) {
  const code = (n) => Number.isInteger(n) && n >= 0 && n <= 255;
  if (!value || value.forced !== false || value.cleanupOwnerStatus !== 'unclaimed' || !code(value.exitCode))
    return null;
  const legacy = ['pid', 'expiresAt', 'exitCode', 'forced', 'cleanupOwnerStatus', 'completedAt'];
  if (!Object.hasOwn(value, 'version'))
    return Object.keys(value).length === legacy.length && legacy.every((k) => Object.hasOwn(value, k))
      ? 'legacy'
      : null;
  const required = [...legacy, 'version', 'commandExitCode', 'runnerExitCode', 'cleanupExitCode'];
  const allowed = [...required, 'commandIdentity', 'commandGroupStatus'];
  if (
    value.version !== 2 ||
    !required.every((k) => Object.hasOwn(value, k)) ||
    Object.keys(value).some((k) => !allowed.includes(k)) ||
    value.cleanupExitCode !== null ||
    (value.commandExitCode !== null && !code(value.commandExitCode)) ||
    value.commandExitCode !== value.runnerExitCode ||
    Object.hasOwn(value, 'commandIdentity') !== Object.hasOwn(value, 'commandGroupStatus') ||
    (Object.hasOwn(value, 'commandGroupStatus') && !['present', 'absent', 'unknown'].includes(value.commandGroupStatus))
  )
    return null;
  return 'v2';
}

export function readCleanupOwnerResult(path, processGroupId) {
  if (!path) return { status: 'unclaimed' };
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      value.processGroupId === processGroupId &&
      Number.isInteger(value.exitCode) &&
      value.exitCode >= 0 &&
      value.exitCode <= 255
    ) {
      if (value.version === undefined) return { status: 'complete', exitCode: value.exitCode, cleanupExitCode: null };
      if (
        value.version === 2 &&
        value.cleanupExitCode === value.exitCode &&
        Number.isInteger(value.commandExitCode) &&
        value.commandExitCode >= 0 &&
        value.commandExitCode <= 255
      )
        return {
          status: 'complete',
          version: 2,
          exitCode: value.exitCode,
          cleanupExitCode: value.cleanupExitCode,
          commandExitCode: value.commandExitCode,
        };
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'unclaimed' };
  }
  return { status: 'unproven' };
}

function reportedCleanupExitCode({ outcome, owner, shutdownRequested }) {
  if (owner.exitCode !== 0) return owner.exitCode;
  // A shell/pnpm wrapper can exit zero after the actual owner failed. Keep
  // the owner's explicit business result instead of laundering that failure.
  if (owner.version === 2 && ![0, 130, 143].includes(owner.commandExitCode)) return owner.commandExitCode;
  const expectedStop =
    shutdownRequested && (['SIGTERM', 'SIGINT'].includes(outcome.signal) || [130, 143].includes(outcome.code));
  return expectedStop ? 0 : owner.version === 2 ? owner.commandExitCode || (outcome.code ?? 1) : (outcome.code ?? 1);
}

export function previewCleanupExitCode({
  outcome,
  graceful,
  owner,
  descendantsRemain,
  shutdownRequested,
  requireOwnerResult,
}) {
  if (!graceful || owner.status === 'unproven') return 1;
  if (owner.status === 'complete') return reportedCleanupExitCode({ outcome, owner, shutdownRequested });
  // Managed launches require their owner's result on requested shutdown.
  // No process snapshot or wrapper exit (even zero) proves cleanup succeeded.
  if (descendantsRemain) return 1;
  if (shutdownRequested) {
    if (requireOwnerResult) return 1;
    // Bare legacy runner invocations have no completion record and retain only
    // their process-termination contract, never a resource-cleanup promise.
    const expectedSignal = ['SIGTERM', 'SIGINT'].includes(outcome.signal);
    return expectedSignal ? 0 : (outcome.code ?? 1);
  }
  // Natural command completion retains its exit status, not a cleanup promise.
  return outcome.code ?? 1;
}
