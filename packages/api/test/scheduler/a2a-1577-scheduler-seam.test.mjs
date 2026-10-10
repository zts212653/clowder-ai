import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createRepoScanTaskSpec } from '../../src/infrastructure/connectors/github-repo-event/RepoScanTaskSpec.ts';
import { createConflictCheckTaskSpec } from '../../src/infrastructure/email/ConflictCheckTaskSpec.ts';
import { createIssueCommentTaskSpec } from '../../src/infrastructure/email/IssueCommentTaskSpec.ts';
import { TaskRunnerV2 } from '../../src/infrastructure/scheduler/TaskRunnerV2.ts';

const log = { info() {}, error() {}, warn() {} };
const task = {
  id: 'issue-1',
  subjectKey: 'issue:acme/app#1',
  status: 'open',
  ownerCatId: 'opus',
  userId: 'user-1',
  threadId: 'thread-1',
};

test('issue metadata/comments receive bounded signals and wait delivery has no second trigger', async () => {
  const abort = new AbortController();
  const calls = [];
  const spec = createIssueCommentTaskSpec({
    taskStore: { listByKind: async () => [task] },
    issueCommentRouter: {
      route: async () => {
        throw new Error('typed wait owns admission');
      },
    },
    fetchIssueMetadata: async (_repo, _issue, signal) => {
      assert.ok(signal instanceof AbortSignal);
      return { state: 'open' };
    },
    fetchComments: async (_repo, _issue, _since, signal) => {
      assert.ok(signal instanceof AbortSignal);
      return [{ id: 2, author: 'alice', body: 'result', createdAt: '2026-10-07T00:00:00Z' }];
    },
    waitLifecycle: {
      observe: async (input) => {
        calls.push(input);
        return { kind: 'notified' };
      },
    },
    invokeTrigger: {
      trigger: () => {
        throw new Error('second owner resurrected');
      },
    },
    log,
  });
  const admitted = await spec.admission.gate({ signal: abort.signal, deadlineMs: Date.now() + 5000 });
  assert.equal(admitted.run, true);
  for (const item of admitted.workItems) await spec.run.execute(item.signal, item.subjectKey, {});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].facts.issue.comments[0].id, 2);
});

test('issue gate cancellation cannot produce a wait notification', async () => {
  const abort = new AbortController();
  abort.abort();
  const spec = createIssueCommentTaskSpec({
    taskStore: {
      listByKind: async () => {
        throw new Error('must not fetch');
      },
    },
    log,
  });
  await assert.rejects(spec.admission.gate({ signal: abort.signal }), { name: 'AbortError' });
});

test('repository scan admits delivery once and commits dedup despite cancellation after admission', async () => {
  const abort = new AbortController();
  const calls = [];
  const spec = createRepoScanTaskSpec({
    repoAllowlist: ['acme/app'],
    inboxCatId: 'opus',
    defaultUserId: 'user-1',
    bindingStore: { getByExternal: async () => ({ threadId: 'thread-1' }) },
    reconciliationDedup: { markNotified: async (...args) => calls.push(['dedup', ...args]) },
    deliveryDeps: {},
    deliverFn: async (_deps, input) => {
      calls.push(['delivery', input]);
      abort.abort();
      return { messageId: 'message-1', admitted: true };
    },
    invokeTrigger: {
      trigger: () => {
        throw new Error('second wake owner');
      },
    },
    log,
  });
  await spec.run.execute(
    {
      repoFullName: 'acme/app',
      subjectType: 'pr',
      number: 1,
      title: 'Result',
      authorLogin: 'alice',
      url: 'https://example.invalid/pr/1',
      deliveryId: 'scan-1',
      action: 'opened',
    },
    'pr:acme/app#1',
    { signal: abort.signal },
  );
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['delivery', 'dedup'],
  );
  assert.equal(calls[0][1].idempotencyKey, 'github-repo-event:scan-1');
});

test('repository delivery refusal cannot advance dedup', async () => {
  const spec = createRepoScanTaskSpec({
    repoAllowlist: ['acme/app'],
    inboxCatId: 'opus',
    defaultUserId: 'user-1',
    bindingStore: { getByExternal: async () => ({ threadId: 'thread-1' }) },
    reconciliationDedup: {
      markNotified: async () => {
        throw new Error('dedup must remain pending');
      },
    },
    deliveryDeps: {},
    deliverFn: async () => {
      throw new Error('admission refused');
    },
    log,
  });
  await assert.rejects(spec.run.execute({ repoFullName: 'acme/app' }, 'pr:acme/app#1', {}), /admission refused/);
});

test('explicit non-admission result is not a successful repository notification', async () => {
  let dedup = 0;
  const spec = createRepoScanTaskSpec({
    repoAllowlist: ['acme/app'],
    inboxCatId: 'opus',
    defaultUserId: 'user-1',
    bindingStore: { getByExternal: async () => ({ threadId: 'thread-1' }) },
    reconciliationDedup: {
      markNotified: async () => {
        dedup++;
      },
    },
    deliveryDeps: {},
    deliverFn: async () => ({ messageId: '', content: '', admitted: false, rejection: 'unavailable' }),
    log,
  });
  await assert.rejects(spec.run.execute({ repoFullName: 'acme/app' }, 'pr:acme/app#1', {}), /admission/);
  assert.equal(dedup, 0);
});

