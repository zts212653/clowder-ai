// @ts-check

import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  computeAggregateBucket,
  normalizeBucket,
  normalizePrState,
} from '../dist/infrastructure/email/CiCdCheckPoller.js';

// ─── Integration: CI failure triggers urgent policy (KD-4) ─────────

describe('CiCdCheckPoller trigger policy', () => {
  it('CI failure uses urgent priority (KD-4: aligned with github-review)', async () => {
    /** @type {import('../dist/infrastructure/email/ConnectorInvokeTrigger.js').ConnectorTriggerPolicy | undefined} */
    let capturedPolicy;
    const mockTrigger = {
      trigger: (_threadId, _catId, _userId, _content, _messageId, _contentBlocks, policy) => {
        capturedPolicy = policy;
      },
    };

    const mockRouter = {
      route: async () => ({
        kind: 'notified',
        threadId: 'thread_1',
        catId: 'opus',
        messageId: 'msg_1',
        bucket: 'fail',
        content: 'CI failed',
      }),
    };

    const mockStore = {
      listAll: async () => [
        {
          repoFullName: 'org/repo',
          prNumber: 1,
          threadId: 'thread_1',
          catId: 'opus',
          userId: 'user_1',
          registeredAt: Date.now(),
          ciTrackingEnabled: true,
        },
      ],
    };

    const mockLog = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };

    const { CiCdCheckPoller } = await import('../dist/infrastructure/email/CiCdCheckPoller.js');

    const poller = new CiCdCheckPoller({
      prTrackingStore: mockStore,
      cicdRouter: mockRouter,
      invokeTrigger: mockTrigger,
      log: mockLog,
    });

    poller.fetchPrStatus = async () => ({
      repoFullName: 'org/repo',
      prNumber: 1,
      headSha: 'abc123',
      prState: 'open',
      aggregateBucket: 'fail',
      checks: [{ name: 'ci', bucket: 'fail' }],
    });

    await poller.pollAll();

    assert.ok(capturedPolicy, 'trigger should have been called with a policy');
    assert.strictEqual(capturedPolicy.priority, 'urgent', 'CI failure must use urgent priority (KD-4)');
    assert.strictEqual(capturedPolicy.reason, 'github_ci_failure');
  });

  it('CI success does not trigger invocation', async () => {
    let triggerCalled = false;
    const mockTrigger = {
      trigger: () => {
        triggerCalled = true;
      },
    };

    const mockRouter = {
      route: async () => ({
        kind: 'notified',
        threadId: 'thread_1',
        catId: 'opus',
        messageId: 'msg_1',
        bucket: 'pass',
        content: 'CI passed',
      }),
    };

    const mockStore = {
      listAll: async () => [
        {
          repoFullName: 'org/repo',
          prNumber: 1,
          threadId: 'thread_1',
          catId: 'opus',
          userId: 'user_1',
          registeredAt: Date.now(),
          ciTrackingEnabled: true,
        },
      ],
    };

    const mockLog = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };

    const { CiCdCheckPoller } = await import('../dist/infrastructure/email/CiCdCheckPoller.js');

    const poller = new CiCdCheckPoller({
      prTrackingStore: mockStore,
      cicdRouter: mockRouter,
      invokeTrigger: mockTrigger,
      log: mockLog,
    });

    poller.fetchPrStatus = async () => ({
      repoFullName: 'org/repo',
      prNumber: 1,
      headSha: 'abc123',
      prState: 'open',
      aggregateBucket: 'pass',
      checks: [{ name: 'ci', bucket: 'pass' }],
    });

    await poller.pollAll();

    assert.strictEqual(triggerCalled, false, 'CI success should NOT trigger invocation');
  });
});

// ─── Unit tests for pure helper functions ──────────────────────────

