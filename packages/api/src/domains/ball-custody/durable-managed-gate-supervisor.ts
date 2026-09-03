import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import {
  readUnixProcessSnapshotSync,
  sameUnixProcess,
  type UnixProcessIdentity,
} from '../../utils/cli-process-ownership.js';
import type { DurableManagedGateJob } from './durable-managed-gate-job.js';

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

function openSupervisorStore(job: DurableManagedGateJob): Database.Database {
  const directory = dirname(job.recordPath);
  mkdirSync(directory, { recursive: true });
  const database = new Database(join(directory, 'supervisor.sqlite'));
  database.pragma('busy_timeout = 5000');
  database.exec(`
    CREATE TABLE IF NOT EXISTS durable_gate_supervisors (
      job_id TEXT PRIMARY KEY,
      supervisor_epoch TEXT NOT NULL,
      fencing_token INTEGER NOT NULL,
      lease_until INTEGER NOT NULL,
      supervisor_pid INTEGER NOT NULL,
      supervisor_ppid INTEGER NOT NULL,
      supervisor_pgid INTEGER NOT NULL,
      supervisor_started_at TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  const columns = new Set(
    (database.prepare('PRAGMA table_info(durable_gate_supervisors)').all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  const migrations = [
    ['supervisor_pid', 'INTEGER NOT NULL DEFAULT 0'],
    ['supervisor_ppid', 'INTEGER NOT NULL DEFAULT 0'],
    ['supervisor_pgid', 'INTEGER NOT NULL DEFAULT 0'],
    ['supervisor_started_at', "TEXT NOT NULL DEFAULT ''"],
  ];
  for (const [name, definition] of migrations) {
    if (columns.has(name)) continue;
    try {
      database.exec(`ALTER TABLE durable_gate_supervisors ADD COLUMN ${name} ${definition}`);
    } catch (error) {
      const migratedByPeer = (
        database.prepare('PRAGMA table_info(durable_gate_supervisors)').all() as Array<{ name: string }>
      ).some((column) => column.name === name);
      if (!migratedByPeer) throw error;
    }
  }
  return database;
}

function currentSupervisorIdentity(): UnixProcessIdentity | null {
  return readUnixProcessSnapshotSync({ pids: [process.pid] })?.get(process.pid) ?? null;
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

function transaction<T>(database: Database.Database, action: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
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
    database.close();
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
      const leaseUntil = now + leaseMs;
      database
        .prepare('UPDATE durable_gate_supervisors SET lease_until = ?, updated_at = ? WHERE job_id = ?')
        .run(leaseUntil, now, job.jobId);
      const record = {
        ...value,
        supervisorEpoch: job.supervisorEpoch,
        supervisorFence: lease.fencing_token,
      };
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
    database.close();
  }
}
