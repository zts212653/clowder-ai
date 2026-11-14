import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { AcpSessionProvider } from '../../dist/domains/cats/services/agents/session-contract/acp-session-provider.js';
import { SessionImplementationRegistry } from '../../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { RegisteredSessionAgentService } from '../../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { appendRecoveryFixture, recoveryProcessor } from '../helpers/append-recovery-fixture.js';

function fixture({
  registered = false,
  supported = true,
  bridgeAvailable = true,
  ending = 'completed',
  unknownWrite = false,
  emptyResume = false,
} = {}) {
  const listeners = new Set();
  const calls = { hello: 0, steer: [], registered: 0, released: 0 };
  let dispatcher;
  let read = false;
  const notify = (type, fields = {}) => {
    for (const listener of listeners) listener({ sessionId: 'dsh-session', type, nativeTurnId: 7, ...fields });
  };
  const client = {
    recentCapacitySignal: null,
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
    cancelSession() {},
    async newSession() {
      return { sessionId: emptyResume ? 'fresh-session' : 'dsh-session', configOptions: [] };
    },
    async loadSession(sessionId) {
      return { sessionId };
    },
    async probeTurnBridge() {
      calls.hello++;
      if (!bridgeAvailable) return null;
      return { protocol: 1, bridge: 'cat-cafe-dsh-turn', steer: true, nativeTurns: true };
    },
    onTurnBridgeEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async steerTurn(input) {
      calls.steer.push(input);
      if (unknownWrite) throw new Error('reply lost after native handoff');
      return { accepted: true, nativeTurnId: 7 };
    },
    async inspectTurnInput() {
      return { state: read ? 'read' : 'accepted', nativeTurnId: 7 };
    },
    async *promptStream(sessionId) {
      if (emptyResume && sessionId === 'dsh-session') return;
      notify('turn_started', { sessionId });
      notify('input_read', { sessionId, deliveryId: 'original-prompt' });
      yield { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'waiting' } } };
      notify('turn_ended', { sessionId, reason: ending });
    },
  };
  const host = new AcpAgentService({
    catId: 'dsh',
    providerName: 'dsh',
    modelName: 'fixture',
    projectRoot: process.cwd(),
    dshTurnInput: supported,
    mcpSupport: false,
    poolKey: { projectPath: process.cwd(), providerProfile: 'fixture' },
    pool: {
      async acquire() {
        return { client, release() {} };
      },
    },
  });
  let service = host;
  if (registered) {
    const ref = { builtin: 'dsh-turn-fixture' };
    const registry = new SessionImplementationRegistry();
    const provider = new AcpSessionProvider({ catId: 'dsh', service: host });
    registry.register(ref, () => provider);
    service = new RegisteredSessionAgentService({
      catId: 'dsh',
      ref,
      registry,
      metadata: { provider: 'dsh', model: 'fixture' },
    });
  }
  const options = {
    ...(emptyResume ? { sessionId: 'dsh-session' } : {}),
    invocationId: 'invocation-1',
    hostSessionId: 'host-session',
    signal: new AbortController().signal,
    activeRunDispatch: {
      invocationId: 'invocation-1',
      register(value) {
        calls.registered++;
        dispatcher = value;
        return () => {
          calls.released++;
        };
      },
    },
  };
  return {
    service,
    options,
    calls,
    dispatcher: () => dispatcher,
    notify,
    markRead() {
      read = true;
    },
  };
}

for (const registered of [false, true]) {
  for (const ending of ['completed', 'error']) {
    test(`fresh recovery retains native input (${registered ? 'registered' : 'direct'}, ${ending})`, async () => {
      const f = fixture({ registered, ending, emptyResume: true });
      const sessions = [];
      const completed = [];
      let reads = 0;
      for await (const message of f.service.invoke('resume fixture prompt', f.options)) {
        assert.notEqual(message.type, 'error', message.error);
        if (message.type === 'session_init') sessions.push(message.sessionId);
        if (message.type !== 'text') continue;
        const dispatcher = f.dispatcher();
        assert.ok(dispatcher, 'the fresh native turn must expose live input after zero-event recovery');
        assert.equal(dispatcher.handle.threadId, 'fresh-session');
        const input = {
          text: 'fresh turn correction',
          messageIds: ['source-fresh'],
          deliveryId: 'fresh-delivery',
          onInputRead() {
            reads++;
          },
          onInputCompleted(value) {
            completed.push(value);
          },
        };
        assert.equal(
          (await dispatcher.dispatch(input, { expectedInvocationId: 'invocation-1', force: false })).accepted,
          true,
        );
        assert.equal(f.calls.steer[0].sessionId, 'fresh-session');
        f.notify('input_read', { deliveryId: 'fresh-delivery' });
        await setImmediate();
        assert.equal(reads, 0, 'late old-session events cannot consume fresh input');
        f.notify('input_read', { sessionId: 'fresh-session', deliveryId: 'fresh-delivery' });
        await setImmediate();
        assert.equal(reads, 1);
        assert.deepEqual(completed, []);
      }
      assert.deepEqual(sessions, ['dsh-session', 'fresh-session']);
      assert.deepEqual(completed, [ending === 'completed']);
      assert.equal(f.calls.hello, 1, 'the same process retains its capability negotiation');
      assert.equal(f.calls.registered, 1);
      assert.equal(f.calls.released, 1);
    });
  }
}

