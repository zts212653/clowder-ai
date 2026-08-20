import type { QueueMessageReceipt } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import {
  foldedSourceInvocationId,
  projectTurnAbsorptionSummary,
  shouldFoldSourceBody,
  shouldFoldSourceIntoTurnSummary,
} from '../turn-absorption-summary';

function sourceMessage(
  id: string,
  target: QueueMessageReceipt['targets'][number],
  options: { scope?: QueueMessageReceipt['scope']; content?: string; recalled?: boolean } = {},
): ChatMessage {
  return {
    id,
    type: 'user',
    content: options.content ?? `正文-${id}`,
    timestamp: Number(id.replace(/\D/g, '')) || 1,
    extra: {
      queueReceipt: {
        version: 1,
        entryId: `entry-${id}`,
        ...(options.scope ? { scope: options.scope } : {}),
        targets: [target],
        reminderAttempts: [],
      },
      ...(options.recalled
        ? {
            recall: {
              version: 1 as const,
              exposure: 'seen' as const,
              recalledAt: 900,
            },
          }
        : {}),
    },
  };
}

const seen = { catId: 'codex', state: 'seen' as const, invocationId: 'child-1', seenAt: 100 };

describe('F264 AC-42/43 exact-child turn absorption projection', () => {
  it('keeps the four truths distinct and satisfies the exact denominator equation', () => {
    const messages: ChatMessage[] = [
      sourceMessage('m1', {
        ...seen,
        state: 'handled',
        outcome: {
          invocationId: 'child-1',
          disposition: 'responded',
          evidenceRef: { kind: 'invocation_lineage', invocationId: 'child-1' },
          handledAt: 200,
        },
      }),
      sourceMessage('m2', {
        ...seen,
        state: 'handled',
        outcome: {
          invocationId: 'child-1',
          disposition: 'completed_with_turn',
          evidenceRef: { kind: 'invocation_lineage', invocationId: 'child-1' },
          handledAt: 210,
        },
      }),
      sourceMessage('m3', seen),
      sourceMessage('m4', { ...seen, state: 'withdrawn', withdrawnAt: 250 }),
    ];

    const projection = projectTurnAbsorptionSummary(messages, 'child-1');
    expect(projection?.counts).toEqual({
      total: 4,
      handled: 2,
      responded: 1,
      completedWithTurn: 1,
      actionable: 1,
      withdrawnAfterExposureUnhandled: 1,
    });
    expect(projection?.items.map((item) => item.kind)).toEqual([
      'responded',
      'completed_with_turn',
      'actionable',
      'withdrawn_after_exposure',
    ]);
    expect(projection?.items[0]).toMatchObject({ handlerCatId: 'codex', outcomeAt: 200 });
    expect(projection?.items[0]).not.toHaveProperty('catId');
    expect(projection?.defaultExpanded).toBe(false);
    expect(projection?.items[3]?.recalled).toBe(false);
  });

  it('keeps handled-after-recall in its handling bucket instead of double counting withdrawal', () => {
    const projection = projectTurnAbsorptionSummary(
      [
        sourceMessage(
          'm1',
          {
            ...seen,
            state: 'handled',
            outcome: {
              invocationId: 'child-1',
              disposition: 'completed_with_turn',
              evidenceRef: { kind: 'invocation_lineage', invocationId: 'child-1' },
              handledAt: 210,
            },
          },
          { recalled: true },
        ),
      ],
      'child-1',
    );

    expect(projection?.counts).toMatchObject({
      total: 1,
      handled: 1,
      completedWithTurn: 1,
      withdrawnAfterExposureUnhandled: 0,
    });
    expect(projection?.items[0]).toMatchObject({ kind: 'completed_with_turn', recalled: true });
  });

  it('preserves cross-thread receipt scope so presentation cannot confuse carrier and work terminality', () => {
    const projection = projectTurnAbsorptionSummary(
      [
        sourceMessage(
          'm-cross-thread',
          {
            ...seen,
            state: 'handled',
            outcome: {
              invocationId: 'child-1',
              disposition: 'completed_with_turn',
              evidenceRef: { kind: 'invocation_lineage', invocationId: 'child-1' },
              handledAt: 210,
            },
          },
          { scope: 'cross_thread_delivery' },
        ),
      ],
      'child-1',
    );

    expect(projection?.items[0]).toMatchObject({
      kind: 'completed_with_turn',
      receiptScope: 'cross_thread_delivery',
    });
  });

  it('excludes primary/successor triggers, content-free notice-only rows, other children and zero-exposure recall', () => {
    const messages: ChatMessage[] = [
      sourceMessage('m1', seen, { scope: 'primary_trigger' }),
      sourceMessage('m2', { catId: 'codex', state: 'notified', invocationId: 'child-1' }),
      sourceMessage('m3', { ...seen, invocationId: 'child-2' }),
      {
        ...sourceMessage('m4', { catId: 'codex', state: 'withdrawn', withdrawnAt: 250 }),
        extra: {
          ...sourceMessage('m4', { catId: 'codex', state: 'withdrawn', withdrawnAt: 250 }).extra,
          recall: { version: 1, exposure: 'none', recalledAt: 250 },
        },
      },
    ];

    expect(projectTurnAbsorptionSummary(messages, 'child-1')).toBeNull();
  });

  it('dedupes by source message, stays target-local, and expands at N <= 3', () => {
    const message = sourceMessage('m1', {
      ...seen,
      state: 'handled',
      outcome: {
        invocationId: 'child-1',
        disposition: 'responded',
        evidenceRef: { kind: 'invocation_lineage', invocationId: 'child-1' },
        handledAt: 200,
      },
    });
    const receipt = message.extra?.queueReceipt;
    if (!receipt) throw new Error('fixture must include a queue receipt');
    receipt.targets.push({
      catId: 'fable5',
      state: 'handled',
      invocationId: 'child-2',
      seenAt: 101,
      outcome: {
        invocationId: 'child-2',
        disposition: 'completed_with_turn',
        evidenceRef: { kind: 'invocation_lineage', invocationId: 'child-2' },
        handledAt: 205,
      },
    });

    const projection = projectTurnAbsorptionSummary([message], 'child-1');
    expect(projection?.counts.total).toBe(1);
    expect(projection?.counts.responded).toBe(1);
    expect(projection?.defaultExpanded).toBe(true);
    expect(projection?.items[0]?.bodyProjectedHere).toBe(true);
    expect(shouldFoldSourceIntoTurnSummary(message, 'child-1')).toBe(true);
    expect(shouldFoldSourceIntoTurnSummary(message, 'child-2')).toBe(false);
    expect(shouldFoldSourceIntoTurnSummary(message, 'unknown-child')).toBe(false);
  });

  it('never folds still-actionable or withdrawn-unhandled source bodies', () => {
    expect(shouldFoldSourceIntoTurnSummary(sourceMessage('m1', seen), 'child-1')).toBe(false);
    expect(
      shouldFoldSourceIntoTurnSummary(
        sourceMessage('m2', { ...seen, state: 'withdrawn', withdrawnAt: 250 }, { recalled: true }),
        'child-1',
      ),
    ).toBe(false);
  });

  it('moves a source body only after every target is terminal and chooses one canonical footer', () => {
    const message = sourceMessage('m1', {
      ...seen,
      state: 'handled',
      outcome: {
        invocationId: 'child-1',
        disposition: 'responded',
        evidenceRef: { kind: 'invocation_lineage', invocationId: 'child-1' },
        handledAt: 200,
      },
    });
    message.extra?.queueReceipt?.targets.push({
      catId: 'fable5',
      state: 'seen',
      invocationId: 'child-2',
      seenAt: 120,
    });

    expect(shouldFoldSourceBody(message)).toBe(false);
    expect(foldedSourceInvocationId(message)).toBeUndefined();

    const secondTarget = message.extra?.queueReceipt?.targets[1];
    if (!secondTarget) throw new Error('fixture requires the second target');
    secondTarget.state = 'withdrawn';
    secondTarget.withdrawnAt = 240;
    expect(shouldFoldSourceBody(message)).toBe(true);
    expect(foldedSourceInvocationId(message)).toBe('child-1');
  });
});
