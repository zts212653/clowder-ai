import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeTaskPipeline } from '../dist/infrastructure/scheduler/execute-pipeline.js';
import { createAlphaBrowserTemplate } from '../src/infrastructure/scheduler/templates/alpha-browser.ts';

function fixture() {
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

test('alpha failure replay keeps one Task while allowing at-least-once owner notification', async () => {
  const f = fixture(),
    template = createAlphaBrowserTemplate(f.options);
  assert.ok(template, 'alpha template must exist');
  const spec = template.createSpec('alpha-subscription', f.params);
  assert.equal(spec.run.overlap, 'skip');
  const admission = await spec.admission.gate({ taskId: spec.id });
  assert.equal(admission.run, true);
  for (let i = 0; i < 2; i++) await spec.run.execute(admission.workItems[0].signal, 'alpha', f.context);
  assert.equal(f.tasks.size, 1);
  const task = [...f.tasks.values()][0];
  assert.equal(task.ownerCatId, 'fixture-cat');
  assert.equal(task.userId, 'owner');
  assert.equal(task.threadId, 'gate-owner');
  assert.match(task.title, /P1/);
  assert.match(task.why, /exact-job/);
  assert.match(task.why, /git:head:docs\/feature.md/);
  assert.equal(f.delivered.length, 2);
  assert.equal(f.triggered.length, 2);
});

for (const phase of ['deliver', 'trigger']) {
  for (const ownership of ['owner', 'guardian']) {
    test(`alpha retries ${phase} failure after Task creation before settling (${ownership})`, async () => {
      const f = fixture();
      let attempts = 0,
        settled = 0;
      const run = f.runtime.runAlphaBrowserRevision;
      f.runtime.runAlphaBrowserRevision = async (input) => {
        const result = await run(input);
        settled++;
        return result;
      };
      if (ownership === 'guardian') {
        const drafts = f.runtime.alphaBrowserFailureTasks;
        f.runtime.alphaBrowserFailureTasks = async () =>
          (await drafts()).map((draft) => ({ ...draft, ownerCatId: null, ownership: 'unresolved' }));
      }
      const failOnce = async () => {
        if (++attempts === 1) throw new Error(`transient ${phase} outage`);
      };
      if (phase === 'deliver') {
        const deliver = f.context.deliver;
        f.context.deliver = async (input) => {
          await failOnce();
          return deliver(input);
        };
      } else {
        const trigger = f.context.invokeTrigger.trigger;
        f.context.invokeTrigger.trigger = async (...args) => {
          await failOnce();
          return trigger(...args);
        };
      }
      const spec = createAlphaBrowserTemplate(f.options).createSpec('alpha-subscription', f.params);
      await assert.rejects(spec.run.execute('alpha', 'alpha', f.context), /transient/);
      assert.equal(settled, 0);
      assert.equal(f.tasks.size, 1);
      const taskId = [...f.tasks.values()][0].id;
      await spec.run.execute('alpha', 'alpha', f.context);
      assert.equal(settled, 1);
      assert.equal(f.tasks.size, 1);
      assert.equal([...f.tasks.values()][0].id, taskId);
      assert.equal(f.triggered.length, 1, 'owner/guardian must be awakened before settlement');
      assert.equal(f.triggered[0][1], 'fixture-cat');
      assert.equal([...f.tasks.values()][0].ownerCatId, ownership === 'owner' ? 'fixture-cat' : null);
    });
  }
}

test('a full invocation queue cannot settle a revision and can retry the existing Task', async () => {
  const f = fixture();
  let attempts = 0;
  f.context.invokeTrigger.trigger = async () => (++attempts === 1 ? 'full' : 'enqueued');
  const spec = createAlphaBrowserTemplate(f.options).createSpec('alpha-subscription', f.params);
  await assert.rejects(spec.run.execute('alpha', 'alpha', f.context), /wake not accepted/);
  assert.equal(f.tasks.size, 1);
  await spec.run.execute('alpha', 'alpha', f.context);
  assert.equal(attempts, 2);
  assert.equal(f.tasks.size, 1);
});

test('missing exact baseline or delivery target cannot silently start full alpha work', async () => {
  const f = fixture(),
    template = createAlphaBrowserTemplate(f.options);
  assert.ok(template);
  for (const params of [
    { ...f.params, deliveryThreadId: null },
    { ...f.params, params: { ...f.params.params, baselineSha: 'main' } },
    { ...f.params, params: { ...f.params.params, guardianCatId: 'unknown' } },
  ]) {
    const spec = template.createSpec('alpha-subscription', params);
    assert.equal((await spec.admission.gate({ taskId: spec.id })).run, false);
  }
});

test('incomplete execution is a failed scheduler run, not a delivered verification result', async () => {
  const f = fixture();
  const runtime = await f.options.loadRuntime();
  f.options.loadRuntime = async () => ({
    ...runtime,
    runAlphaBrowserRevision: async () => ({ status: 'incomplete', headSha: 'b'.repeat(40) }),
  });
  const task = createAlphaBrowserTemplate(f.options).createSpec('alpha-subscription', f.params);
  const rows = [];
  await executeTaskPipeline({
    task,
    ledger: { record: (row) => rows.push(row) },
    logger: { info() {}, error() {} },
    running: new Map(),
    tickCounts: new Map(),
    lastRunAt: new Map(),
  });
  assert.equal(rows.at(-1).outcome, 'RUN_FAILED');
  assert.match(rows.at(-1).error_summary, /incomplete.*bbbbbbbb/u);
  assert.equal(f.tasks.size, 0);
});