for (const registered of [false, true]) {
  test(`${registered ? 'registered' : 'direct'} ACP registers one exact native turn and separates accept/read/completion`, async () => {
    const f = fixture({ registered });
    assert.equal(f.service.freshnessCarrierCapability().activeInvocationGuidance, 'supported');
    assert.equal(f.service.freshnessCarrierCapability().deliverySemantics, 'exact_active_turn');
    let reads = 0;
    const completions = [];
    for await (const message of f.service.invoke('original fixture prompt', f.options)) {
      assert.notEqual(message.type, 'error', message.error);
      if (message.type !== 'text') continue;
      const dispatcher = f.dispatcher();
      assert.ok(dispatcher, 'the native turn must expose the existing Host active-input contract');
      assert.equal(f.service.freshnessCarrierCapability().activeInvocationGuidance, 'supported');
      assert.equal(f.service.freshnessCarrierCapability().deliverySemantics, 'exact_active_turn');
      assert.equal(dispatcher.handle.threadId, 'dsh-session');
      assert.equal(dispatcher.handle.turnId, '7');
      assert.equal(dispatcher.capabilities.inputCompletionReceipt, true);
      const input = {
        text: 'NEW fixture instruction',
        messageIds: ['source-1'],
        deliveryId: 'delivery-1',
        async onInputRead() {
          reads++;
        },
        async onInputCompleted(value) {
          completions.push(value);
        },
      };
      const control = { expectedInvocationId: 'invocation-1', force: false };
      assert.equal((await dispatcher.dispatch(input, { ...control, expectedInvocationId: 'old' })).accepted, false);
      assert.equal((await dispatcher.dispatch(input, { ...control, force: true })).accepted, false);
      assert.equal((await dispatcher.dispatch({ ...input, imagePaths: ['/attachment'] }, control)).accepted, false);
      assert.equal(f.calls.steer.length, 0);
      assert.equal((await dispatcher.dispatch(input, control)).accepted, true);
      assert.equal(reads, 0, 'RPC acceptance is not native consumption');
      assert.deepEqual(completions, []);
      assert.equal(await dispatcher.inspectInput('delivery-1'), 'accepted');
      f.notify('input_read', { sessionId: 'foreign-session', deliveryId: 'delivery-1' });
      await setImmediate();
      assert.equal(reads, 0);
      f.markRead();
      f.notify('input_read', { deliveryId: 'delivery-1' });
      await setImmediate();
      assert.equal(reads, 1);
      assert.deepEqual(completions, [], 'native read is still distinct from a successful turn');
    }
    assert.deepEqual(completions, [true]);
    assert.equal(f.calls.registered, 1, 'the outer registered provider must not overwrite the native dispatcher');
    assert.equal(f.calls.released, 1);
    assert.equal(
      (
        await f
          .dispatcher()
          .dispatch({ text: 'late', messageIds: ['late'] }, { force: false, expectedInvocationId: 'invocation-1' })
      ).accepted,
      false,
    );
  });
}

for (const ending of ['completed', 'error']) {
  test(`an accepted but unread input closes incomplete (${ending})`, async () => {
    const f = fixture({ ending });
    const completions = [];
    for await (const message of f.service.invoke('fixture', f.options)) {
      assert.notEqual(message.type, 'error', message.error);
      if (message.type !== 'text') continue;
      assert.ok(f.dispatcher(), 'DSH must register its live input');
      await f.dispatcher().dispatch(
        {
          text: 'unread',
          messageIds: ['source'],
          deliveryId: 'unread',
          async onInputCompleted(value) {
            completions.push(value);
          },
        },
        { force: false, expectedInvocationId: 'invocation-1' },
      );
    }
    assert.deepEqual(completions, [false]);
  });
}

