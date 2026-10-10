import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { AcpAgentService } from '../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import {
  captureNativeDefaults,
  defaultsForNativeResume,
} from '../dist/domains/cats/services/agents/providers/acp/native-session-defaults.js';
import { applySessionConfiguration } from '../dist/domains/cats/services/agents/providers/acp/session-configuration.js';

for (const [kind, category] of [
  ['effort', 'thought_level'],
  ['model', 'model'],
])
  test(`restoring a native empty-string ${kind} default sends the opaque sentinel to the original session`, async () => {
    const session = (value) => ({
      sessionId: 'history',
      configOptions: [{ id: kind, category, currentValue: value, options: [{ value: '' }, { value: 'override' }] }],
    });
    const calls = [];
    const client = {
      async setSessionConfigOption(id, key, value) {
        calls.push([id, key, value]);
        return session(value);
      },
    };
    await captureNativeDefaults(client, session(''), '/project');
    const defaults = await defaultsForNativeResume(client, '/project', {}, async () => {
      throw new Error('unexpected probe');
    });
    const adopted = await applySessionConfiguration(client, session('override'), defaults);
    assert.deepEqual(calls, [['history', kind, '']]);
    assert.equal(adopted.configOptions[0].currentValue, '');
  });

test('resetting native ACP preferences restores defaults in the original conversation, also after restart', async () => {
  const id = 'native-reset-test';
  const base = {
    ...catRegistry.tryGet('opus').config,
    id,
    clientId: 'acp',
    configurationSource: 'native_tool',
    defaultModel: 'pro',
    cli: { effort: 'low' },
  };
  catRegistry.register(id, base);
  const sessions = new Map();
  const prompts = [];
  let seq = 0;
  const describe = (sessionId) => ({
    sessionId,
    configOptions: Object.entries(sessions.get(sessionId)).map(([key, currentValue]) => ({
      id: key,
      category: key === 'model' ? 'model' : 'thought_level',
      currentValue,
      options: (key === 'model' ? ['flash', 'pro'] : ['low', 'high']).map((value) => ({ value })),
    })),
  });
  const makeClient = () => ({
    recentCapacitySignal: null,
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
    cancelSession() {},
    async newSession() {
      const sessionId = `s${++seq}`;
      sessions.set(sessionId, { model: 'flash', effort: 'high' });
      return describe(sessionId);
    },
    async loadSession(sessionId) {
      return describe(sessionId);
    },
    async setSessionConfigOption(sessionId, key, value) {
      sessions.get(sessionId)[key] = value;
      return describe(sessionId);
    },
    async *promptStream(sessionId) {
      prompts.push(sessionId);
      yield { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reply' } } };
    },
  });
  const makeService = () => {
    const client = makeClient();
    return new AcpAgentService({
      catId: id,
      pool: {
        async acquire(poolKey) {
          return { client, poolKey, release() {} };
        },
      },
      poolKey: { projectPath: '/tmp', providerProfile: id },
      projectRoot: '/tmp',
      providerName: 'dsh',
      modelName: '',
    });
  };
  const invoke = async (service, sessionId) => {
    const messages = [];
    for await (const message of service.invoke('continue', sessionId ? { sessionId } : {})) messages.push(message);
    assert.equal(
      messages.some((message) => message.type === 'error'),
      false,
      JSON.stringify(messages),
    );
    return prompts.at(-1);
  };
  let service = makeService();
  const sessionId = await invoke(service);
  assert.deepEqual(sessions.get(sessionId), { model: 'pro', effort: 'low' });
  base.cli = {};
  await invoke(service, sessionId);
  assert.deepEqual(sessions.get(sessionId), { model: 'pro', effort: 'high' });
  base.defaultModel = '';
  await invoke(service, sessionId);
  assert.deepEqual(sessions.get(sessionId), { model: 'flash', effort: 'high' });
  sessions.set(sessionId, { model: 'pro', effort: 'low' });
  service = makeService();
  await invoke(service, sessionId);
  assert.deepEqual(sessions.get(sessionId), { model: 'flash', effort: 'high' });
  assert.deepEqual(prompts, [sessionId, sessionId, sessionId, sessionId]);
});
