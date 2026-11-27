import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionImplementationRegistry } from '../dist/domains/cats/services/agents/session-contract/implementation-registry.js';
import { RegisteredSessionAgentService } from '../dist/domains/cats/services/agents/session-contract/registered-session-agent-service.js';
import { declaration, setup } from './helpers/agent-adapter-archive.js';

test('an active archive supplies real Worker turns through the registered Host session service', async (t) => {
  const registry = new SessionImplementationRegistry();
  const { manager, install } = await setup(t, registry);
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
  assert.equal(first.find((message) => message.type === 'text')?.content, 'v1:legacy-native-id:first');
  assert.equal(first.at(-1).metadata.sessionId, 'legacy-native-id');
  assert.equal(first.at(-1).errorCode, undefined);
  await install({ ...ref, version: '1.1.0', declaration: declaration(ref.contributionId), executable: source('v2') });
  const second = await send('second');
  assert.equal(second.find((message) => message.type === 'text')?.content, 'v2:legacy-native-id:second');
  const rejected = await send('unexpected');
  assert.equal(rejected.at(-1).errorCode, 'session_contract_failed');
  assert.equal(rejected.at(-1).metadata.sessionId, 'legacy-native-id');
  const enabled = (await manager.get(ref.pluginId)).plugin;
  await manager.setEnabled(ref.pluginId, { enabled: false, expectedRevision: enabled.lifecycleRevision });
  assert.equal(registry.has(ref), false);
  const offline = await send('third');
  assert.equal(offline.at(-1).errorCode, 'session_implementation_unavailable');
});
