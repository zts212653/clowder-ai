import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { CallerDispatchObservationRegistry } from '../dist/domains/cats/services/agents/invocation/CallerDispatchObservationRegistry.js';
import { commitLifecycleResponseFromTerminalPatch } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { queueRoutes } from '../dist/routes/queue.js';
import { appendRecoveryFixture, recoveryProcessor } from './helpers/append-recovery-fixture.js';

const scope = { ownerId: 'owner', threadId: 'thread', callerCatId: 'codex' };
async function ended(f) {
  await commitLifecycleResponseFromTerminalPatch(f.messageStore, f.response.id, {
    invocationId: 'turn',
    status: 'completed',
    completedAt: Date.now(),
    content: 'old request completed',
    origin: 'stream',
    mentions: [],
    extra: undefined,
  });
}
async function observe(f, registry = new CallerDispatchObservationRegistry()) {
  registry.registerPersistedSource(await f.messageStore.getById(f.admission.message.id), ['opus']);
  return registry.project(f.messageStore, scope);
}

for (const outcome of ['not_accepted', 'unknown', 'incomplete', 'awaiting_completion']) {
  test(`caller and HTTP preserve ${outcome} after the original response completes`, async (t) => {
    let input,
      sends = 0;
    const native = ['incomplete', 'awaiting_completion'].includes(outcome);
    const f = await appendRecoveryFixture(
      async (value) => {
        input = value;
        sends++;
        return native ? { accepted: true } : { accepted: false, reason: 'exception', acceptance: 'unknown' };
      },
      {
        from: { kind: 'agent', catId: 'codex' },
        inputCompletionReceipt: native,
        inspectInput: async () => (outcome === 'not_accepted' ? 'not_accepted' : 'unknown'),
      },
    );
    await f.append();
    await f.processor.reconcileAppendDeliveries('thread');
    if (outcome === 'incomplete') {
      await input.onInputRead();
      await input.onInputCompleted(false);
    }
    const before = await observe(f);
    if (outcome === 'not_accepted') assert.match(before.prompt, /not_delivered\(append not accepted\)/);
    if (outcome === 'incomplete') assert.match(before.prompt, /incomplete\(append/);
    await ended(f);
    const observation = await observe(f);
    const status = outcome === 'not_accepted' ? 'not_delivered' : outcome === 'incomplete' ? 'incomplete' : 'unknown';
    assert.match(observation.prompt, new RegExp(`→ opus: ${status}`));
    assert.doesNotMatch(observation.prompt, /→ opus: completed/);
    assert.equal(observation.included[0].terminal, ['not_accepted', 'incomplete'].includes(outcome));
    const privateRegistry = new CallerDispatchObservationRegistry();
    privateRegistry.registerPersistedSource(await f.messageStore.getById(f.admission.message.id), ['opus']);
    const privateObservation = await privateRegistry.project(
      {
        getById: async (id) => {
          const message = await f.messageStore.getById(id);
          return id === f.response.id ? { ...message, visibility: 'whisper', whisperTo: ['opus'] } : message;
        },
      },
      scope,
    );
    assert.match(privateObservation.prompt, new RegExp(`→ opus: ${status}`));
    assert.equal(privateObservation.prompt.includes(f.response.id), false, 'private response id must not reach caller');
    assert.equal(privateObservation.included[0].terminal, observation.included[0].terminal);
    assert.equal(await f.queue.getDurableEntry('thread', f.admission.entry.id), null);
    assert.equal(sends, 1);
    const app = Fastify();
    t.after(() => app.close());
    await app.register(queueRoutes, {
      threadStore: { get: async () => ({ id: 'thread', createdBy: 'owner' }) },
      invocationQueue: f.queue,
      queueProcessor: f.processor,
      invocationTracker: f.invocationTracker,
      messageStore: f.messageStore,
      socketManager: { emitToUser() {}, broadcastAgentMessage() {}, getActiveInvocations: () => [] },
    });
    const result = await app.inject({
      method: 'GET',
      headers: { 'x-cat-cafe-user': 'owner' },
      url: `/api/threads/thread/messages/${f.admission.message.id}/routing-targets/opus`,
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(
      result.json().status,
      outcome === 'not_accepted' ? 'not_received' : outcome === 'incomplete' ? 'incomplete' : 'unconfirmed',
    );
    assert.equal(result.json().canRepeat, outcome === 'incomplete', 'no owner elevation for ordinary A2A');
  });
}

test('a recovered pre-write A2A handoff reports not delivered without restoring its old Queue', async () => {
  let sends = 0;
  const f = await appendRecoveryFixture(
    async () => {
      sends++;
      return { accepted: true };
    },
    { from: { kind: 'agent', catId: 'codex' } },
  );
  const at = Date.now();
  await f.messageStore.markDelivered(f.admission.message.id, at);
  await f.messageStore.commitLifecycleAppendAdmission({
    threadId: 'thread',
    entryId: f.admission.entry.id,
    inputMessageIds: [f.admission.message.id],
    runs: [
      {
        targetId: 'opus',
        invocationId: 'turn',
        responseMessageId: f.response.id,
        awaitingAcceptance: true,
        dispatchedAt: at,
      },
    ],
  });
  await f.queue.hydrateFromLedger(f.messageStore);
  const restarted = recoveryProcessor({ queue: f.queue, messageStore: f.messageStore });
  await restarted.reconcileAppendDeliveries('thread');
  await ended(f);
  const observation = await observe(f);
  assert.match(observation.prompt, /not_delivered\(append not accepted\)/);
  assert.equal(observation.included[0].terminal, true);
  assert.deepEqual(f.queue.list('thread', 'owner'), []);
  assert.equal(sends, 0);
});

test('a late exact receipt changes an unconfirmed caller observation into the real response result', async () => {
  let input;
  const f = await appendRecoveryFixture(
    async (value) => {
      input = value;
      return { accepted: false, reason: 'exception', acceptance: 'unknown' };
    },
    { from: { kind: 'agent', catId: 'codex' } },
  );
  await f.append();
  await f.processor.reconcileAppendDeliveries('thread');
  await ended(f);
  const registry = new CallerDispatchObservationRegistry();
  const initial = await observe(f, registry);
  assert.match(initial.prompt, /→ opus: unknown/);
  assert.equal(initial.included[0].terminal, false);
  registry.acknowledge(initial.included);
  await input.onInputRead();
  const confirmed = await registry.project(f.messageStore, scope);
  assert.match(confirmed.prompt, /→ opus: completed/);
  assert.equal(confirmed.included[0].terminal, true);
  assert.notEqual(confirmed.included[0].fingerprint, initial.included[0].fingerprint);
});

test('an old attempt failure cannot replace an accepted current response in caller observations', async () => {
  const f = await appendRecoveryFixture(async () => ({ accepted: true }), { from: { kind: 'agent', catId: 'codex' } });
  await f.append();
  await ended(f);
  const source = await f.messageStore.getById(f.admission.message.id);
  source.lifecycle.appendFailures = [
    {
      targetId: 'opus',
      invocationId: 'old',
      responseMessageId: 'old-response',
      acceptance: 'not_accepted',
      reason: 'active_run_closed',
      at: Date.now(),
    },
  ];
  const registry = new CallerDispatchObservationRegistry();
  registry.registerPersistedSource(source, ['opus']);
  const observation = await registry.project(
    { getById: async (id) => (id === source.id ? source : f.messageStore.getById(id)) },
    scope,
  );
  assert.match(observation.prompt, /→ opus: completed/);
  assert.equal(observation.included[0].terminal, true);
});
