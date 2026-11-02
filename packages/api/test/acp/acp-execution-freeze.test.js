import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';

for (const nextSource of ['native_tool', 'managed_account']) {
  test(`ACP applies admitted preferences after its lease waits, despite a later ${nextSource} edit`, async (t) => {
    const all = catRegistry.getAllConfigs();
    const id = 'frozen-acp-preferences';
    const member = {
      ...all.codex,
      id,
      clientId: 'acp',
      configurationSource: 'native_tool',
      accountRef: undefined,
      defaultModel: 'model-a',
      cli: { command: 'fixture', outputFormat: 'json', effort: 'low' },
    };
    catRegistry.register(id, member);
    t.after(() => {
      catRegistry.reset();
      Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
    });
    const executionPreferences = Object.freeze({
      configurationSource: 'native_tool',
      nativeAuthentication: true,
      model: 'model-a',
      effort: 'low',
    });
    let enter, release;
    const entered = new Promise((resolve) => {
      enter = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    const selected = { model: 'model-b', reasoning_effort: 'high' };
    const options = () => [
      {
        id: 'model',
        category: 'model',
        currentValue: selected.model,
        options: ['model-a', 'model-b'].map((value) => ({ value })),
      },
      {
        id: 'reasoning_effort',
        category: 'thought_level',
        currentValue: selected.reasoning_effort,
        options: ['low', 'high'].map((value) => ({ value })),
      },
    ];
    const client = {
      async newSession() {
        return { sessionId: 'native-preference-session', configOptions: options() };
      },
      async setSessionConfigOption(_sessionId, key, value) {
        selected[key] = value;
        return { configOptions: options() };
      },
      async *promptStream() {
        yield {
          sessionId: 'native-preference-session',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
        };
        return 'end_turn';
      },
      onCapacity() {},
      offCapacity() {},
      clearRecentCapacitySignal() {},
    };
    const service = new AcpAgentService({
      catId: id,
      projectRoot: process.cwd(),
      poolKey: { projectPath: process.cwd(), providerProfile: id },
      pool: {
        async acquire() {
          enter();
          await gate;
          return { client, release() {} };
        },
      },
    });
    const pending = Array.fromAsync(service.invoke('isolated task', { executionPreferences }));
    await entered;
    catRegistry.reset();
    Object.entries(all).forEach(([id, config]) => catRegistry.register(id, config));
    catRegistry.register(id, {
      ...member,
      configurationSource: nextSource,
      defaultModel: 'model-b',
      cli: { ...member.cli, effort: 'high' },
    });
    release();
    const messages = await pending;
    assert.deepEqual(
      messages.filter((message) => message.type === 'error'),
      [],
    );
    assert.deepEqual(
      selected,
      { model: 'model-a', reasoning_effort: 'low' },
      'actual ACP configuration adopted a later member edit',
    );
  });
}
