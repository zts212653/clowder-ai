import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { EntrustedWorkHumanTerminalReceiptV1 } from '@cat-cafe/shared';
import { MessageStore, mergeMessageExtra } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { safeParseExtra } from '../../src/domains/cats/services/stores/redis/redis-message-parsers.js';
import { adaptMessageStore } from '../helpers/message-from-fixtures.js';

const receipt: EntrustedWorkHumanTerminalReceiptV1 = {
  v: 1,
  kind: 'entrusted_work_human_terminal',
  originalThreadId: 'thread-original',
  ownerUserId: 'operator',
  task: {
    taskId: 'task-a',
    subjectRef: 'task:work:task-a',
    ownerRef: 'task:item:task-a',
    previousRevision: 1,
    revision: 2,
  },
  decision: {
    decisionId: 'b5e80c62-2a8c-4554-8e72-9cf22ac0214a',
    state: 'cancelled',
    actorRef: 'user:operator',
    authorityRef: 'task:item:task-a#human-terminal:b5e80c62-2a8c-4554-8e72-9cf22ac0214a',
    decisionRef: 'task:work:task-a#human-decision:b5e80c62-2a8c-4554-8e72-9cf22ac0214a',
    decidedAt: 100,
    reason: 'No longer needed',
  },
  execution: {
    before: {
      v: 1,
      scope: 'task_binding',
      state: 'idle',
      reasonCode: 'unassigned_without_binding',
      canConfirmSatisfied: true,
      observedAt: 99,
      taskRef: {
        taskId: 'task-a',
        subjectRef: 'task:work:task-a',
        ownerRef: 'task:item:task-a',
        revision: 1,
      },
    },
    stop: { state: 'not_running', reasonCode: 'task_binding_idle', executionRefs: [] },
  },
  recordedAt: 101,
};

function message(overrides: Record<string, unknown> = {}) {
  return {
    threadId: receipt.originalThreadId,
    userId: receipt.ownerUserId,
    catId: null,
    content: '我不再继续这件。',
    mentions: [],
    timestamp: receipt.recordedAt,
    idempotencyKey: `entrusted-work-human-terminal:${receipt.task.taskId}:${receipt.decision.decisionId}`,
    extra: { entrustedWorkHumanTerminalReceiptV1: receipt },
    ...overrides,
  };
}

describe('F310 typed original-Thread terminal receipt', () => {
  test('validates exact Host-authenticated coordinates and survives memory/Redis hydration', () => {
    const store = adaptMessageStore(new MessageStore());
    const stored = store.append(message());
    assert.deepEqual(stored.extra?.entrustedWorkHumanTerminalReceiptV1, receipt);
    assert.deepEqual(
      safeParseExtra(JSON.stringify({ entrustedWorkHumanTerminalReceiptV1: receipt }))
        ?.entrustedWorkHumanTerminalReceiptV1,
      receipt,
    );
    const malformed = safeParseExtra(
      JSON.stringify({
        entrustedWorkHumanTerminalReceiptV1: {
          ...receipt,
          task: { ...receipt.task, subjectRef: 'task:work:other' },
        },
        isExplicitPost: true,
      }),
    );
    assert.equal(malformed?.entrustedWorkHumanTerminalReceiptV1, undefined);
    assert.equal(malformed?.isExplicitPost, true);

    for (const invalid of [
      message({ userId: 'someone-else' }),
      message({ threadId: 'thread-other' }),
      message({ catId: 'codex-sol' }),
      message({ timestamp: 102 }),
      message({ content: 'cancelled maybe' }),
    ]) {
      assert.throws(() => store.append(invalid as never), TypeError);
    }
  });

  test('generic extra patches and stream merges cannot replace the immutable receipt', () => {
    const store = adaptMessageStore(new MessageStore());
    const stored = store.append(message());
    const forged = {
      ...receipt,
      ownerUserId: 'attacker',
      decision: { ...receipt.decision, actorRef: 'user:attacker' },
    };
    const updated = store.updateExtra(stored.id, {
      entrustedWorkHumanTerminalReceiptV1: forged,
      isExplicitPost: true,
    } as never);
    assert.deepEqual(updated?.extra?.entrustedWorkHumanTerminalReceiptV1, receipt);
    assert.equal(updated?.extra?.isExplicitPost, true);

    assert.deepEqual(
      mergeMessageExtra({ entrustedWorkHumanTerminalReceiptV1: receipt }, {
        entrustedWorkHumanTerminalReceiptV1: forged,
      } as never)?.entrustedWorkHumanTerminalReceiptV1,
      receipt,
    );
  });
});
