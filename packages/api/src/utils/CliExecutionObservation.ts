import type { CliExecutionOwnerRef } from './cli-process-ownership.js';
import type { ChildProcessLike } from './cli-types.js';

interface Observation {
  owner: CliExecutionOwnerRef;
  exitedAt?: number;
}
const observations = new Map<string, Observation>();
const RETENTION_MS = 24 * 60 * 60 * 1_000;

/** Process events, not a status bit, establish exit. No argv, prompt, PID reuse or metric inference. */
export function observeCliExecutionProcess(child: ChildProcessLike, owner: CliExecutionOwnerRef | undefined): void {
  if (!owner) return;
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
