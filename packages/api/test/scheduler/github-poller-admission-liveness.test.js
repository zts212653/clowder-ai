import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskStore } from '../../dist/domains/cats/services/stores/ports/TaskStore.js';
import { createCiCdCheckTaskSpec } from '../../dist/infrastructure/email/CiCdCheckTaskSpec.js';
import { createConflictCheckTaskSpec } from '../../dist/infrastructure/email/ConflictCheckTaskSpec.js';
import { executeTaskPipeline } from '../../dist/infrastructure/scheduler/execute-pipeline.js';

const log = { info() {}, warn() {}, error() {} };
function trackedStore() {
  const store = new TaskStore();
  for (let n = 1; n <= 3; n++)
    store.create({
      kind: 'pr_tracking',
      threadId: `thread-${n}`,
      subjectKey: `pr:owner/repo#${n}`,
      title: 'tracked',
      ownerCatId: 'codex-astra',
      why: 'test',
      createdBy: 'codex-astra',
      userId: 'u',
    });
  return store;
}

test('conflict admission propagates its deadline, retains cleanup ownership, and resumes the next PR', async () => {
  const store = trackedStore();
  const before = structuredClone(store.listByKind('pr_tracking'));
  let release;
  const cleanup = new Promise((resolve) => {
    release = resolve;
  });
  let first = true;
  const calls = [];
  const spec = createConflictCheckTaskSpec({
    taskStore: store,
    log,
    conflictRouter: {
      async route() {
        assert.fail('cancelled gate cannot execute');
      },
    },
    async checkMergeable(_repo, pr, signal) {
      calls.push({ pr, signal });
      if (first) {
        first = false;
        await cleanup;
      }
      signal?.throwIfAborted();
      return { mergeState: 'MERGEABLE', headSha: 'a'.repeat(40) };
    },
  });
  spec.admission.timeoutMs = 10;
  const records = [];
  const context = {
    task: spec,
    ledger: { record: (row) => records.push(row) },
    logger: log,
    running: new Map(),
    tickCounts: new Map(),
    lastRunAt: new Map(),
  };
  let settled = false;
  const pending = executeTaskPipeline(context)
    .then(
      () => null,
      (e) => e,
    )
    .finally(() => {
      settled = true;
    });
  await delay(30);
  const during = { settled, running: context.running.get(spec.id), firstSignal: calls[0]?.signal };
  await executeTaskPipeline(context);
  release();
  const error = await pending;
  assert.equal(during.settled, false);
  assert.equal(during.running, true);
  assert.equal(during.firstSignal?.aborted, true, 'whole-gate cancellation reaches checkMergeable');
  assert.equal(calls.length, 1, 'aborted admission must not start later PRs');
  assert(records.some((row) => row.outcome === 'SKIP_OVERLAP'));
  assert.match(String(error), /admission timed out/);
  assert.equal(records.at(-1).outcome, 'RUN_FAILED');
  assert.deepEqual(store.listByKind('pr_tracking'), before);
  await spec.admission.gate({
    taskId: spec.id,
    tickCount: 2,
    lastRunAt: null,
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 30_000,
  });
  assert.equal(calls[1].pr, 2, 'unprocessed objects remain reachable on the next poll');
});

test('CI batch belongs to the gate signal and cannot return work after cancellation', async () => {
  const controller = new AbortController();
  let release, began, observedSignal;
  const started = new Promise((resolve) => {
    began = resolve;
  });
  const cleanup = new Promise((resolve) => {
    release = resolve;
  });
  const spec = createCiCdCheckTaskSpec({
    taskStore: trackedStore(),
    log,
    cicdRouter: {},
    async fetchPrStatuses(_targets, signal) {
      observedSignal = signal;
      began();
      await cleanup;
      return new Map();
    },
  });
  let settled = false;
  const pending = spec.admission
    .gate({ taskId: spec.id, tickCount: 1, lastRunAt: null, signal: controller.signal })
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    .finally(() => {
      settled = true;
    });
  await started;
  controller.abort(new Error('whole CI tick cancelled'));
  await delay(0);
  assert.equal(settled, false, 'batch owns cleanup until its read settles');
  release();
  const result = await pending;
  assert.equal(observedSignal, controller.signal, 'batch must use whole-gate signal');
  assert.match(String(result.error), /whole CI tick cancelled/);
  assert.equal(result.value, undefined);
});

test('CI pipeline retains its overlap lock until the active gh request actually finishes abort cleanup', async () => {
  const { fetchPrCiStatuses } = await import('../../dist/infrastructure/email/ci-status-batch-fetcher.js');
  let release, began, childSignal;
  const started = new Promise((resolve) => {
    began = resolve;
  });
  const cleanup = new Promise((resolve) => {
    release = resolve;
  });
  const spec = createCiCdCheckTaskSpec({
    taskStore: trackedStore(),
    log,
    cicdRouter: {},
    fetchPrStatuses: (targets, signal) =>
      fetchPrCiStatuses(targets, log, {
        ghToken: 'ci-owned-cleanup',
        signal,
        execFileAsync: async (_file, _args, options) => {
          childSignal = options.signal;
          began();
          await cleanup;
          options.signal.throwIfAborted();
          return { stdout: '{}' };
        },
      }),
  });
  spec.admission.timeoutMs = 10;
  const records = [];
  const context = {
    task: spec,
    ledger: { record: (row) => records.push(row) },
    logger: log,
    running: new Map(),
    tickCounts: new Map(),
    lastRunAt: new Map(),
  };
  const pending = executeTaskPipeline(context).then(
    () => null,
    (error) => error,
  );
  await started;
  await delay(30);
  const during = { running: context.running.get(spec.id), aborted: childSignal.aborted };
  release();
  const error = await pending;
  assert.equal(during.aborted, true);
  assert.equal(during.running, true, 'active gh cleanup still belongs to the whole gate');
  assert.match(String(error), /admission timed out/);
  assert.equal(context.running.get(spec.id), false);
});
