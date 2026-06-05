import { type AgentKeyRecord, type CallbackPrincipal, type CatId, createCatId } from '@cat-cafe/shared';
import type { InvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { DEFAULT_THREAD_ID, type IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';

export interface CallbackActor {
  invocationId: string;
  /** #573: parent (queue-level) invocationId — when present, is the OUTER id used for
   * broadcast/persistence identity. Falls back to `invocationId` if no parent. */
  parentInvocationId?: string;
  threadId: string;
  userId: string;
  catId: CatId;
}

export function deriveCallbackActor(record: InvocationRecord): CallbackActor {
  return {
    invocationId: record.invocationId,
    ...(record.parentInvocationId ? { parentInvocationId: record.parentInvocationId } : {}),
    threadId: record.threadId,
    userId: record.userId,
    catId: createCatId(record.catId),
  };
}

/**
 * #573: identity used for cross-handler broadcast/persistence dedup.
 * QueueProcessor:761 broadcasts agent_message with parent (outer) id; route-serial
 * persists with parent (outer) id. Callback path must use the same to keep the
 * frontend's `(catId, invocationId)` dedup contract intact across stream + callback.
 */
export function effectiveInvocationId(actor: Pick<CallbackActor, 'invocationId' | 'parentInvocationId'>): string {
  return actor.parentInvocationId ?? actor.invocationId;
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
    threadStore?: Pick<IThreadStore, 'get' | 'list'>;
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
  if (!targetThread || !(await canAccessScopedThread(options.threadStore, targetThread, actor.userId))) {
    return {
      ok: false,
      statusCode: 403,
      error: options.accessDeniedError ?? 'Thread access denied',
    };
  }

  return { ok: true, threadId: requestedThreadId };
}

export function derivePrincipal(record: InvocationRecord | AgentKeyRecord): CallbackPrincipal {
  if ('agentKeyId' in record) {
    return {
      kind: 'agent_key',
      agentKeyId: record.agentKeyId,
      userId: record.userId,
      catId: createCatId(record.catId),
      scope: record.scope,
    };
  }
  return {
    kind: 'invocation',
    invocationId: record.invocationId,
    ...(record.parentInvocationId ? { parentInvocationId: record.parentInvocationId } : {}),
    threadId: record.threadId,
    userId: record.userId,
    catId: createCatId(record.catId),
  };
}

export async function resolvePrincipalThread(
  principal: CallbackPrincipal,
  requestedThreadId: string | undefined,
  options: {
    threadStore?: Pick<IThreadStore, 'get' | 'list'>;
    threadStoreMissingError?: string;
    accessDeniedError?: string;
  },
): Promise<{ ok: true; threadId: string } | { ok: false; statusCode: 400 | 403 | 503; error: string }> {
  if (principal.kind === 'agent_key') {
    if (!requestedThreadId) {
      return { ok: false, statusCode: 400, error: 'threadId required for agent-key auth' };
    }
    if (!options.threadStore) {
      return {
        ok: false,
        statusCode: 503,
        error: options.threadStoreMissingError ?? 'Thread store not configured for cross-thread access',
      };
    }
    const thread = await options.threadStore.get(requestedThreadId);
    if (!thread || !(await canAccessScopedThread(options.threadStore, thread, principal.userId))) {
      return {
        ok: false,
        statusCode: 403,
        error: options.accessDeniedError ?? 'Thread access denied',
      };
    }
    return { ok: true, threadId: requestedThreadId };
  }

  return resolveScopedThreadId(principal, requestedThreadId, options);
}

async function canAccessScopedThread(
  threadStore: Pick<IThreadStore, 'list'>,
  targetThread: { id: string; createdBy: string },
  userId: string,
): Promise<boolean> {
  if (targetThread.createdBy === userId) return true;
  if (targetThread.createdBy !== 'system') return false;
  if (targetThread.id === DEFAULT_THREAD_ID) return false;

  const userVisibleThreads = await threadStore.list(userId);
  return userVisibleThreads.some((thread) => thread.id === targetThread.id);
}
