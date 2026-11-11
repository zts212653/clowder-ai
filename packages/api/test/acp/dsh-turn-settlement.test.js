import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { DshTurnInput } from '../../dist/domains/cats/services/agents/providers/acp/dsh/dsh-turn-input.js';
import { deferred } from '../agent-session-contract/fake-session-provider.js';
import { appendRecoveryFixture } from '../helpers/append-recovery-fixture.js';

function fixture() {
  const handoff = deferred();
  const entered = deferred();
  const listeners = new Set();
  let dispatcher;
  const client = {
    onTurnBridgeEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    steerTurn() {
      entered.resolve();
      return handoff.promise;
    },
    async inspectTurnInput() {
      return { state: 'unknown' };
    },
  };
  const turn = new DshTurnInput(client, 'session', {
    activeRunDispatch: {
      invocationId: 'invocation',
      register(value) {
        dispatcher = value;
        return () => {};
      },
    },
  });
  const notify = (type, fields = {}) => {
    for (const listener of listeners) listener({ sessionId: 'session', nativeTurnId: 1, type, ...fields });
  };
  notify('turn_started');
  return {
    handoff,
    entered,
    turn,
    notify,
    dispatch: (input, control = { expectedInvocationId: 'invocation', force: false }) =>
      dispatcher.dispatch(input, control),
  };
}

test('a pending steer refused after native end retains the definite-refusal Queue retry', async () => {
  const f = fixture();
  const completed = [];
  const queue = await appendRecoveryFixture(
    (input, control) =>
      f.dispatch(
        {
          ...input,
          async onInputCompleted(value) {
            completed.push(value);
            await input.onInputCompleted(value);
          },
        },
        control,
      ),
    { invocationId: 'invocation', inputCompletionReceipt: true },
  );
  const append = queue.append();
  await f.entered.promise;
  f.notify('turn_ended', { reason: 'completed' });
  await setImmediate();
  f.handoff.resolve({ accepted: false, reason: 'no_active_turn' });
  assert.equal((await append).outcome, 'rejected');
  await f.turn.dispose();
  const source = await queue.messageStore.getById(queue.admission.message.id);
  const row = await queue.queue.getDurableEntry('thread', queue.admission.entry.id);
  assert.equal(source.lifecycle.appendFailures[0].acceptance, 'not_accepted');
  assert.deepEqual(completed, [], 'a never-accepted input owns no execution completion');
  assert.deepEqual(row.targets, ['opus']);
  assert.equal(row.delivery.authorIntentByTarget.opus.requested, 'next_work');
});

for (const outcome of ['accepted', 'unknown']) {
  test(`native end retains completion custody for a pending ${outcome} steer`, async () => {
    const f = fixture();
    const completed = [];
    const dispatch = f.dispatch({
      text: 'pending input',
      messageIds: ['source'],
      deliveryId: 'delivery',
      async onInputCompleted(value) {
        completed.push(value);
      },
    });
    await f.entered.promise;
    f.notify('turn_ended', { reason: 'completed' });
    await setImmediate();
    if (outcome === 'accepted') f.handoff.resolve({ accepted: true, nativeTurnId: 1 });
    else f.handoff.reject(Error('native reply lost'));
    await dispatch;
    await f.turn.dispose();
    assert.deepEqual(completed, [false], 'unread accepted/unknown input remains incomplete exactly once');
  });
}

test('completion persistence retries its successful native outcome during disposal', async () => {
  const f = fixture();
  const completed = [];
  f.handoff.resolve({ accepted: true, nativeTurnId: 1 });
  await f.dispatch({
    text: 'read input',
    messageIds: ['source'],
    deliveryId: 'delivery',
    async onInputCompleted(value) {
      completed.push(value);
      if (completed.length === 1) throw Error('temporary completion write failure');
    },
  });
  f.notify('input_read', { deliveryId: 'delivery' });
  f.notify('turn_ended', { reason: 'completed' });
  await setImmediate();
  await f.turn.dispose();
  assert.deepEqual(completed, [true, true], 'cleanup must retain the original successful native-end evidence');
  await f.turn.dispose();
  assert.deepEqual(completed, [true, true], 'a confirmed completion is not written again');
});

test('a persistent completion-store failure is reported by disposal', async () => {
  const f = fixture();
  const failure = Error('completion store unavailable');
  f.handoff.resolve({ accepted: true, nativeTurnId: 1 });
  await f.dispatch({
    text: 'read input',
    messageIds: ['source'],
    deliveryId: 'delivery',
    onInputCompleted: async () => {
      throw failure;
    },
  });
  f.notify('input_read', { deliveryId: 'delivery' });
  f.notify('turn_ended', { reason: 'completed' });
  await setImmediate();
  await assert.rejects(f.turn.dispose(), (error) => error === failure);
});

test('reporting completion custody failure still releases the ACP lease', async () => {
  const listeners = new Set();
  let dispatcher;
  let released = 0;
  const failure = Error('completion store unavailable');
  const notify = (type, fields = {}) => {
    for (const listener of listeners) listener({ sessionId: 'session', nativeTurnId: 1, type, ...fields });
  };
  const client = {
    recentCapacitySignal: null,
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
    cancelSession() {},
    async newSession() {
      return { sessionId: 'session', configOptions: [] };
    },
    async probeTurnBridge() {
      return { protocol: 1, steer: true, nativeTurns: true };
    },
    onTurnBridgeEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async steerTurn() {
      return { accepted: true, nativeTurnId: 1 };
    },
    async *promptStream(sessionId) {
      notify('turn_started');
      yield { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ready' } } };
      notify('input_read', { deliveryId: 'delivery' });
      notify('turn_ended', { reason: 'completed' });
    },
  };
  const service = new AcpAgentService({
    catId: 'dsh',
    providerName: 'dsh',
    modelName: 'fixture',
    projectRoot: process.cwd(),
    dshTurnInput: true,
    mcpSupport: false,
    poolKey: { projectPath: process.cwd(), providerProfile: 'completion-failure' },
    pool: {
      async acquire() {
        return {
          client,
          release() {
            released++;
          },
        };
      },
    },
  });
  await assert.rejects(
    async () => {
      for await (const message of service.invoke('fixture', {
        activeRunDispatch: {
          invocationId: 'invocation',
          register(value) {
            dispatcher = value;
            return () => {};
          },
        },
      })) {
        if (message.type !== 'text') continue;
        await dispatcher.dispatch(
          {
            text: 'new input',
            messageIds: ['source'],
            deliveryId: 'delivery',
            onInputCompleted: async () => {
              throw failure;
            },
          },
          { expectedInvocationId: 'invocation', force: false },
        );
      }
    },
    (error) => error === failure,
  );
  assert.equal(released, 1, 'receipt-store failure cannot leak the provider lease');
});
