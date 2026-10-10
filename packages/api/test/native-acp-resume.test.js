import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { AcpAgentService } from '../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';

catRegistry.register('native-resume-test', {
  ...catRegistry.tryGet('opus').config,
  id: 'native-resume-test',
  clientId: 'acp',
  configurationSource: 'native_tool',
  defaultModel: '',
  cli: { effort: 'low' },
});
const effortOptions = [
  { id: 'effort', category: 'thought_level', currentValue: 'high', options: [{ value: 'low' }, { value: 'high' }] },
];

function fixture(loadFails = false) {
  const calls = [];
  const client = {
    recentCapacitySignal: null,
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
    cancelSession() {},
    async loadSession(sessionId) {
      calls.push('load');
      if (loadFails) throw new Error('unknown session');
      return { sessionId, configOptions: [] };
    },
    async newSession() {
      calls.push('new');
      return { sessionId: 'fresh', configOptions: effortOptions };
    },
    async setSessionConfigOption() {
      calls.push('config');
      return { configOptions: [{ ...effortOptions[0], currentValue: 'low' }] };
    },
    async *promptStream(sessionId) {
      calls.push('prompt');
      yield { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reply' } } };
    },
  };
  const pool = {
    async acquire(poolKey) {
      return { client, poolKey, release() {} };
    },
  };
  const service = new AcpAgentService({
    catId: 'native-resume-test',
    pool,
    poolKey: { projectPath: '/tmp', providerProfile: 'native' },
    projectRoot: '/tmp',
    providerName: 'dsh',
    modelName: '',
  });
  return { calls, service };
}

test('native resume configuration rejection preserves history and prevents fresh-session prompt', async () => {
  const { calls, service } = fixture();
  const messages = [];
  for await (const message of service.invoke('continue', { sessionId: 'existing-with-history' }))
    messages.push(message);
  assert.deepEqual(calls, ['new', 'load']);
  assert.ok(messages.some((message) => message.type === 'error'));
});

test('actual load failure can still create and configure a replacement session', async () => {
  const { calls, service } = fixture(true);
  const messages = [];
  for await (const message of service.invoke('continue', { sessionId: 'missing-session' })) messages.push(message);
  assert.deepEqual(calls, ['new', 'load', 'new', 'config', 'prompt']);
  assert.equal(
    messages.some((message) => message.type === 'error'),
    false,
  );
});
