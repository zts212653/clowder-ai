import { type CatId, createCatId } from '@cat-cafe/shared';
import type { InvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';

export interface CallbackActor {
  invocationId: string;
  threadId: string;
  userId: string;
  catId: CatId;
}

export function deriveCallbackActor(record: InvocationRecord): CallbackActor {
  return {
    invocationId: record.invocationId,
    threadId: record.threadId,
    userId: record.userId,
    catId: createCatId(record.catId),
  };
}

export function resolveBoundThreadScope(
  actor: Pick<CallbackActor, 'threadId'>,
  requestedThreadId: string,
  error = 'Cross-thread write rejected',
): { ok: true; threadId: string } | { ok: false; statusCode: 403; error: string } {
  if (actor.threadId !== requestedThreadId) {
    return { ok: false, statusCode: 403, error };
  }
  return { ok: true, threadId: requestedThreadId };
}

export async function resolveScopedThreadId(
  actor: Pick<CallbackActor, 'threadId' | 'userId'>,
  requestedThreadId: string | undefined,
  options: {
    threadStore?: Pick<IThreadStore, 'get'>;
    threadStoreMissingError?: string;
    accessDeniedError?: string;
  },
): Promise<{ ok: true; threadId: string } | { ok: false; statusCode: 403 | 503; error: string }> {
  if (!requestedThreadId || requestedThreadId === actor.threadId) {
    return { ok: true, threadId: requestedThreadId ?? actor.threadId };
  }

  if (!options.threadStore) {
    return {
      ok: false,
      statusCode: 503,
      error: options.threadStoreMissingError ?? 'Thread store not configured for cross-thread access',
    };
  }

  const targetThread = await options.threadStore.get(requestedThreadId);
  if (!targetThread || targetThread.createdBy !== actor.userId) {
    return {
      ok: false,
      statusCode: 403,
      error: options.accessDeniedError ?? 'Thread access denied',
    };
  }

  return { ok: true, threadId: requestedThreadId };
}
