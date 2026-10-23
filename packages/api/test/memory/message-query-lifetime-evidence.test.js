import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { observeQueryQualification } from '../../dist/domains/memory/message-query-observation.js';
import { candidateKey, contentRevision } from '../../dist/domains/memory/message-query-protocol.js';
import { MessageQueryQualifier } from '../../dist/domains/memory/message-query-qualifier.js';
import { executeMessageSearch } from '../../dist/routes/message-search-handler.js';

test('deadline retains runner teardown ownership and reports bounded preparation/cancellation evidence', async (t) => {
  const controller = new AbortController();
  const reason = new DOMException('search deadline', 'TimeoutError');
  let release;
  let stopped = false;
  const candidates = [
    {
      threadId: 'PRIVATE-THREAD-CANARY',
      messageId: 'PRIVATE-MESSAGE-CANARY',
      content: 'PRIVATE-BODY-CANARY',
      contentRevision: contentRevision('PRIVATE-BODY-CANARY'),
    },
  ];
  const qualifier = new MessageQueryQualifier(async (_batch, context) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    stopped = true;
    assert.equal(context.signal.aborted, true);
    return '{}';
  });
  t.after(() => release?.());
  let settled = false;
  const pending = qualifier
    .qualify('PRIVATE-QUERY-CANARY', candidates, {
      userId: 'PRIVATE-OWNER-CANARY',
      deadlineAt: Date.now() + 5000,
      signal: controller.signal,
    })
    .then(
      () => {
        settled = true;
      },
      (error) => {
        settled = true;
        throw error;
      },
    );
  controller.abort(reason);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'request cancellation does not release a still-running runner');
  const blocked = await qualifier.qualify('package login', candidates, {
    userId: 'owner',
    deadlineAt: Date.now() + 1000,
  });
  assert.equal(blocked.nativeCalls, 0, 'the reserved finalization window still forbids a new runner');
  release();
  await assert.rejects(pending, (error) => {
    assert.equal(error, reason);
    assert.equal(stopped, true);
    const observation = error.messageSearchQualification;
    assert.ok(observation, 'the original timeout must distinguish runner preparation from native launch');
    assert.equal(observation.runnerCalls, 1);
    assert.equal(observation.nativeLaunches, 0);
    assert.equal(observation.costReports, 0);
    assert.equal(observation.reportedCostUsd, null);
    assert.equal(observation.batches.length, 1);
    assert.equal(observation.batches[0].stage, 'runner');
    assert.equal(observation.batches[0].outcome, 'aborted');
    assert.ok(observation.batches[0].abortAfterMs >= 0);
    assert.ok(observation.batches[0].cleanupAfterAbortMs >= 0);
    assert.ok(!JSON.stringify(observation).includes('PRIVATE-'));
    return true;
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidateKey(candidates[0]), '["PRIVATE-THREAD-CANARY","PRIVATE-MESSAGE-CANARY"]');
});

test('deadline during slow cooperative teardown retains actual launch/cost coverage and remains an error', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
  const qualifier = new MessageQueryQualifier(async (_batch, ctx) => {
    ctx.onTrace({ phase: 'native-launch', body: 'PRIVATE-BODY', userId: 'PRIVATE-USER' });
    await new Promise((resolve) =>
      ctx.signal.addEventListener('abort', () => setTimeout(resolve, 1500), { once: true }),
    );
    return '{}';
  });
  const pending = qualifier.qualify(
    'package login',
    [
      {
        threadId: 'source',
        messageId: 'a',
        content: 'A credential was provisioned',
        contentRevision: contentRevision('A credential was provisioned'),
      },
    ],
    { userId: 'owner', deadlineAt: Date.now() + 3000 },
  );
  // Cancel at the existing 2s publication reserve, but emulate delayed teardown
  // and event-loop progress beyond the outer request deadline before settlement.
  t.mock.timers.tick(1000);
  t.mock.timers.tick(2100);
  await assert.rejects(pending, (error) => {
    assert.equal(error.name, 'TimeoutError');
    const d = error.messageSearchQualification;
    assert.equal(d.runnerCalls, 1);
    assert.equal(d.nativeLaunches, 1);
    assert.equal(d.batches[0].stage, 'native-launch');
    assert.equal(d.batches[0].outcome, 'aborted');
    assert.equal(d.reportedCostUsd, null, 'a launch is not a provider usage/cost receipt');
    assert.ok(!JSON.stringify(d).includes('PRIVATE'));
    return true;
  });
});

test('private diagnostics preserve frozen errors and never retain raw provider payloads', () => {
  const obs = observeQueryQualification();
  const batch = obs.start(3, 2000, Date.now() + 5000);
  batch.trace({ phase: 'PRIVATE-RAW-PHASE', query: 'PRIVATE-QUERY', body: 'PRIVATE-BODY' });
  batch.trace({ phase: 'native-usage', costUsd: Number.NaN, usage: { subject: 'PRIVATE-OWNER' } });
  batch.trace({ phase: 'native-usage', costUsd: 0.002, prompt: 'PRIVATE-PROMPT' });
  batch.finish(false, false);
  const error = new Error('original');
  obs.attach(error);
  assert.equal(error.messageSearchQualification.batches[0].stage, 'native-usage');
  assert.equal(error.messageSearchQualification.costReports, 1);
  assert.equal(error.messageSearchQualification.reportedCostUsd, 0.002);
  assert.ok(!JSON.stringify(error.messageSearchQualification).includes('PRIVATE'));
  const frozen = Object.freeze(new Error('frozen'));
  assert.doesNotThrow(() => obs.attach(frozen));
  const hostile = new Error('hostile');
  Object.defineProperty(hostile, 'messageSearchQualification', {
    set() {
      throw new Error('setter');
    },
  });
  assert.doesNotThrow(() => obs.attach(hostile));
});

test('HTTP keeps qualification evidence private and preserves the original timeout503 contract', async () => {
  const error = new DOMException('Message search deadline exceeded', 'TimeoutError');
  const obs = observeQueryQualification();
  const run = obs.start(2, 1000, Date.now() + 5000);
  run.abort();
  run.finish(true, false);
  obs.attach(error);
  let status, logged;
  const reply = {
    raw: new EventEmitter(),
    status: (code) => {
      status = code;
    },
    log: {
      warn: (x) => {
        logged = x.err;
      },
    },
  };
  const response = await executeMessageSearch(
    {
      search: async () => {
        throw error;
      },
    },
    { query: 'PRIVATE-QUERY' },
    { userId: 'PRIVATE-OWNER', viewer: { type: 'user' } },
    reply,
  );
  assert.equal(status, 503);
  assert.equal(logged, error);
  assert.deepEqual(response, {
    error: 'Message search unavailable',
    degraded: true,
    degradeReason: 'message_search_timeout',
  });
  assert.ok(!JSON.stringify(response).includes('messageSearchQualification'));
});
