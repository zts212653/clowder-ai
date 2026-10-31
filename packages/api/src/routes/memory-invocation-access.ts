import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import type { ITurnExecutionStore } from '../domains/cats/services/stores/ports/TurnExecutionStore.js';

export interface MemoryInvocationReaders {
  invocationRecordStore?: Pick<IInvocationRecordStore, 'get'>;
  turnExecutionStore?: Pick<ITurnExecutionStore, 'get'>;
}
/** Parent and per-cat child invocations share this canonical owner/thread fence. */
export async function memoryInvocationAccess(
  readers: MemoryInvocationReaders,
  userId: string,
  threadId: string,
  invocationId: string,
): Promise<{ status: 200 } | { status: 403 | 404 | 409 | 503; error: string }> {
  if (!readers.invocationRecordStore || !readers.turnExecutionStore)
    return { status: 503, error: 'Invocation resolver unavailable' };
  const invocation = await readers.invocationRecordStore.get(invocationId);
  const child = invocation ? null : await readers.turnExecutionStore.get(invocationId);
  const scope = invocation ?? child;
  if (!scope) return { status: 404, error: 'Invocation not found' };
  if (scope.userId !== userId) return { status: 403, error: 'Forbidden' };
  if (scope.threadId !== threadId) return { status: 404, error: 'Invocation not found in thread' };
  if (child) {
    const parent = await readers.invocationRecordStore.get(child.parentInvocationId);
    if (!parent) return { status: 404, error: 'Invocation parent not found' };
    if (parent.userId !== userId) return { status: 403, error: 'Forbidden' };
    if (parent.threadId !== threadId) return { status: 409, error: 'Invocation parent scope mismatch' };
  }
  return { status: 200 };
}
