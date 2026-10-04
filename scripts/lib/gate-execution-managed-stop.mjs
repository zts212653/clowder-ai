import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

// Capture only at cancellation admission, while the attempt binding is present.
// Later discovery of a file must never retroactively authorize an old SIGTERM.
export function captureManagedGateStop(job, binding, now) {
  if (!binding) return null;
  try {
    const { readyPath, managedJobId, originTaskId, attemptToken } = binding;
    if (
      !path.isAbsolute(readyPath) ||
      !uuid.test(attemptToken) ||
      path.basename(readyPath) !== `${managedJobId}.attempt-${attemptToken}.recovery-ready.json`
    )
      return null;
    const root = path.dirname(readyPath);
    const cancelPath = path.join(root, `${managedJobId}.json.cancel-request`);
    if (existsSync(cancelPath)) return null;
    const ready = readJson(readyPath);
    const intentPath = `${readyPath}.stop-intent.json`;
    const intent = readJson(intentPath);
    const projection = readJson(path.join(root, `${managedJobId}.gate.json`));
    const owner = readJson(path.join(root, `${managedJobId}.json`));
    const plan = JSON.parse(job.plan_json);
    if (
      ready.version !== 1 ||
      ready.protocolVersion !== 2 ||
      intent.version !== 1 ||
      ready.jobId !== managedJobId ||
      intent.jobId !== managedJobId ||
      projection.jobId !== managedJobId ||
      ready.attemptToken !== attemptToken ||
      intent.attemptToken !== attemptToken ||
      intent.originTaskId !== originTaskId ||
      intent.intent !== 'timed_out' ||
      intent.executionOwner?.jobId !== job.owner_principal.slice('managed:'.length) ||
      !job.owner_principal.startsWith('managed:') ||
      intent.executionOwner?.originTaskId !== job.origin_task_id ||
      projection.executionOwner?.jobId !== intent.executionOwner.jobId ||
      projection.executionOwner?.originTaskId !== intent.executionOwner.originTaskId ||
      owner.jobId !== managedJobId ||
      owner.originTaskId !== originTaskId ||
      !['running', 'waiting', 'cancelling'].includes(owner.state) ||
      ['pid', 'ppid', 'pgid', 'startedAt'].some((key) => owner.ownerIdentity?.[key] !== intent.ownerIdentity?.[key]) ||
      typeof intent.runId !== 'string' ||
      !intent.runId ||
      projection.runId !== intent.runId ||
      ready.frozenFingerprint !== intent.frozenIdentity?.fingerprint ||
      projection.frozenIdentity?.fingerprint !== intent.frozenIdentity?.fingerprint ||
      intent.frozenIdentity?.headSha !== plan.testedHeadSha ||
      intent.frozenIdentity?.baseSha !== plan.baseSha ||
      !Number.isSafeInteger(intent.ownerIdentity?.pid) ||
      intent.ownerIdentity.pid <= 0 ||
      typeof intent.ownerIdentity?.startedAt !== 'string' ||
      !intent.ownerIdentity.startedAt ||
      !Number.isSafeInteger(intent.pauseEpoch) ||
      intent.pauseEpoch < 0 ||
      !Number.isSafeInteger(intent.reconcileFrom) ||
      intent.reconcileFrom < job.created_at ||
      !Number.isSafeInteger(intent.issuedAt) ||
      intent.issuedAt < intent.reconcileFrom ||
      intent.issuedAt > now
    )
      return null;
    return { ...intent, intentPath, cancelPath };
  } catch {
    // Missing, torn, old or mismatched producer evidence retains ordinary cancel.
    return null;
  }
}

// Automatic owner recovery uses the existing outer terminal-intent/CAS fence.
// This receipt grants only the narrower manual exception for an attested timeout.
export function resumableManagedGateStop(job, input) {
  if (input.kind !== 'explicit_resume' || !job.managed_stop_json || job.terminal_status !== 'cancelled') return null;
  const intent = JSON.parse(job.managed_stop_json);
  const result = job.result_json ? JSON.parse(job.result_json) : null;
  if (
    intent.intent !== 'timed_out' ||
    typeof input.sourceRunId !== 'string' ||
    !input.sourceRunId ||
    input.sourceRunId !== intent.runId ||
    result?.cleanupProof?.tokenZeroMatches !== true ||
    existsSync(intent.cancelPath)
  )
    return null;
  return intent;
}
