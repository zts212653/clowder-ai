import type { DeclaredWorkMode } from '@cat-cafe/shared';
import type { Thread } from '../cats/services/stores/ports/ThreadStore.js';

export type ProjectedWorkMode = DeclaredWorkMode | 'unknown';

export interface ThreadRelationOriginV1 {
  sourceThreadId: string;
  sourceInvocationId?: string;
  sourceMessageId?: string;
  mechanism: 'f128_proposal' | 'message_branch';
}

export interface ThreadRelationNodeV1 {
  threadId: string;
  origin?: ThreadRelationOriginV1;
  placement: {
    parentThreadId?: string;
    declaredWorkMode: ProjectedWorkMode;
  };
}

export interface ThreadRelationProjectionV1 {
  v: 1;
  nodes: ThreadRelationNodeV1[];
}

/**
 * Rebuild the F277 relation read model from immutable Thread birth facts.
 * This is deliberately a pure projection: no title/time/participant inference,
 * no durable graph store, and no F167/F246/F275 operational fields.
 */
export function projectThreadRelations(threads: readonly Thread[]): ThreadRelationProjectionV1 {
  const nodes: ThreadRelationNodeV1[] = [];

  for (const thread of threads) {
    const origin = projectOrigin(thread);
    if (!origin && !thread.parentThreadId) continue;

    nodes.push({
      threadId: thread.id,
      ...(origin ? { origin } : {}),
      placement: {
        ...(thread.parentThreadId ? { parentThreadId: thread.parentThreadId } : {}),
        declaredWorkMode: thread.declaredWorkMode ?? 'unknown',
      },
    });
  }

  nodes.sort((left, right) => left.threadId.localeCompare(right.threadId));
  return { v: 1, nodes };
}

function projectOrigin(thread: Thread): ThreadRelationOriginV1 | undefined {
  if (thread.createdFromProposalId && thread.sourceThreadId) {
    return {
      sourceThreadId: thread.sourceThreadId,
      ...(thread.sourceInvocationId ? { sourceInvocationId: thread.sourceInvocationId } : {}),
      ...(thread.sourceMessageId ? { sourceMessageId: thread.sourceMessageId } : {}),
      mechanism: 'f128_proposal',
    };
  }

  if (thread.branchAudit) {
    return {
      sourceThreadId: thread.branchAudit.sourceThreadId,
      sourceMessageId: thread.branchAudit.sourceMessageId,
      mechanism: 'message_branch',
    };
  }

  return undefined;
}
