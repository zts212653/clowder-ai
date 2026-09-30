/**
 * F202 W2-3 h3b — reply polling follows the enabled package (frozen h3「回复轮询跟着已启用的包走」;
 * ledger「h3b 实现设计」, codex design review …000912).
 *
 * Nothing runs before `start()`; after it, no package means no timer and no log. Each lease is a
 * generation: the first round runs at once, rounds are chained (one in flight at most), failures
 * back off 2s → 60s with one line when they start and one when they stop, and nothing of an ended
 * generation (a late failure, an ack) reaches the next one. A round is list → Host ingest → ack of
 * exactly that return; ASSISTANT_RETURN_NOT_FOUND settles it.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { PluginConversationReturnPoller } from '../dist/domains/cats/services/cloud-bridge/plugin-conversation-host/plugin-conversation-return-poller.js';
import { CloudConversationHostRegistry } from '../dist/domains/plugin/declared/cloud-conversation-host-registry.js';
import { cleanup, conversationHostHarness, hostManifest, METHODS, settle } from './f202-w2-3-h3b.fixture.js';

after(cleanup);

const RETURN = {
  conversationId: 'conversation-1',
  sourceMessageId: 'source-1',
  assistantMessageId: 'assistant-1',
  content: 'the answer',
};
const CURSOR = { conversationId: 'conversation-1', sourceMessageId: 'source-1', assistantMessageId: 'assistant-1' };

function manualScheduler() {
  const entries = [];
  return {
    schedule(run, delayMs) {
      const entry = { run, delayMs, state: 'pending' };
      entries.push(entry);
      return {
        cancel: () => {
          if (entry.state === 'pending') entry.state = 'cancelled';
        },
      };
    },
    pending: () => entries.filter((entry) => entry.state === 'pending').map((entry) => entry.delayMs),
    /** Runs the one pending round and lets it settle; returns the delay it had been scheduled with. */
    async fire() {
      const due = entries.filter((entry) => entry.state === 'pending');
      assert.equal(due.length, 1, 'exactly one round is scheduled');
      due[0].state = 'fired';
      due[0].run();
      await settle();
      return due[0].delayMs;
    },
  };
}

/** A package the test answers for: `answers[method]` is a value, or a function of the input. */
function fakePackage(registry, pluginId = 'dev.clowder.fake-host') {
  const calls = [];
  const answers = { [METHODS.list]: { returns: [] }, [METHODS.ack]: { status: 'acknowledged' } };
  return {
    calls,
    answers,
    register: () =>
      registry.register({
        provider: 'chatgpt',
        pluginId,
        pluginInstanceId: `pi_${pluginId}`,
        contribution: hostManifest({ pluginId }).contributions[0],
        attempt: async (method, params) => {
          calls.push({ method, params });
          try {
            const answer = answers[method];
            return { status: 'returned', value: typeof answer === 'function' ? await answer(params) : answer };
          } catch (error) {
            return { status: 'failed', effect: 'unknown', error };
          }
        },
      }),
  };
}

function pollerFor(registry, { ingest = async () => ({ status: 'persisted', messageId: 'm-1' }), ephemeral } = {}) {
  const scheduler = manualScheduler();
  const lines = [];
  const ingested = [];
  const poller = new PluginConversationReturnPoller({
    registry,
    provider: 'chatgpt',
    ingestService: {
      ingest: async (input) => {
        ingested.push(input);
        return ingest(input);
      },
    },
    logger: {
      info: (context, message) => lines.push({ level: 'info', message, context }),
      warn: (context, message) => lines.push({ level: 'warn', message, context }),
    },
    grantPersistence: ephemeral ? 'ephemeral' : 'durable',
    scheduler,
  });
  return { poller, scheduler, lines, ingested };
}

const methodsOf = (pkg) => pkg.calls.map((call) => call.method);

test('nothing before start(); no package means no timer and no log; a package is polled at once, and only while held', async () => {
  const registry = new CloudConversationHostRegistry();
  const p = pollerFor(registry);
  const pkg = fakePackage(registry);
  const lease = pkg.register();
  assert.deepEqual(p.scheduler.pending(), [], 'not started yet');
  registry.unregister(lease);

  p.poller.start();
  assert.deepEqual(p.scheduler.pending(), []);

  const held = pkg.register();
  assert.equal(await p.scheduler.fire(), 0);
  assert.deepEqual(pkg.calls, [{ method: METHODS.list, params: {} }]);
  assert.deepEqual(p.scheduler.pending(), [1_000]);

  registry.unregister(held);
  assert.deepEqual(p.scheduler.pending(), []);
  assert.deepEqual(p.lines, []);
});

