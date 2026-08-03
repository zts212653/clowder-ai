import type { CodexAppServerLifecycleSnapshot } from './CodexAppServerLifecycle.js';

interface LifecycleRecord {
  lifecycle: CodexAppServerLifecycleSnapshot;
}

const MAX_RECORD_AGE_MS = 12 * 60 * 60 * 1_000;
const MIN_PRUNE_SIZE = 256;
const lifecycleByExecution = new Map<string, LifecycleRecord>();

function key(threadId: string, catId: string, invocationId: string): string {
  return `${threadId}\u0000${catId}\u0000${invocationId}`;
}

function pruneExpired(now: number): void {
  if (lifecycleByExecution.size < MIN_PRUNE_SIZE) return;
  for (const [recordKey, record] of lifecycleByExecution) {
    if (now - record.lifecycle.lastActivityAt > MAX_RECORD_AGE_MS) lifecycleByExecution.delete(recordKey);
  }
}

export function recordCodexAppServerLifecycle(input: {
  threadId: string;
  catId: string;
  invocationId: string;
  lifecycle: CodexAppServerLifecycleSnapshot;
}): void {
  pruneExpired(input.lifecycle.lastActivityAt);
  lifecycleByExecution.set(key(input.threadId, input.catId, input.invocationId), {
    lifecycle: { ...input.lifecycle },
  });
}

export function getCodexAppServerLifecycle(
  threadId: string,
  catId: string,
  invocationId: string,
  now = Date.now(),
): CodexAppServerLifecycleSnapshot | undefined {
  const recordKey = key(threadId, catId, invocationId);
  const record = lifecycleByExecution.get(recordKey);
  if (!record) return undefined;
  if (now - record.lifecycle.lastActivityAt > MAX_RECORD_AGE_MS) {
    lifecycleByExecution.delete(recordKey);
    return undefined;
  }
  return { ...record.lifecycle };
}

export function clearCodexAppServerLifecycle(threadId: string, catId: string, invocationId: string): void {
  lifecycleByExecution.delete(key(threadId, catId, invocationId));
}
