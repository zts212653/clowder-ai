import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';

test('native ACP adopts the model reported by the first session for message metadata', async () => {
  catRegistry.reset();
  catRegistry.register('pi', {
    id: 'pi',
    clientId: 'acp',
    configurationSource: 'native_tool',
    defaultModel: '',
  });
  const client = {
    async newSession() {
      return {
        sessionId: 'pi-session',
        configOptions: [
          {
            id: 'model',
            category: 'model',
            currentValue: '["openai","gpt-5.4"]',
            options: [{ value: '["openai","gpt-5.4"]' }],
          },
        ],
      };
    },
    async setSessionConfigOption() {},
    async *promptStream() {
      yield {
        sessionId: 'pi-session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
      };
    },
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
  };
  const pool = {
    async acquire() {
      return { client, poolKey: { projectPath: '/tmp', providerProfile: 'pi' }, release() {} };
    },
  };
  const service = new AcpAgentService({
    catId: 'pi',
    pool,
    poolKey: { projectPath: '/tmp', providerProfile: 'pi' },
    projectRoot: '/tmp',
    providerName: 'acp',
    modelName: 'acp',
  });
  const messages = [];
  for await (const message of service.invoke('hello')) messages.push(message);
  assert.equal(messages.find((message) => message.type === 'text')?.metadata?.model, '["openai","gpt-5.4"]');
});

test('legacy ACP models are observed on first turn and continuation without replaying unsupported configuration', async () => {
  catRegistry.reset();
  catRegistry.register('pi', { id: 'pi', clientId: 'acp', configurationSource: 'native_tool', defaultModel: '' });
  let created = 0;
  let loaded = 0;
  const legacy = (model) => ({
    sessionId: 'legacy-session',
    models: { currentModelId: model, availableModels: [{ id: model, name: model }] },
  });
  const client = {
    async newSession() {
      created += 1;
      return legacy('legacy-a');
    },
    async loadSession() {
      loaded += 1;
      return legacy('legacy-b');
    },
    async setSessionConfigOption() {
      assert.fail('a legacy model report does not advertise replayable configOptions');
    },
    async *promptStream() {
      yield {
        sessionId: 'legacy-session',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
      };
    },
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
  };
  const poolKey = { projectPath: '/tmp', providerProfile: 'pi' };
  const pool = {
    async acquire() {
      return { client, poolKey, release() {} };
    },
  };
  const service = new AcpAgentService({
    catId: 'pi',
    pool,
    poolKey,
    projectRoot: '/tmp',
    providerName: 'acp',
    modelName: 'acp',
  });
  const first = [];
  for await (const message of service.invoke('hello')) first.push(message);
  assert.equal(
    first.find((message) => message.type === 'error'),
    undefined,
  );
  assert.equal(first.find((message) => message.type === 'text')?.metadata?.model, 'legacy-a');
  const continued = [];
  for await (const message of service.invoke('continue', { sessionId: 'legacy-session' })) continued.push(message);
  assert.equal(
    continued.find((message) => message.type === 'error'),
    undefined,
  );
  assert.equal(continued.find((message) => message.type === 'text')?.metadata?.model, 'legacy-b');
  assert.equal(created, 1, 'continuation preserves the conversation instead of replacing it');
  assert.equal(loaded, 1);
});

test('native ACP applies the captured tool effort before prompting while explicit effort wins', async () => {
  catRegistry.reset();
  catRegistry.register('native-dsh', {
    id: 'native-dsh',
    clientId: 'acp',
    configurationSource: 'native_tool',
    defaultModel: '',
  });
  const model = '["fixture","model"]';
  for (const [override, expected] of [
    [undefined, 'max'],
    ['low', 'low'],
  ]) {
    const requests = [];
    const options = (value = 'high') => [
      { id: 'model', category: 'model', currentValue: model, options: [{ value: model }] },
      {
        id: 'reasoning_effort',
        category: 'thought_level',
        currentValue: value,
        options: ['high', 'max', 'low'].map((value) => ({ value })),
      },
    ];
    const client = {
      async newSession() {
        return { sessionId: 'native-effort-session', configOptions: options() };
      },
      async setSessionConfigOption(_sessionId, configId, value) {
        requests.push([configId, value]);
        return { configOptions: options(value) };
      },
      async *promptStream() {
        assert.deepEqual(requests, [['reasoning_effort', expected]]);
        yield {
          sessionId: 'native-effort-session',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
        };
      },
      onCapacity() {},
      offCapacity() {},
      clearRecentCapacitySignal() {},
    };
    const poolKey = { projectPath: '/tmp', providerProfile: 'native-dsh' };
    const service = new AcpAgentService({
      catId: 'native-dsh',
      pool: {
        async acquire() {
          return { client, poolKey, release() {} };
        },
      },
      poolKey,
      projectRoot: '/tmp',
      mcpSupport: false,
      nativeDefaultEffort: 'max',
    });
    const messages = [];
    for await (const message of service.invoke('hello', override ? { reasoningEffortOverride: override } : undefined))
      messages.push(message);
    assert.equal(
      messages.find((message) => message.type === 'error'),
      undefined,
    );
    assert.ok(messages.some((message) => message.type === 'text'));
  }
});
