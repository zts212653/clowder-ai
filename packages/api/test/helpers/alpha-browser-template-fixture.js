import assert from 'node:assert/strict';

export function fixture() {
  const tasks = new Map(),
    delivered = [],
    triggered = [];
  const runtime = {
    async runAlphaBrowserRevision(input) {
      assert.equal(input.originTaskId, 'alpha-subscription');
      assert.equal(input.ownerPrincipal, 'schedule:owner:alpha-subscription');
      assert.equal(input.targetSha, 'b'.repeat(40));
      const refs = await input.reportFailure({ verificationPlan: { testedHeadSha: 'b'.repeat(40) }, receipt: {} });
      return { status: 'red', headSha: 'b'.repeat(40), failureTaskRefs: refs };
    },
    async alphaBrowserFailureTasks() {
      return [
        {
          subjectKey: 'alpha-browser-failure:exact',
          kind: 'journey-failed',
          severity: 'P1',
          ownerCatId: 'fixture-cat',
          ownership: 'verified',
          ownerSourceRef: 'git:head:docs/feature.md',
          testedHeadSha: 'b'.repeat(40),
          jobId: 'exact-job',
          generation: 1,
          unitIds: ['browser:feature'],
        },
      ];
    },
    withAlphaBrowserCheckout: async () => assert.fail('runner owns this invocation'),
    executionApi: { GATE_EXECUTION_API_VERSION: 1 },
  };
  const options = {
    repoRoot: '/repo',
    ownerUserId: 'owner',
    resolveCat: (id) => (id === 'fixture-cat' ? id : null),
    isAvailable: () => true,
    getEngagementPolicy: () => undefined,
    tasks: {
      getBySubject: (key) => tasks.get(key) ?? null,
      upsertBySubject: (input) => {
        const task = { id: 'task-p1', ...input };
        tasks.set(input.subjectKey, task);
        return task;
      },
    },
    loadRuntime: async () => runtime,
    inspectMain: async () => ({ targetSha: 'b'.repeat(40), databasePath: '/gate.sqlite', legacyLockPath: '/legacy' }),
  };
  const params = {
    trigger: { type: 'cron', expression: '*/5 * * * *' },
    deliveryThreadId: 'gate-owner',
    params: { baselineSha: 'a'.repeat(40), guardianCatId: 'fixture-cat' },
  };
  return {
    options,
    params,
    tasks,
    delivered,
    triggered,
    runtime,
    context: {
      signal: new AbortController().signal,
      deliver: async (input) => {
        delivered.push(input);
        return 'message';
      },
      invokeTrigger: {
        trigger: async (...args) => {
          triggered.push(args);
          return 'enqueued';
        },
      },
    },
  };
}
