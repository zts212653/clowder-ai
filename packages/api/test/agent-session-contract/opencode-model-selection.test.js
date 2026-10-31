import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  applySessionConfiguration,
  resolveSessionOption,
} from '../../dist/domains/cats/services/agents/providers/acp/session-configuration.js';

// OpenCode 1.19.0 session/new receipt captured in the isolated 1c environment.
const receipt = JSON.parse(
  await readFile(new URL('../fixtures/opencode-session-config.json', import.meta.url), 'utf8'),
);
const model = 'opencode/deepseek-v4.1-flash-free';
for (const requested of [model, 'deepseek-v4.1-flash-free']) {
  test(`OpenCode native select options resolve ${requested} to the advertised wire value`, async () => {
    const session = { sessionId: 'opencode-session', ...structuredClone(receipt) };
    assert.deepEqual(resolveSessionOption(session, 'model', requested), {
      configId: 'model',
      value: model,
      unchanged: false,
    });
    const requests = [];
    await applySessionConfiguration(
      {
        async setSessionConfigOption(sessionId, configId, value) {
          requests.push({ sessionId, configId, value });
          const updated = structuredClone(receipt);
          updated.configOptions[0].currentValue = value;
          return updated;
        },
      },
      session,
      { model: requested },
    );
    assert.deepEqual(requests, [{ sessionId: 'opencode-session', configId: 'model', value: model }]);
  });
}

test('OpenCode short model ids reject ambiguity; an exact advertised value still wins', () => {
  const session = structuredClone(receipt);
  session.configOptions[0].options.push({ value: 'other/deepseek-v4.1-flash-free', name: 'Other model' });
  assert.throws(() => resolveSessionOption(session, 'model', 'deepseek-v4.1-flash-free'), /不唯一/);
  assert.equal(resolveSessionOption(session, 'model', model).value, model);
  assert.throws(() => resolveSessionOption(session, 'model', 'missing-model'), /无效/);
});

test('OpenCode selection already at the advertised model sends no redundant config request', async () => {
  const session = { sessionId: 'opencode-session', ...structuredClone(receipt) };
  session.configOptions[0].currentValue = model;
  await applySessionConfiguration({ setSessionConfigOption: () => assert.fail('already selected') }, session, {
    model: 'deepseek-v4.1-flash-free',
  });
});

for (const requested of [model, 'deepseek-v4.1-flash-free']) {
  test(`native ACP invocation replays OpenCode configOptions and prompts with selected model: ${requested}`, async () => {
    const { catRegistry } = await import('@cat-cafe/shared');
    const { AcpAgentService } = await import(
      '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js'
    );
    const catId = requested === model ? 'opencode-model-full' : 'opencode-model-short';
    catRegistry.register(catId, {
      id: catId,
      clientId: 'acp',
      configurationSource: 'native_tool',
      defaultModel: requested,
      mcpSupport: false,
    });
    let current;
    const selected = [];
    let prompted = false;
    const client = {
      async newSession() {
        current = { sessionId: 'opencode-session', ...structuredClone(receipt) };
        return current;
      },
      async setSessionConfigOption(_id, configId, value) {
        assert.equal(configId, 'model');
        assert.equal(value, model);
        selected.push(value);
        current = structuredClone(current);
        current.configOptions[0].currentValue = value;
        return { configOptions: current.configOptions };
      },
      async *promptStream() {
        prompted = true;
        assert.equal(current.configOptions[0].currentValue, model);
        yield {
          sessionId: 'opencode-session',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好的。' } },
        };
      },
      onCapacity() {},
      offCapacity() {},
      clearRecentCapacitySignal() {},
    };
    const poolKey = { projectPath: '/tmp', providerProfile: catId };
    const service = new AcpAgentService({
      catId,
      pool: {
        async acquire() {
          return { client, poolKey, release() {} };
        },
      },
      poolKey,
      projectRoot: '/tmp',
      providerName: 'acp',
      modelName: requested,
    });
    const messages = [];
    for await (const message of service.invoke('只回复好的。')) messages.push(message);
    assert.equal(prompted, true);
    assert.ok(selected.length > 0);
    assert.equal(
      messages.some((message) => message.type === 'error'),
      false,
    );
    assert.equal(messages.find((message) => message.type === 'text')?.metadata.model, model);
    assert.equal(messages.filter((message) => message.type === 'done').length, 1);
  });
}