test('a round lists one return, lets the Host ingest it, and acks exactly that return', async () => {
  const registry = new CloudConversationHostRegistry();
  const p = pollerFor(registry);
  const pkg = fakePackage(registry);
  pkg.register();
  p.poller.start();
  pkg.answers[METHODS.list] = { returns: [RETURN] };

  await p.scheduler.fire();

  assert.deepEqual(p.ingested, [{ provider: 'chatgpt', sourceMessageId: 'source-1', content: 'the answer' }]);
  assert.deepEqual(pkg.calls, [
    { method: METHODS.list, params: {} },
    { method: METHODS.ack, params: CURSOR },
  ]);
  assert.deepEqual(p.scheduler.pending(), [1_000]);
});

test('ASSISTANT_RETURN_NOT_FOUND settles the return; any other ack failure is a failed round', async () => {
  const registry = new CloudConversationHostRegistry();
  const p = pollerFor(registry);
  const pkg = fakePackage(registry);
  pkg.register();
  p.poller.start();
  pkg.answers[METHODS.list] = { returns: [RETURN] };

  pkg.answers[METHODS.ack] = { status: 'failed', errorCode: 'ASSISTANT_RETURN_NOT_FOUND' };
  await p.scheduler.fire();
  assert.deepEqual(p.scheduler.pending(), [1_000]);

  pkg.answers[METHODS.ack] = { status: 'failed', errorCode: 'HELPER_STOPPED' };
  await p.scheduler.fire();
  assert.deepEqual(p.scheduler.pending(), [2_000]);

  pkg.answers[METHODS.ack] = { status: 'acknowledged', extra: true };
  await p.scheduler.fire();
  assert.deepEqual(p.scheduler.pending(), [4_000], 'an ack answer outside the contract fails the round');
  assert.equal(p.lines.filter((line) => line.level === 'warn').length, 1);
});

