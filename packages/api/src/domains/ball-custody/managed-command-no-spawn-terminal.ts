import type { DurableManagedGateJob } from './durable-managed-gate-job.js';
import {
  readDurableGateRecord,
  readDurableTerminalReceipt,
  settleDurableManagedGateJobFromRunner,
} from './durable-managed-gate-job-store.js';
import { validateDurableManagedGateJob } from './durable-managed-gate-job-validation.js';

/** Consume the existing terminal owner for an explicit no-spawn fact.
 * No completion wake or new lifecycle is produced; a conflicting winner stays authoritative.
 */
export function settleNoSpawnDurableGate(
  job: DurableManagedGateJob,
  expectedTaskId: string,
  detail: string,
  cancelled = false,
): boolean {
  // Persisted params are data. Bind origin and every path to the current runtime
  // data root before the existing terminal owner performs any filesystem IO.
  if (!validateDurableManagedGateJob(job, expectedTaskId)) return false;
  settleDurableManagedGateJobFromRunner(job, {
    exitCode: null,
    timedOut: false,
    cancelled,
    durationMs: 0,
    tailOutput: `Command not started: ${detail}`,
  });
  const receipt = readDurableTerminalReceipt(job);
  const record = readDurableGateRecord(job);
  const status = cancelled ? 'cancelled' : 'failed';
  return record?.state === 'terminal' && record.terminalStatus === status && receipt?.terminalStatus === status;
}