test('canceled conflict repair still publishes the already terminalized outcome once', async () => {
  const abort = new AbortController();
  const calls = [];
  const outcome = { reason: 'matched', outcomeId: 'outcome-1', matched: [{ kind: 'pr_became_conflicting' }] };
  const spec = createConflictCheckTaskSpec({
    taskStore: {},
    checkMergeable: async () => ({}),
    conflictRouter: {
      route: async () => ({ kind: 'matched_pending', taskId: 'task-1', outcome }),
      publish: async (...args) => calls.push(args),
    },
    autoExecutor: {
      resolve: async () => {
        abort.abort();
        throw abort.signal.reason;
      },
    },
    log,
  });
  await spec.run.execute(
    { signal: { repoFullName: 'acme/app', prNumber: 1, mergeState: 'CONFLICTING' } },
    'pr:acme/app#1',
    { signal: abort.signal },
  );
  assert.deepEqual(calls, [['task-1', outcome]]);
});

// Exercise the actual once scheduler; replace only its pipeline I/O with a ledger
// result, not its timer, retry selection, expiry, or retirement implementation.
async function onceCase(
  t,
  {
    lifecycle,
    outcome,
    holdStatus = 'active',
    enabled = true,
    initialAdvanceMs = 2,
    beforeSettlementMs = 0,
    onPending,
  },
) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 });
  let attempts = 0;
  let retired = 0;
  const id = 'hold-ball-seam';
  const def = {
    id,
    templateId: 'reminder',
    createdBy: 'hold-ball:opus',
    enabled: true,
    params: { holdLifecycle: { mode: 'wake_when', status: 'active' } },
  };
  const runner = new TaskRunnerV2({
    logger: log,
    ledger: { query: () => [{ outcome: attempts > 1 ? 'RUN_DELIVERED' : outcome }] },
    dynamicTaskStore: {
      getById: () => def,
      getPrivateOwnerAuthProvenance: () => 'strict',
      remove: () => {
        retired++;
      },
    },
    retryableHoldFailureDelayMs: 2,
  });
  runner.executePipeline = async () => {
    attempts++;
    def.params.holdLifecycle.status = holdStatus;
    def.enabled = enabled;
  };
  const spec = {
    id,
    enabled: () => true,
    profile: 'poller',
    trigger: { type: 'once', fireAt: Date.now() + 2 },
    admission: {},
    run: {},
    ...(lifecycle
      ? {
          onceLifecycle: {
            recoverMissed: true,
            scheduledAt: Date.now(),
            retryUntil: lifecycle === 'expired' ? Date.now() - 1 : Date.now() + 1000,
            retire: () => {
              retired++;
            },
          },
        }
      : {}),
  };
  runner.register(spec);
  runner.start();
  try {
    // Run the real timer and asynchronous pipeline separately. Wall-clock CPU
    // contention cannot consume the SLA or turn a pending retry into completion.
    t.mock.timers.tick(initialAdvanceMs);
    onPending?.({ attempts, retired });
    t.mock.timers.tick(beforeSettlementMs);
    await nextTurn();
    for (let turn = 0; retired === 0 && turn < 3; turn++) {
      t.mock.timers.tick(2);
      await nextTurn();
      t.mock.timers.tick(0);
      await nextTurn();
    }
    return { attempts, retired };
  } finally {
    runner.stop();
    t.mock.timers.reset();
  }
}

test('active managed hold retains retry without a timer lifecycle', async (t) => {
  assert.deepEqual(await onceCase(t, { outcome: 'RUN_FAILED' }), { attempts: 2, retired: 1 });
});
test('retired/disabled holds cannot retry through a stale recoverable lifecycle', async (t) => {
  assert.deepEqual(await onceCase(t, { lifecycle: 'active', outcome: 'RUN_FAILED', holdStatus: 'retired_by_event' }), {
    attempts: 1,
    retired: 1,
  });
  assert.deepEqual(await onceCase(t, { lifecycle: 'active', outcome: 'RUN_FAILED', enabled: false }), {
    attempts: 1,
    retired: 1,
  });
});
test('timer lifecycle retries overlap before expiry but not after its SLA', async (t) => {
  assert.deepEqual(await onceCase(t, { lifecycle: 'active', outcome: 'SKIP_OVERLAP' }), { attempts: 2, retired: 1 });
  assert.deepEqual(await onceCase(t, { lifecycle: 'expired', outcome: 'RUN_FAILED' }), { attempts: 1, retired: 1 });
});
test('governance skip obeys the same timer expiry', async (t) => {
  assert.deepEqual(await onceCase(t, { lifecycle: 'active', outcome: 'SKIP_GLOBAL_PAUSE' }), {
    attempts: 2,
    retired: 1,
  });
  assert.deepEqual(await onceCase(t, { lifecycle: 'expired', outcome: 'SKIP_GLOBAL_PAUSE' }), {
    attempts: 1,
    retired: 1,
  });
});

test('a delayed first timer must not be mistaken for completed governance retry', async (t) => {
  const completed = await onceCase(t, {
    lifecycle: 'active',
    outcome: 'SKIP_GLOBAL_PAUSE',
    initialAdvanceMs: 50,
    onPending: (state) => assert.deepEqual(state, { attempts: 1, retired: 0 }),
  });
  assert.deepEqual(completed, { attempts: 2, retired: 1 });
});

test('expiry while the first pipeline is settling prevents a governance retry', async (t) => {
  assert.deepEqual(await onceCase(t, { lifecycle: 'active', outcome: 'SKIP_GLOBAL_PAUSE', beforeSettlementMs: 1000 }), {
    attempts: 1,
    retired: 1,
  });
});
