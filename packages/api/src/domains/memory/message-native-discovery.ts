import type { MessageSearchInput } from '@cat-cafe/shared';
import type { Thread } from '../cats/services/stores/ports/ThreadStore.js';
import type { IEvidenceStore } from './interfaces.js';
import type { MessageSearchPrincipal } from './MessageSearchService.js';
import { type CanonicalSearchCandidate, messageDiscoverySource } from './message-discovery-source.js';
import type { MessagePassageCandidate } from './message-passage-search-types.js';
import {
  checkSearchExecution,
  MessageReadObservation,
  type MessageSearchExecutionContext,
} from './message-search-lifetime.js';

/** Native discovery's read lifetime; canonical policy and exact readers remain in MessageSearchService. */
export function messageNativeDiscovery(
  input: MessageSearchInput,
  principal: MessageSearchPrincipal,
  context: MessageSearchExecutionContext,
  ops: {
    visible(context: MessageSearchExecutionContext): Promise<Map<string, Thread>>;
    requireSource(context: MessageSearchExecutionContext, observation?: MessageReadObservation): Promise<void>;
    project(candidate: MessagePassageCandidate): Promise<CanonicalSearchCandidate | null>;
    evidence: Pick<IEvidenceStore, 'searchMessagePassages' | 'readMessagePassageState'>;
  },
) {
  const threadIds = new Set<string>();
  let lifetime = context;
  let observation: MessageReadObservation | undefined;
  const source = messageDiscoverySource({
    search: input,
    threadIds,
    source: principal.source,
    read: async (request) => {
      observation?.close();
      lifetime = {
        ...context,
        signal: request.signal ?? context.signal,
        deadlineAt: Math.min(request.deadlineAt ?? Infinity, context.deadlineAt ?? Infinity, Date.now() + 15_000),
      };
      const current = new MessageReadObservation(lifetime);
      observation = current;
      threadIds.clear();
      try {
        const threads = await current.run('visibility', () => ops.visible(lifetime));
        for (const id of threads.keys()) threadIds.add(id);
        await ops.requireSource(lifetime, current);
        const reader = ops.evidence.searchMessagePassages;
        if (!reader || !ops.evidence.readMessagePassageState) throw new Error('Message passage retrieval unavailable');
        const result = await current.run('retrieval', () =>
          reader.call(ops.evidence, input.query, {
            signal: lifetime.signal,
            deadlineAt: lifetime.deadlineAt,
            onReadSnapshot: current.worker,
            visibleThreadIds: [...threadIds],
            threadId: input.threadId,
            excludeSource: principal.source,
            mode: input.mode ?? 'hybrid',
            sort: 'relevance',
            candidateOrder: 'relevance',
            candidateLimit: Math.min(2000, request.limit),
            dateFrom: input.dateFrom,
            dateTo: input.dateTo,
          }),
        );
        return { candidates: result.passages, truncated: result.meta.truncated };
      } finally {
        current.close();
      }
    },
    project: async (candidate) => {
      const execution = lifetime;
      checkSearchExecution(execution);
      const row = await ops.project(candidate);
      checkSearchExecution(execution);
      return row;
    },
  });
  return {
    ...source,
    revalidate: async (row: CanonicalSearchCandidate) => {
      const execution = lifetime;
      checkSearchExecution(execution);
      await ops.requireSource(execution);
      checkSearchExecution(execution);
      const current = await ops.project(row.candidate);
      checkSearchExecution(execution);
      return current?.contentRevision === row.contentRevision ? current : null;
    },
  };
}