describe('normalizePrState', () => {
  it('returns merged when mergedAt is set', () => {
    assert.strictEqual(normalizePrState('MERGED', '2026-01-01'), 'merged');
  });

  it('returns merged when state is MERGED', () => {
    assert.strictEqual(normalizePrState('MERGED', null), 'merged');
  });

  it('returns closed when state is CLOSED', () => {
    assert.strictEqual(normalizePrState('CLOSED', null), 'closed');
  });

  it('returns open for OPEN state', () => {
    assert.strictEqual(normalizePrState('OPEN', null), 'open');
  });

  it('returns open for unknown state', () => {
    assert.strictEqual(normalizePrState('UNKNOWN', null), 'open');
  });
});

describe('normalizeBucket', () => {
  it('normalizes pass/success to pass', () => {
    assert.strictEqual(normalizeBucket('pass'), 'pass');
    assert.strictEqual(normalizeBucket('success'), 'pass');
    assert.strictEqual(normalizeBucket('SUCCESS'), 'pass');
  });

  it('normalizes fail/failure/error to fail', () => {
    assert.strictEqual(normalizeBucket('fail'), 'fail');
    assert.strictEqual(normalizeBucket('failure'), 'fail');
    assert.strictEqual(normalizeBucket('error'), 'fail');
    assert.strictEqual(normalizeBucket('FAILURE'), 'fail');
  });

  it('normalizes everything else to pending', () => {
    assert.strictEqual(normalizeBucket('pending'), 'pending');
    assert.strictEqual(normalizeBucket('in_progress'), 'pending');
    assert.strictEqual(normalizeBucket('queued'), 'pending');
  });
});

describe('computeAggregateBucket', () => {
  it('returns pending for empty rollup', () => {
    assert.strictEqual(computeAggregateBucket([]), 'pending');
  });

  it('returns pass when all checks succeed', () => {
    const rollup = [
      { status: 'COMPLETED', conclusion: 'success', __typename: 'CheckRun' },
      { status: 'COMPLETED', conclusion: 'skipped', __typename: 'CheckRun' },
    ];
    assert.strictEqual(computeAggregateBucket(rollup), 'pass');
  });

  it('returns fail when any check fails', () => {
    const rollup = [
      { status: 'COMPLETED', conclusion: 'success', __typename: 'CheckRun' },
      { status: 'COMPLETED', conclusion: 'failure', __typename: 'CheckRun' },
    ];
    assert.strictEqual(computeAggregateBucket(rollup), 'fail');
  });

  it('returns pending when checks are still in progress', () => {
    const rollup = [
      { status: 'COMPLETED', conclusion: 'success', __typename: 'CheckRun' },
      { status: 'IN_PROGRESS', conclusion: '', __typename: 'CheckRun' },
    ];
    assert.strictEqual(computeAggregateBucket(rollup), 'pending');
  });

  it('handles StatusContext (commit statuses)', () => {
    const rollup = [{ status: 'failure', conclusion: '', __typename: 'StatusContext' }];
    assert.strictEqual(computeAggregateBucket(rollup), 'fail');
  });

  it('StatusContext success returns pass', () => {
    const rollup = [{ status: 'success', conclusion: '', __typename: 'StatusContext' }];
    assert.strictEqual(computeAggregateBucket(rollup), 'pass');
  });

  it('StatusContext pending returns pending', () => {
    const rollup = [{ status: 'pending', conclusion: '', __typename: 'StatusContext' }];
    assert.strictEqual(computeAggregateBucket(rollup), 'pending');
  });

  it('timed_out conclusion counts as failure', () => {
    const rollup = [{ status: 'COMPLETED', conclusion: 'timed_out', __typename: 'CheckRun' }];
    assert.strictEqual(computeAggregateBucket(rollup), 'fail');
  });

  it('cancelled conclusion counts as failure', () => {
    const rollup = [{ status: 'COMPLETED', conclusion: 'cancelled', __typename: 'CheckRun' }];
    assert.strictEqual(computeAggregateBucket(rollup), 'fail');
  });

  it('failure takes priority over pending', () => {
    const rollup = [
      { status: 'IN_PROGRESS', conclusion: '', __typename: 'CheckRun' },
      { status: 'COMPLETED', conclusion: 'failure', __typename: 'CheckRun' },
    ];
    assert.strictEqual(computeAggregateBucket(rollup), 'fail');
  });
});
