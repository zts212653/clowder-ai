import { randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export function gateResourceReceipt(row, status, extra = {}) {
  return {
    version: 1,
    requestId: row.request_id,
    requestOrder: row.request_order,
    ...(row.logical_request_key
      ? {
          logicalRequestKey: row.logical_request_key,
          requestGeneration: row.request_generation,
          parentRequestId: row.parent_request_id,
          claimantGeneration: row.claimant_generation,
          queueDeadlineAt: row.queue_deadline_at,
        }
      : {}),
    holderPid: row.holder_pid,
    holderStartedAt: row.holder_started_at,
    cwd: row.cwd,
    stage: row.stage,
    resourceClass: row.resource_class,
    mode: row.mode,
    priority: row.priority ?? 'interactive',
    weight: row.weight,
    capacity: row.capacity,
    claims: row.claims ?? [{ key: row.resource_class, units: row.weight, capacity: row.capacity }],
    bypassCount: row.bypass_count ?? 0,
    totalBypassCount: row.total_bypass_count ?? 0,
    pressureStarvationCount: row.pressure_starvation_count ?? 0,
    drainStartedAt: row.drain_started_at,
    pressureBlockedAt: row.pressure_blocked_at,
    queuedAt: Number.isFinite(row.queued_at) ? new Date(row.queued_at).toISOString() : null,
    status,
    ...extra,
  };
}

function unchangedReceipt(filePath, bytes) {
  let descriptor;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.uid !== BigInt(process.getuid()) || (before.mode & 0o022n) !== 0n) return false;
    if (before.size !== BigInt(bytes.length) || !readFileSync(descriptor).equals(bytes)) return false;
    const after = fstatSync(descriptor, { bigint: true });
    const named = lstatSync(filePath, { bigint: true });
    return (
      ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(
        (field) => before[field] === after[field] && after[field] === named[field],
      ) && named.isFile()
    );
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function writeGateResourceReceipt(filePath, value) {
  // SQLite owns resource state. Diagnostics must not turn a committed admission
  // or release into an exception, including when maintenance expires a peer
  // before registration's second transaction has assigned its receipt path.
  if (!filePath) return;
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
    if (typeof process.getuid === 'function' && unchangedReceipt(filePath, bytes)) return;
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(tempPath, bytes, { flag: 'wx', mode: 0o600 });
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // A filesystem failure can also prevent removal of our temporary file.
    }
    console.error(
      `[gate-resource] receipt publication failed requestId=${value.requestId} error=${JSON.stringify(String(error))}`,
    );
  }
}
