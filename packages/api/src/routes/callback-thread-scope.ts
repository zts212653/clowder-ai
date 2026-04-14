import type { InvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';

type ThreadScopeError = { ok: false; statusCode: number; body: { error: string } };
type ThreadScopeSuccess = { ok: true; threadId: string };
export type ThreadScopeResult = ThreadScopeError | ThreadScopeSuccess;

export interface ResolveCallbackThreadScopeOptions {
  record: InvocationRecord;
  requestedThreadId?: string | null;
  threadStore?: IThreadStore;
  allowCrossThread?: boolean;
  requireRequestedThreadId?: boolean;
  missingThreadIdError?: string;
  crossThreadDeniedError?: string;
  crossThreadStoreMissingError?: string;
  accessDeniedError?: string;
  noInvocationThreadError?: string;
}

function fail(statusCode: number, error: string): ThreadScopeError {
  return { ok: false, statusCode, body: { error } };
}

function normalizeThreadId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Unified callback thread scope resolver.
 * - default: use invocation-bound thread
 * - optional cross-thread: only when allowCrossThread=true and user owns target thread
 * - strict mode: require explicit threadId and reject cross-thread
 */
export async function resolveCallbackThreadScope(opts: ResolveCallbackThreadScopeOptions): Promise<ThreadScopeResult> {
  const {
    record,
    threadStore,
    allowCrossThread = false,
    requireRequestedThreadId = false,
    missingThreadIdError = 'Missing threadId',
    crossThreadDeniedError = 'Cross-thread write rejected',
    crossThreadStoreMissingError = 'Thread store not configured for cross-thread access',
    accessDeniedError = 'Thread access denied',
    noInvocationThreadError = 'No threadId associated with this invocation',
  } = opts;
  const requestedThreadId = normalizeThreadId(opts.requestedThreadId);
  const invocationThreadId = normalizeThreadId(record.threadId);

  if (!requestedThreadId) {
    if (requireRequestedThreadId) return fail(400, missingThreadIdError);
    if (!invocationThreadId) return fail(400, noInvocationThreadError);
    return { ok: true, threadId: invocationThreadId };
  }

  if (!invocationThreadId) return fail(400, noInvocationThreadError);
  if (requestedThreadId === invocationThreadId) return { ok: true, threadId: requestedThreadId };

  if (!allowCrossThread) return fail(403, crossThreadDeniedError);
  if (!threadStore) return fail(503, crossThreadStoreMissingError);

  const targetThread = await threadStore.get(requestedThreadId);
  if (!targetThread || targetThread.createdBy !== record.userId) return fail(403, accessDeniedError);

  return { ok: true, threadId: requestedThreadId };
}

