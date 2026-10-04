import { describe, expect, it } from 'vitest';
import type { QueueEntry } from '@/stores/chat-types';
import {
  collectSettlingInvocationIds,
  projectQueueEntryForActions,
  receiptTargetStateLabel,
} from '../queue-receipt-projection';

describe('exact source settling presentation', () => {
  const target = { catId: 'opus5', state: 'seen' as const, invocationId: 'primary', seenAt: 100 };
  const entry: QueueEntry = {
    id: 'queue',
    threadId: 't',
    userId: 'u',
    content: 'review',
    messageId: 'm',
    mergedMessageIds: [],
    source: 'agent',
    intent: 'execute',
    status: 'queued',
    createdAt: 1,
    targetCats: ['opus5'],
    targetStates: { opus5: 'seen' },
    queueReceipt: {
      version: 1,
      entryId: 'queue',
      scope: 'cross_thread_delivery',
      targets: [target],
      reminderAttempts: [],
    },
  };
  it('shows finishing, not an ended-turn recovery action', () => {
    const live = new Set(['parent', 'guard']);
    const settling = new Set(['primary']);
    expect(receiptTargetStateLabel(target, live, 'cross_thread_delivery', false, settling)).toBe(
      '正在收尾 · 等待本轮完成',
    );
    expect(projectQueueEntryForActions(entry, live, settling)).toBeNull();
  });
  it('restores unresolved presentation when the exact settlement proof disappears', () => {
    expect(projectQueueEntryForActions(entry, new Set(['other-parent']), new Set())).not.toBeNull();
    expect(receiptTargetStateLabel(target, new Set(), undefined, false, new Set())).toContain('尚未确认处理完成');
  });
  it('rejects stale parent and child projections after websocket replacement', () => {
    const info = {
      invocationId: 'parent',
      turnInvocationId: 'guard',
      settlement: { activeTurnInvocationId: 'guard', completedTurnInvocationIds: ['primary'] },
    };
    expect([...collectSettlingInvocationIds({ parent: { catId: 'opus5' } }, { opus5: info })]).toEqual(['primary']);
    expect(collectSettlingInvocationIds({ other: { catId: 'opus5' } }, { opus5: info }).size).toBe(0);
    expect(
      collectSettlingInvocationIds(
        { parent: { catId: 'opus5' } },
        { opus5: { ...info, turnInvocationId: 'new-child' } },
      ).size,
    ).toBe(0);
    expect(collectSettlingInvocationIds({}, { opus5: info }).size).toBe(0);
  });
});
