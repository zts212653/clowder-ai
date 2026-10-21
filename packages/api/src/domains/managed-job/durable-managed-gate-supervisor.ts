import { randomUUID } from 'node:crypto';
import { existsSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import {
  readUnixProcessSnapshotSync,
  sameUnixProcess,
  type UnixProcessIdentity,
} from '../../utils/cli-process-ownership.js';
import type { DurableManagedGateJob } from './durable-managed-gate-job.js';
import { closeSupervisorStore, openSupervisorStore, transaction } from './managed-job-database.js';
import { writeManagedJobLedger } from './managed-job-ledger.js';

export const CURRENT_DURABLE_GATE_SUPERVISOR_EPOCH = randomUUID();
export const DURABLE_GATE_SUPERVISOR_LEASE_MS = 60_000;

export interface DurableGateSupervisorLease {
  readonly supervisorEpoch: string;
  readonly fencingToken: number;
  readonly leaseUntil: number;
}

export class DurableGateSupervisorFenceError extends Error {
  constructor(jobId: string) {
    super(`durable gate supervisor lease unavailable: ${jobId}`);
    this.name = 'DurableGateSupervisorFenceError';
  }
}

let supervisorBirthIdentity: UnixProcessIdentity | null = null;

function currentSupervisorIdentity(): UnixProcessIdentity | null {
  // This process's birth identity cannot change during its lifetime. Observe it
  // before first admission; renewal authority comes from the transactional lease,
  // not a new ps invocation. Unknown initial observations remain retryable.
  if (supervisorBirthIdentity?.pid === process.pid) return supervisorBirthIdentity;
  const observed = readUnixProcessSnapshotSync({ pids: [process.pid] })?.get(process.pid);
  if (observed) supervisorBirthIdentity = { ...observed };
  return observed ?? null;
}

function previousSupervisorIsProvenDead(current: {
  supervisor_pid: number;
  supervisor_ppid: number;
  supervisor_pgid: number;
  supervisor_started_at: string;
}): boolean {
  if (current.supervisor_pid <= 0 || !current.supervisor_started_at) return true;
  const snapshot = readUnixProcessSnapshotSync({ pids: [current.supervisor_pid] });
  if (snapshot === null) return false;
  return !sameUnixProcess(
    {
      pid: current.supervisor_pid,
      ppid: current.supervisor_ppid,
      pgid: current.supervisor_pgid,
      startedAt: current.supervisor_started_at,
    },
    snapshot.get(current.supervisor_pid),
  );
}

export function claimDurableGateSupervisor(
  job: DurableManagedGateJob,
  options: { now?: number; leaseMs?: number } = {},
): DurableGateSupervisorLease | null {
  const now = options.now ?? Date.now();
  const leaseMs = options.leaseMs ?? DURABLE_GATE_SUPERVISOR_LEASE_MS;
  const supervisorIdentity = currentSupervisorIdentity();
  if (!supervisorIdentity) return null;
  const database = openSupervisorStore(job);
  try {
    return transaction(database, () => {
      const current = database.prepare('SELECT * FROM durable_gate_supervisors WHERE job_id = ?').get(job.jobId) as
        | {
            supervisor_epoch: string;
            fencing_token: number;
            lease_until: number;
            supervisor_pid: number;
            supervisor_ppid: number;
            supervisor_pgid: number;
            supervisor_started_at: string;
          }
        | undefined;
      if (
        current &&
        current.supervisor_epoch !== job.supervisorEpoch &&
        current.lease_until > now &&
        !previousSupervisorIsProvenDead(current)
      )
        return null;
      const fencingToken = current
        ? current.fencing_token + (current.supervisor_epoch === job.supervisorEpoch ? 0 : 1)
        : 1;
      const leaseUntil = now + leaseMs;
      database
        .prepare(
          `INSERT INTO durable_gate_supervisors
             (job_id, supervisor_epoch, fencing_token, lease_until,
              supervisor_pid, supervisor_ppid, supervisor_pgid, supervisor_started_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(job_id) DO UPDATE SET
             supervisor_epoch = excluded.supervisor_epoch,
             fencing_token = excluded.fencing_token,
             lease_until = excluded.lease_until,
             supervisor_pid = excluded.supervisor_pid,
             supervisor_ppid = excluded.supervisor_ppid,
             supervisor_pgid = excluded.supervisor_pgid,
             supervisor_started_at = excluded.supervisor_started_at,
             updated_at = excluded.updated_at`,
        )
        .run(
          job.jobId,
          job.supervisorEpoch,
          fencingToken,
          leaseUntil,
          supervisorIdentity.pid,
          supervisorIdentity.ppid,
          supervisorIdentity.pgid,
          supervisorIdentity.startedAt,
          now,
        );
      return { supervisorEpoch: job.supervisorEpoch, fencingToken, leaseUntil };
    });
  } finally {
    closeSupervisorStore(database);
  }
}

export function writeDurableGateRecordFenced(
  job: DurableManagedGateJob,
  value: object,
  options: { now?: number; leaseMs?: number; exclusive?: boolean } = {},
): boolean {
  const now = options.now ?? Date.now();
  const leaseMs = options.leaseMs ?? DURABLE_GATE_SUPERVISOR_LEASE_MS;
  const database = openSupervisorStore(job);
  try {
    return transaction(database, () => {
      const lease = database.prepare('SELECT * FROM durable_gate_supervisors WHERE job_id = ?').get(job.jobId) as
        | { supervisor_epoch: string; fencing_token: number; lease_until: number }
        | undefined;
      if (!lease || lease.supervisor_epoch !== job.supervisorEpoch || lease.lease_until < now) return false;
      if (job.recordStorage === 'sqlite_v1') {
        const row = database.prepare('SELECT record_json FROM managed_jobs WHERE job_id = ?').get(job.jobId) as
          | { record_json: string }
          | undefined;
        const current = row ? (JSON.parse(row.record_json) as { ownerIdentity?: UnixProcessIdentity }) : null;
        const owner = current?.ownerIdentity;
        if (owner && owner.pid !== process.pid) {
          const snapshot = readUnixProcessSnapshotSync({ pids: [owner.pid] });
          if (snapshot === null || sameUnixProcess(owner, snapshot.get(owner.pid))) return false;
        }
      }
      const leaseUntil = now + leaseMs;
      database
        .prepare('UPDATE durable_gate_supervisors SET lease_until = ?, updated_at = ? WHERE job_id = ?')
        .run(leaseUntil, now, job.jobId);
      const record = {
        ...value,
        supervisorEpoch: job.supervisorEpoch,
        supervisorFence: lease.fencing_token,
      };
      if (job.recordStorage === 'sqlite_v1')
        return writeManagedJobLedger(database, job, record, options.exclusive ?? false);
      if (options.exclusive) {
        if (existsSync(job.recordPath)) throw new Error(`durable gate job already exists: ${job.jobId}`);
        writeFileSync(job.recordPath, `${JSON.stringify(record)}\n`, { flag: 'wx' });
        return true;
      }
      const temporary = `${job.recordPath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx' });
        renameSync(temporary, job.recordPath);
      } finally {
        rmSync(temporary, { force: true });
      }
      return true;
    });
  } finally {
    closeSupervisorStore(database);
  }
}
