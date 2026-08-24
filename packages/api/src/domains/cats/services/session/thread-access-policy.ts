import { DEFAULT_THREAD_ID, type IThreadStore, type Thread } from '../stores/ports/ThreadStore.js';

export type ThreadAccessRequest =
  | { resource: 'sessions'; action: 'list' | 'read' }
  | { resource: 'transcript'; action: 'read' | 'search' }
  | { resource: 'invocations'; action: 'read' }
  | { resource: 'theater'; action: 'replay' }
  | { resource: 'executions'; action: 'read' | 'cancel' };

export type ThreadAccessDecision =
  | {
      status: 200;
      scope: 'thread' | 'user';
      basis: 'owner' | 'shared_default' | 'external_runtime_anchor';
      userId: string;
      request: ThreadAccessRequest;
    }
  | {
      status: 200;
      scope: 'user';
      basis: 'user_index';
      userId: string;
      request: ThreadAccessRequest;
      /** The durable visibility proof; liveness projection may reuse it instead of re-enumerating the index. */
      visibleThreads: readonly Thread[];
    }
  | {
      status: 403;
      code: 'THREAD_ACCESS_DENIED';
      reason: 'thread_not_found' | 'not_visible_to_user';
      userId: string;
      request: ThreadAccessRequest;
    };

interface ResolveThreadAccessInput {
  threadStore: Pick<IThreadStore, 'list'>;
  thread: Thread | null;
  userId: string;
  request: ThreadAccessRequest;
}

function allow(
  input: ResolveThreadAccessInput,
  scope: 'thread' | 'user',
  basis: 'owner' | 'shared_default' | 'external_runtime_anchor',
): ThreadAccessDecision {
  return { status: 200, scope, basis, userId: input.userId, request: input.request };
}

/**
 * Canonical visibility authority for thread-backed resources.
 *
 * A system thread being visible through a user's durable thread index grants
 * access to that thread surface. Consumers that expose per-user records must
 * still apply the narrower record filter below; liveness consumers instead
 * apply their own masked-occupancy and exact-control rules after admission.
 */
export async function resolveThreadAccess(input: ResolveThreadAccessInput): Promise<ThreadAccessDecision> {
  const { thread, userId } = input;
  if (!thread) {
    return {
      status: 403,
      code: 'THREAD_ACCESS_DENIED',
      reason: 'thread_not_found',
      userId,
      request: input.request,
    };
  }
  if (thread.createdBy === userId) return allow(input, 'thread', 'owner');
  if (thread.id === DEFAULT_THREAD_ID && thread.createdBy === 'system') {
    return allow(input, 'user', 'shared_default');
  }
  if (thread.externalRuntimeAnchorState?.userId === userId) {
    return allow(input, 'user', 'external_runtime_anchor');
  }
  if (thread.createdBy === 'system') {
    const visibleThreads = await input.threadStore.list(userId);
    if (visibleThreads.some((visibleThread) => visibleThread.id === thread.id)) {
      return {
        status: 200,
        scope: 'user',
        basis: 'user_index',
        userId,
        request: input.request,
        visibleThreads,
      };
    }
  }
  return {
    status: 403,
    code: 'THREAD_ACCESS_DENIED',
    reason: 'not_visible_to_user',
    userId,
    request: input.request,
  };
}

export function canReadThreadRecord(decision: ThreadAccessDecision, record: { userId: string }): boolean {
  return decision.status === 200 && (decision.scope === 'thread' || record.userId === decision.userId);
}

export function filterThreadRecords<T extends { userId: string }>(
  decision: ThreadAccessDecision,
  records: readonly T[],
): T[] {
  return records.filter((record) => canReadThreadRecord(decision, record));
}

export function threadAccessDeniedBody(decision: Extract<ThreadAccessDecision, { status: 403 }>) {
  return {
    error: 'Access denied',
    code: decision.code,
    reason: decision.reason,
  } as const;
}

export function threadRecordAccessDeniedBody() {
  return {
    error: 'Access denied',
    code: 'THREAD_RECORD_ACCESS_DENIED',
    reason: 'record_belongs_to_another_user',
  } as const;
}
