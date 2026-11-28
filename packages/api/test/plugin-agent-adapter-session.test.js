import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { SessionImplementationRegistry } from '../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { RegisteredSessionAgentService } from '../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { declaration, setup } from './helpers/agent-adapter-archive.js';

test('active archives supply and retire registered Worker turns', { timeout: 90_000 }, async (t) => {
  const registry = new SessionImplementationRegistry();
  const openedScopes = [];
  const { manager, install } = await setup(t, registry, ({ action, hostSession }) => {
    if (action === 'openSession') openedScopes.push(hostSession);
  });
  const ref = { pluginId: 'local.session-driver', contributionId: 'demo' };
  const source = (version) => `export default { create: () => ({
    start() {
      const sessions = new Map();
      return { actions: {
        describe() { return {}; },
        detect() { return { candidates: [] }; },
        openSession(input) {
          if (Object.keys(input).some(key => ['cwd', 'config', 'hostOptions', 'callbackEnv'].includes(key))) throw Error('Host-only input');
          const nativeSessionId = input.resume?.nativeSessionId ?? 'new-session';
          sessions.set(input.sessionId, nativeSessionId);
          return { ok: true, binding: { state: 'bound', nativeSessionId } };
        },
        async *startTurn(input) {
          if (Object.keys(input).some(key => ['cwd', 'config', 'hostOptions', 'callbackEnv', 'invocation'].includes(key))) throw Error('Host-only input');
          if (input.prompt === 'unexpected') {
            yield { type: 'native_bound', nativeSessionId: 'foreign-scope' };
            return;
          }
          yield { type: 'output', text: ${JSON.stringify(version)} + ':' + sessions.get(input.sessionId) + ':' + input.prompt };
          if (input.prompt === 'hold') await new Promise(() => {});
          yield { type: 'done', outcome: 'completed' };
        },
        cancel() { return { ok: true }; },
        release(input) { sessions.delete(input.sessionId); return { ok: true }; },
      }, stop() { sessions.clear(); } };
    },
  }) };`;
  const cat = new RegisteredSessionAgentService({ catId: 'fixture', ref, registry });
  const send = async (prompt) =>
    Array.fromAsync(
      cat.invoke(prompt, {
        invocationId: `turn-${prompt}`,
        hostSessionId: 'stable-host-session',
        sessionId: 'legacy-native-id',
        callbackEnv: { PRIVATE: 'host-owned' },
      }),
    );
  await install({ ...ref, declaration: declaration(ref.contributionId), executable: source('v1') });
  assert.equal(registry.has(ref), false);
  const { plugin } = await manager.get(ref.pluginId);
  await manager.setEnabled(ref.pluginId, { enabled: true, expectedRevision: plugin.lifecycleRevision });
  assert.equal(cat.implementationSnapshot().key, 'plugin:local.session-driver/demo');
  const first = await send('first');
  assert.equal(openedScopes[0]?.sessionId, 'stable-host-session');
  assert.equal(openedScopes[0]?.resumeNativeSessionId, 'legacy-native-id');
  assert.equal(first.find((message) => message.type === 'text')?.content, 'v1:legacy-native-id:first');
  assert.equal(first.at(-1).metadata.sessionId, 'legacy-native-id');
  assert.equal(first.at(-1).errorCode, undefined);
  await install({ ...ref, version: '1.1.0', declaration: declaration(ref.contributionId), executable: source('v2') });
  const second = await send('second');
  assert.equal(second.find((message) => message.type === 'text')?.content, 'v2:legacy-native-id:second');
  const rejected = await send('unexpected');
  assert.equal(rejected.at(-1).errorCode, 'session_contract_failed');
  assert.equal(rejected.at(-1).metadata.sessionId, 'legacy-native-id');
  const started = Promise.withResolvers();
  const activeTurn = (async () => {
    const output = [];
    for await (const message of cat.invoke('hold', {
      invocationId: 'turn-hold',
      hostSessionId: 'stable-host-session',
      sessionId: 'legacy-native-id',
    })) {
      output.push(message);
      if (message.type === 'text') started.resolve();
    }
    return output;
  })();
  await Promise.race([
    started.promise,
    activeTurn.then(() => assert.fail('Worker turn ended before activation withdrawal')),
  ]);
  const enabled = (await manager.get(ref.pluginId)).plugin;
  await manager.setEnabled(ref.pluginId, { enabled: false, expectedRevision: enabled.lifecycleRevision });
  const activeMessages = await activeTurn;
  assert.deepEqual(
    activeMessages.filter(({ type }) => type === 'text').map(({ content }) => content),
    ['v2:legacy-native-id:hold'],
  );
  const ended = activeMessages.filter(({ type }) => type === 'done');
  assert.equal(ended.length, 1);
  assert.ok(ended[0].errorCode, 'Withdrawal must not complete an interrupted turn successfully');
  assert.equal(registry.has(ref), false);
  const offline = await send('third');
  assert.equal(offline.at(-1).errorCode, 'session_implementation_unavailable');
});

