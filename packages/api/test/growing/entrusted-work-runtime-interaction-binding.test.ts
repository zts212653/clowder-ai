import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TaskItem } from '@cat-cafe/shared';
import { resolveEntrustedWorkTaskRefFromSource } from '../../src/domains/growing/EntrustedWorkRuntimeInteractionBinding.js';

const now = 1_777_000_000_000;

function task(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: 'task-1',
    kind: 'work',
    threadId: 'thread-1',
    subjectKey: 'entrusted:digest-1',
    title: 'Prepare the real presentation',
    ownerCatId: 'codex-sol',
    status: 'doing',
    why: 'The user entrusted this work here',
    createdBy: 'codex-sol',
    createdAt: now,
    updatedAt: now,
    userId: 'user-1',
    entrustedWork: {
      revision: 3,
      admission: {
        basis: 'explicit_entrustment',
        sourceRefs: ['message:source-1'],
        idempotencyKey: 'entrusted:source-1',
        receiptRef: 'task:receipt:entrusted:digest-1:1',
        admittedAt: now,
      },
      intendedOutcome: 'A reviewable presentation is ready',
      time: {},
      artifactRefs: ['artifact:ppt-1'],
      closure: {
        state: 'open',
        condition: 'The presentation is reviewable',
        expectedSignal: 'artifact:ppt-1:reviewable',
        evidenceRefs: [],
      },
    },
    ...overrides,
  };
}

describe('F310 source-bound F306 producer link', () => {
  it('returns one current Task ref only for the exact source, owner, and thread', () => {
    const baseEntrustedWork = task().entrustedWork;
    assert.ok(baseEntrustedWork);

    assert.deepEqual(
      resolveEntrustedWorkTaskRefFromSource([task()], {
        sourceMessageId: 'source-1',
        threadId: 'thread-1',
        ownerUserId: 'user-1',
        ownerCatId: 'codex-sol',
      }),
      { subjectRef: 'task:work:task-1', observedRevision: 3 },
    );

    for (const candidate of [
      task({ threadId: 'thread-2' }),
      task({ userId: 'user-2' }),
      task({ ownerCatId: 'codex-terra' }),
      task({ status: 'done' }),
      task({
        entrustedWork: {
          ...baseEntrustedWork,
          closure: {
            ...baseEntrustedWork.closure,
            state: 'satisfied',
            evidenceRefs: ['artifact:ppt-1:reviewable'],
          },
        },
      }),
    ]) {
      assert.equal(
        resolveEntrustedWorkTaskRefFromSource([candidate], {
          sourceMessageId: 'source-1',
          threadId: 'thread-1',
          ownerUserId: 'user-1',
          ownerCatId: 'codex-sol',
        }),
        undefined,
      );
    }
  });

  it('fails closed when the source maps to zero or multiple open Tasks', () => {
    const binding = {
      sourceMessageId: 'source-1',
      threadId: 'thread-1',
      ownerUserId: 'user-1',
      ownerCatId: 'codex-sol' as const,
    };
    assert.equal(resolveEntrustedWorkTaskRefFromSource([], binding), undefined);
    assert.equal(
      resolveEntrustedWorkTaskRefFromSource(
        [task(), task({ id: 'task-2', subjectKey: 'entrusted:digest-2' })],
        binding,
      ),
      undefined,
    );
  });
});
