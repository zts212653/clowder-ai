import type { CliExecutionOwnerRef } from './cli-process-ownership.js';
import type { ChildProcessLike } from './cli-types.js';
import { readWindowsProcessTable, recordWindowsChildOwner } from './windows-cli-child-owner.js';

interface Observation {
  owner: CliExecutionOwnerRef;
  exitedAt?: number;
}
const observations = new Map<string, Observation>();
const RETENTION_MS = 24 * 60 * 60 * 1_000;

/**
 * #1838: Windows has no supervisor manifest, so the provider's exact native identity is written
 * durably as soon as the process exists. Without it a forced API kill leaves a durable `running`
 * child that no later process can prove stopped.
 *
 * The record is never deleted here: a crash between the provider's own exit and the durable
 * teardown write would otherwise destroy the only proof that it stopped. Startup recovery clears
 * the record once the execution is settled.
 *
 * Residual window: this lands one probe after spawn, not before it.
 */
function recordWindowsProviderIdentity(child: ChildProcessLike, owner: CliExecutionOwnerRef): void {
  if (process.platform !== 'win32') return;
  if (child.pid === undefined) return;
  void readWindowsProcessTable([child.pid])
    .then((table) => {
      const identity = table?.get(child.pid as number);
      if (!identity) return;
      recordWindowsChildOwner({ execution: owner, root: { pid: identity.pid, creationDate: identity.creationDate } });
    })
    .catch(() => {
      // Losing the record costs the *unlock*, never the protection: the ledger keeps its
      // unconfirmed teardown and the execution stays blocked until someone verifies it.
    });
}

/** Process events, not a status bit, establish exit. No argv, prompt, PID reuse or metric inference. */
export function observeCliExecutionProcess(child: ChildProcessLike, owner: CliExecutionOwnerRef | undefined): void {
  if (!owner) return;
  recordWindowsProviderIdentity(child, owner);
  if (observations.size > 256) {
    for (const [id, record] of observations) {
      if (record.exitedAt !== undefined && Date.now() - record.exitedAt > RETENTION_MS) observations.delete(id);
    }
  }
  const record: Observation = { owner: { ...owner } };
  observations.set(owner.invocationId, record);
  const exited = (): void => {
    if (observations.get(owner.invocationId) === record) record.exitedAt ??= Date.now();
  };
  child.once('exit', exited);
  child.once('close', exited);
}

export function getCliExecutionExit(owner: CliExecutionOwnerRef): { exitedAt: number } | undefined {
  const record = observations.get(owner.invocationId);
  if (!record || record.exitedAt === undefined) return undefined;
  if (
    record.owner.executionId !== owner.executionId ||
    record.owner.threadId !== owner.threadId ||
    record.owner.userId !== owner.userId ||
    record.owner.catId !== owner.catId
  )
    return undefined;
  return { exitedAt: record.exitedAt };
}

export function isCliExecutionRunning(owner: CliExecutionOwnerRef): boolean {
  const record = observations.get(owner.invocationId);
  return (
    !!record &&
    record.exitedAt === undefined &&
    record.owner.executionId === owner.executionId &&
    record.owner.threadId === owner.threadId &&
    record.owner.userId === owner.userId &&
    record.owner.catId === owner.catId
  );
}

/** A newer child/process in the same parent always vetoes stale-owner recovery. */
export function hasRunningCliExecution(
  owner: Pick<CliExecutionOwnerRef, 'executionId' | 'threadId' | 'userId'>,
): boolean {
  return [...observations.values()].some(
    (record) =>
      record.exitedAt === undefined &&
      record.owner.executionId === owner.executionId &&
      record.owner.threadId === owner.threadId &&
      record.owner.userId === owner.userId,
  );
}