test(
  'an installed Worker binds on first turn, drains cancellation, and releases the scoped Host session',
  { timeout: 35_000 },
  async (t) => {
    const registry = new SessionImplementationRegistry();
    const scopes = [];
    const { manager, runtime, install } = await setup(t, registry, ({ action, hostSession }) => {
      if (hostSession) scopes.push([action, hostSession.cwd, hostSession.sessionId, hostSession.executionAccount]);
    });
    const ref = { pluginId: 'local.lifecycle-fixture', contributionId: 'demo' };
    const source = `export default { create: () => ({
    start() {
      let finish;
      let released = false;
      let cancelled = false;
      return { actions: {
        describe() { return {}; },
        detect() {
          return { candidates: [{ id: 'lifecycle', label: 'Lifecycle', state: { status: 'unavailable', reason: [cancelled, released].join(':') } }] };
        },
        openSession(input) {
          if ('cwd' in input || 'config' in input || 'executionAccount' in input) throw new Error('Host scope was exposed');
          return { ok: true, binding: { state: 'pending_first_input' } };
        },
        async *startTurn(input) {
          if ('executionAccount' in input) throw new Error('Host account was exposed');
          const cancellation = new Promise((resolve) => { finish = resolve; });
          if (input.prompt !== 'continue') yield { type: 'native_bound', nativeSessionId: 'worker-bound' };
          yield { type: 'output', text: 'started' };
          if (input.prompt === 'cancel') {
            await cancellation;
            yield { type: 'output', text: 'late' };
          }
          yield { type: 'done', outcome: cancelled ? 'cancelled' : 'completed' };
        },
        cancel(input) {
          if (input.invocationId !== 'turn-cancel') throw new Error('Unexpected cancellation identity');
          cancelled = true;
          finish();
          return { ok: true };
        },
        release(input) {
          released = input.sessionId === 'new-host';
          return { ok: true };
        },
      }, stop() {} };
    },
  }) };`;
    await install({ ...ref, declaration: declaration(ref.contributionId), executable: source });
    const { plugin } = await manager.get(ref.pluginId);
    await manager.setEnabled(ref.pluginId, { enabled: true, expectedRevision: plugin.lifecycleRevision });
    const cat = new RegisteredSessionAgentService({ catId: 'fixture', ref, registry });
    const controller = new AbortController();
    const workingDirectory = join(runtime.projectRoot, 'member-project');
    const executionAccount = {
      accountRef: 'isolated-account',
      displayName: 'Isolated account',
      authType: 'oauth',
      accountRevision: 'fixture-revision',
      credentialVersion: 'fixture-credential',
    };
    const observed = [];
    for await (const event of cat.invoke('cancel', {
      hostSessionId: 'new-host',
      invocationId: 'turn-cancel',
      signal: controller.signal,
      workingDirectory,
      executionAccount,
    })) {
      observed.push(event);
      if (event.type === 'text') controller.abort();
    }
    assert.deepEqual(
      observed.filter((event) => event.type === 'text').map((event) => event.content),
      ['started'],
    );
    assert.equal(observed.at(-1)?.errorCode, 'cancelled');
    assert.equal(observed.at(-1)?.metadata.sessionId, 'worker-bound');
    const wrongDirectory = await Array.fromAsync(
      cat.invoke('continue', {
        hostSessionId: 'new-host',
        invocationId: 'outside-scope',
        workingDirectory: join(runtime.projectRoot, 'other-member'),
        executionAccount,
      }),
    );
    assert.equal(wrongDirectory.at(-1)?.errorCode, 'session_unavailable');
    const changedCredential = await Array.fromAsync(
      cat.invoke('continue', {
        hostSessionId: 'new-host',
        invocationId: 'different-credential',
        workingDirectory,
        executionAccount: { ...executionAccount, credentialVersion: 'changed' },
      }),
    );
    assert.equal(changedCredential.at(-1)?.errorCode, 'session_unavailable');
    await cat.releaseAll('test_complete');
    const status = await runtime.agentAdapters.detect(ref);
    assert.equal(status.candidates[0].state.reason, 'true:true');
    assert.deepEqual(scopes, [
      ['openSession', workingDirectory, 'new-host', executionAccount],
      ['startTurn', workingDirectory, 'new-host', executionAccount],
      ['cancel', workingDirectory, 'new-host', executionAccount],
      ['release', workingDirectory, 'new-host', executionAccount],
    ]);
  },
);