test('an unknown native write stays unknown and retains its completion obligation', async () => {
  const f = fixture({ unknownWrite: true });
  const completed = [];
  for await (const message of f.service.invoke('fixture', f.options)) {
    if (message.type !== 'text') continue;
    assert.ok(f.dispatcher(), 'DSH must register its live input');
    const result = await f.dispatcher().dispatch(
      {
        text: 'uncertain',
        messageIds: ['source'],
        deliveryId: 'uncertain',
        async onInputCompleted(value) {
          completed.push(value);
        },
      },
      { force: false, expectedInvocationId: 'invocation-1' },
    );
    assert.equal(result.accepted, false);
    assert.equal(result.acceptance, 'unknown');
  }
  assert.deepEqual(completed, [false]);
});

test('ordinary ACP neither probes private DSH methods nor registers live input', async () => {
  const f = fixture({ supported: false });
  for await (const message of f.service.invoke('fixture', f.options))
    assert.notEqual(message.type, 'error', message.error);
  assert.equal(f.calls.hello, 0);
  assert.equal(f.calls.registered, 0);
  assert.equal(f.service.freshnessCarrierCapability().activeInvocationGuidance, 'unsupported');
});

test('an admitted DSH bridge declares stable capability while a failed handshake exposes no dispatcher', async () => {
  const f = fixture({ bridgeAvailable: false });
  const declared = f.service.freshnessCarrierCapability();
  assert.equal(declared.deliverySemantics, 'exact_active_turn');
  for await (const message of f.service.invoke('fixture', f.options))
    assert.notEqual(message.type, 'error', message.error);
  assert.equal(f.calls.hello, 1);
  assert.equal(f.calls.registered, 0);
  assert.deepEqual(f.service.freshnessCarrierCapability(), declared);
});

for (const mode of ['read-completed', 'read-failed', 'unread-completed']) {
  test(`DSH callbacks reach the existing Queue/History owner (${mode})`, async () => {
    const f = fixture({ ending: mode === 'read-failed' ? 'error' : 'completed', registered: true });
    const queue = await appendRecoveryFixture((input, control) => f.dispatcher().dispatch(input, control), {
      invocationId: 'invocation-1',
      inputCompletionReceipt: true,
    });
    for await (const message of f.service.invoke('fixture prompt', f.options)) {
      assert.notEqual(message.type, 'error', message.error);
      if (message.type !== 'text') continue;
      assert.equal((await queue.append()).outcome, 'appended');
      let source = await queue.messageStore.getById(queue.admission.message.id);
      assert.equal(source.lifecycle.dispatchRefs[0].appendAcceptance, 'written');
      assert.equal(source.lifecycle.dispatchRefs[0].inputRead.status, 'pending');
      assert.equal(source.lifecycle.dispatchRefs[0].appendDelivery.requiresCompletion, true);
      if (mode.startsWith('read-')) {
        f.markRead();
        f.notify('input_read', { deliveryId: f.calls.steer[0].deliveryId });
        await setImmediate();
        source = await queue.messageStore.getById(queue.admission.message.id);
        assert.equal(source.lifecycle.dispatchRefs[0].inputRead.status, 'read');
        assert.equal(source.lifecycle.dispatchRefs[0].appendAcceptance, 'written');
      }
    }
    const source = await queue.messageStore.getById(queue.admission.message.id);
    assert.equal(source.lifecycle.dispatchRefs[0].inputRead.status, mode.startsWith('read-') ? 'read' : 'pending');
    if (mode === 'read-completed') assert.equal(source.lifecycle.dispatchRefs[0].appendAcceptance, 'accepted');
    else assert.equal(source.lifecycle.appendFailures[0].acceptance, 'incomplete');
    let replayed = 0;
    const restarted = recoveryProcessor({
      queue: queue.queue,
      messageStore: queue.messageStore,
      routeExecution: async function* () {
        replayed++;
        yield* [];
      },
    });
    await restarted.reconcileAppendDeliveries('thread');
    await restarted.requestDrain('thread');
    assert.equal(replayed, 0, 'an uncertain or read native task must not automatically execute twice');
    assert.equal(
      (await queue.messageStore.getById(queue.response.id)).lifecycle.inputMessageIds.includes(source.id),
      true,
    );
  });
}
