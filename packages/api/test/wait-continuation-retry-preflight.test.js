import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { WaitContinuationRetryPreflight } from '../dist/domains/ball-custody/WaitContinuationRetryPreflight.js';

const outcome = (ownerFence, overrides = {}) => ({
  v: 1,
  outcomeId: 'wait:pr:zts212653/cat-cafe#1:g4:matched',
  generation: 4,
  subjectRef: 'pr:zts212653/cat-cafe#1',
  ownerFence,
  reason: 'matched',
  at: 1_000,
  delivery: 'delivered',
  nextStep: 'continue exact work',
  ...overrides,
});

const task = (waitOutcome, overrides = {}) => ({
  id: 'task-wait-1',
  kind: 'pr_tracking',
  threadId: 'thread-1',
  subjectKey: 'pr:zts212653/cat-cafe#1',
  title: 'wait',
  ownerCatId: 'codex-sol',
  status: 'done',
  why: 'test',
  createdBy: 'codex-sol',
  createdAt: 1,
  updatedAt: 2,
  userId: 'user-1',
  automationState: { waitOutcome },
  ...overrides,
});

const waitMessage = (ownerFence, overrides = {}) => ({
  catId: 'system',
  threadId: 'thread-1',
  userId: 'user-1',
  source: {
    connector: 'github-wait',
    meta: {
      waitContinuationCarrier: {
        v: 1,
        waitId: 'task-wait-1',
        outcomeId: 'wait:pr:zts212653/cat-cafe#1:g4:matched',
        ownerFence,
      },
    },
  },
  ...overrides,
});

const createPreflight = ({ storedTask, leaseResult } = {}) => {
  const leaseCalls = [];
  return {
    leaseCalls,
    service: new WaitContinuationRetryPreflight({
      taskStore: { get: async () => storedTask ?? null },
      actionSuccessorLeaseStore: {
        preflightOutput: async (...args) => {
          leaseCalls.push(args);
          return leaseResult ?? { ok: true, reason: 'active' };
        },
      },
    }),
  };
};

const request = (message, overrides = {}) => ({
  message,
  requestingUserId: 'user-1',
  targetCatId: 'codex-sol',
  ...overrides,
});

describe('Gate 5 wait continuation retry preflight', () => {
  test('accepts an authenticated ordinary user message without a synthetic action fence', async () => {
    const { service } = createPreflight();
    assert.deepEqual(await service.preflight(request({ catId: null, threadId: 'thread-1', userId: 'user-1' })), {
      ok: true,
      kind: 'user',
    });
  });

  test('accepts only the exact containing-task outcome, generation, owner, thread, and user', async () => {
    const fence = { kind: 'containing_task', generation: 4 };
    const exactTask = task(outcome(fence));
    const { service } = createPreflight({ storedTask: exactTask });
    assert.deepEqual(await service.preflight(request(waitMessage(fence))), {
      ok: true,
      kind: 'wait_containing_task',
    });

    for (const [label, mutatedTask, expectedReason] of [
      ['missing task', null, 'task_missing'],
      ['foreign user', task(outcome(fence), { userId: 'user-2' }), 'task_identity_mismatch'],
      ['foreign thread', task(outcome(fence), { threadId: 'thread-2' }), 'task_identity_mismatch'],
      ['foreign owner', task(outcome(fence), { ownerCatId: 'opus' }), 'owner_mismatch'],
      ['different outcome', task(outcome(fence, { outcomeId: 'other-outcome' })), 'outcome_mismatch'],
      [
        'different generation',
        task(outcome({ kind: 'containing_task', generation: 5 }, { generation: 5 })),
        'outcome_mismatch',
      ],
    ]) {
      const candidate = createPreflight({ storedTask: mutatedTask }).service;
      assert.deepEqual(
        await candidate.preflight(request(waitMessage(fence))),
        { ok: false, reason: expectedReason },
        label,
      );
    }
  });

  test('requires an active exact action-successor generation assigned to the target', async () => {
    const fence = { kind: 'action_successor', leaseId: 'lease-1', generation: 7 };
    const exactTask = task(outcome(fence, { generation: 4 }));
    const { service, leaseCalls } = createPreflight({ storedTask: exactTask });
    assert.deepEqual(await service.preflight(request(waitMessage(fence))), {
      ok: true,
      kind: 'wait_action_successor',
    });
    assert.deepEqual(leaseCalls, [['lease-1', 7, 'codex-sol']]);
  });

  test('maps every action-successor denial without mutating or downgrading to generic execution', async () => {
    const fence = { kind: 'action_successor', leaseId: 'lease-1', generation: 7 };
    const exactTask = task(outcome(fence));
    for (const reason of [
      'lease_missing',
      'stale_generation',
      'lease_not_active',
      'holder_not_assigned',
      'holder_terminal',
      'subject_terminal',
    ]) {
      const { service } = createPreflight({ storedTask: exactTask, leaseResult: { ok: false, reason } });
      assert.deepEqual(await service.preflight(request(waitMessage(fence))), { ok: false, reason });
    }

    const { service } = createPreflight({
      storedTask: exactTask,
      leaseResult: { ok: true, reason: 'verified_success' },
    });
    assert.deepEqual(await service.preflight(request(waitMessage(fence))), { ok: false, reason: 'holder_terminal' });
  });

  test('fails closed for malformed github-wait and unattributed agent or connector messages', async () => {
    const { service } = createPreflight();
    assert.deepEqual(
      await service.preflight(
        request({
          ...waitMessage({ kind: 'containing_task', generation: 4 }),
          source: { connector: 'github-wait', meta: { waitContinuationCarrier: { v: 1 } } },
        }),
      ),
      { ok: false, reason: 'invalid_wait_carrier' },
    );
    assert.deepEqual(await service.preflight(request({ catId: 'opus', threadId: 'thread-1', userId: 'user-1' })), {
      ok: false,
      reason: 'legacy_unattributed',
    });
    assert.deepEqual(
      await service.preflight(
        request({ catId: null, threadId: 'thread-1', userId: 'system' }, { requestingUserId: 'system' }),
      ),
      { ok: false, reason: 'legacy_unattributed' },
    );
    assert.deepEqual(
      await service.preflight(
        request({ catId: 'system', threadId: 'thread-1', userId: 'user-1', source: { connector: 'github' } }),
      ),
      { ok: false, reason: 'legacy_unattributed' },
    );
  });
});