test('failures back off from 2s to 60s with one line; the first answer restores the cadence with one line', async () => {
  const registry = new CloudConversationHostRegistry();
  const p = pollerFor(registry);
  const pkg = fakePackage(registry);
  pkg.register();
  p.poller.start();
  pkg.answers[METHODS.list] = () => {
    throw new Error('helper crashed');
  };

  const delays = [];
  for (let round = 0; round < 7; round += 1) {
    await p.scheduler.fire();
    delays.push(...p.scheduler.pending());
  }
  assert.deepEqual(delays, [2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  assert.equal(p.lines.length, 1);
  assert.equal(p.lines[0].level, 'warn');
  assert.match(p.lines[0].message, /backs off exponentially, up to one round per 60s/);
  assert.equal(p.lines[0].context.pluginId, 'dev.clowder.fake-host');
  assert.equal(p.lines[0].context.cause.message, 'helper crashed');

  pkg.answers[METHODS.list] = { returns: [] };
  await p.scheduler.fire();
  assert.deepEqual(p.scheduler.pending(), [1_000]);
  assert.deepEqual(
    p.lines.map((line) => line.level),
    ['warn', 'info'],
  );
});

test('a list answer outside the contract is a failed round, and nothing is ingested', async () => {
  const registry = new CloudConversationHostRegistry();
  const p = pollerFor(registry);
  const pkg = fakePackage(registry);
  pkg.register();
  p.poller.start();
  for (const answer of [{ returns: [RETURN, RETURN] }, { returns: [{ ...RETURN, content: '   ' }] }, null]) {
    pkg.answers[METHODS.list] = answer;
    await p.scheduler.fire();
  }
  assert.deepEqual(p.scheduler.pending(), [8_000]);
  assert.deepEqual(p.ingested, []);
  assert.equal(methodsOf(pkg).includes(METHODS.ack), false);
});

test('ingest decides: retry leaves the return, a lost ephemeral grant steps past it, a rejection is acked', async () => {
  const registry = new CloudConversationHostRegistry();
  let outcome = { status: 'retry', reason: 'grant_in_flight' };
  const p = pollerFor(registry, { ephemeral: true, ingest: async () => outcome });
  const pkg = fakePackage(registry);
  pkg.register();
  p.poller.start();
  pkg.answers[METHODS.list] = { returns: [RETURN] };

  await p.scheduler.fire();
  outcome = { status: 'rejected', reason: 'grant_not_found' };
  await p.scheduler.fire();
  assert.deepEqual(methodsOf(pkg), [METHODS.list, METHODS.list], 'neither is acked');

  outcome = { status: 'rejected', reason: 'source_ineligible' };
  pkg.answers[METHODS.list] = { returns: [] };
  await p.scheduler.fire();
  assert.deepEqual(pkg.calls[2].params, { after: CURSOR }, 'the next list steps past the lost-grant return');

  pkg.answers[METHODS.list] = { returns: [RETURN] };
  await p.scheduler.fire();
  assert.deepEqual(pkg.calls.slice(3), [
    { method: METHODS.list, params: {} },
    { method: METHODS.ack, params: CURSOR },
  ]);
  assert.deepEqual(
    p.lines.map((line) => [line.level, line.context.reason]),
    [['warn', 'source_ineligible']],
  );
  assert.deepEqual(p.scheduler.pending(), [1_000]);
});

test('when the lease changes mid-round, the old round neither acks nor touches the new generation', async () => {
  const registry = new CloudConversationHostRegistry();
  let releaseIngest;
  const p = pollerFor(registry, {
    ingest: () =>
      new Promise((resolve) => {
        releaseIngest = () => resolve({ status: 'persisted', messageId: 'm-1' });
      }),
  });
  const first = fakePackage(registry, 'dev.clowder.first');
  const firstLease = first.register();
  p.poller.start();
  first.answers[METHODS.list] = () => {
    throw new Error('first failure');
  };
  await p.scheduler.fire();
  assert.deepEqual(p.scheduler.pending(), [2_000], 'the first generation is backing off');

  first.answers[METHODS.list] = { returns: [RETURN] };
  await p.scheduler.fire();
  assert.equal(typeof releaseIngest, 'function', 'the round is waiting on the ingest');

  registry.unregister(firstLease);
  const second = fakePackage(registry, 'dev.clowder.second');
  second.register();
  assert.deepEqual(p.scheduler.pending(), [0], 'the new generation starts at once, not at the old backoff');

  releaseIngest();
  await settle();
  assert.deepEqual(methodsOf(first), [METHODS.list, METHODS.list], 'no ack through the ended lease');
  assert.deepEqual(p.scheduler.pending(), [0], 'the ended round schedules nothing');

  await p.scheduler.fire();
  assert.deepEqual(methodsOf(second), [METHODS.list]);
  assert.deepEqual(p.scheduler.pending(), [1_000]);
});

test("an ended generation's late failure logs nothing and schedules nothing", async () => {
  const registry = new CloudConversationHostRegistry();
  const p = pollerFor(registry);
  const pkg = fakePackage(registry);
  const lease = pkg.register();
  p.poller.start();
  let failList;
  pkg.answers[METHODS.list] = () =>
    new Promise((_resolve, reject) => {
      failList = () => reject(new Error('too late'));
    });
  await p.scheduler.fire();

  registry.unregister(lease);
  failList();
  await settle();

  assert.deepEqual(p.scheduler.pending(), []);
  assert.deepEqual(p.lines, []);
});

test('stop() cancels the pending round and follows nothing until started again', async () => {
  const registry = new CloudConversationHostRegistry();
  const p = pollerFor(registry);
  const pkg = fakePackage(registry);
  const lease = pkg.register();
  p.poller.start();
  p.poller.stop();
  assert.deepEqual(p.scheduler.pending(), []);

  registry.unregister(lease);
  pkg.register();
  assert.deepEqual(p.scheduler.pending(), [], 'a stopped poller does not follow the registry');

  p.poller.start();
  assert.deepEqual(p.scheduler.pending(), [0]);
});

test('through the real chain, polling starts when the package is enabled and stops when it is disabled', async () => {
  const h = await conversationHostHarness();
  const p = pollerFor(h.registry);
  p.poller.start();
  assert.deepEqual(p.scheduler.pending(), []);

  await h.enable();
  h.script[METHODS.list] = { returns: [RETURN] };
  await p.scheduler.fire();
  assert.deepEqual(
    h
      .calls()
      .filter((call) => call.method !== 'start')
      .map((call) => [call.method, call.input]),
    [
      [METHODS.list, {}],
      [METHODS.ack, CURSOR],
    ],
  );

  await h.disable();
  assert.deepEqual(p.scheduler.pending(), []);
  assert.deepEqual(p.lines, []);
});
