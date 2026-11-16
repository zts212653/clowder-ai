import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import { withInvocationPluginMcpView } from '../dist/config/capabilities/invocation-plugin-mcp-view.js';
import { AcpAgentService } from '../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import {
  captureNativeDefaults,
  defaultsForNativeResume,
} from '../dist/domains/cats/services/agents/providers/acp/native-session-defaults.js';
import {
  applySessionConfiguration,
  resolveSessionOption,
} from '../dist/domains/cats/services/agents/providers/acp/session-configuration.js';
import { discoverNativeRuntimes } from '../dist/routes/native-runtimes.js';
import { parseAcpCatalog } from '../dist/routes/runtime-model-catalog.js';

[
  ['model', 'model'],
  ['effort', 'thought_level'],
].forEach(([preference, category]) => {
  [
    ['unadvertised', ['another']],
    ['duplicate', ['observed', 'observed']],
    ['display alias', ['provider/observed']],
  ].forEach(([scenario, advertised]) => {
    test(`native ${preference} inheritance does not replay an ${scenario} observation`, async () => {
      const session = {
        sessionId: 'history',
        configOptions: [
          {
            id: preference,
            category,
            currentValue: 'observed',
            options: advertised.map((value) => ({ value, name: 'observed' })),
          },
        ],
      };
      const client = { setSessionConfigOption: () => assert.fail('inheritance must not select a value') };
      const captured = await captureNativeDefaults(client, session, '/fixture');
      assert.equal(captured[preference], undefined);
      const resumed = await defaultsForNativeResume(client, '/fixture', {}, () => assert.fail('already cached'));
      assert.equal(resumed[preference], undefined);
      await applySessionConfiguration(client, session, resumed);
    });
  });
});

test('legacy model observations never become selectable, default or selected catalog values', () => {
  const session = {
    models: { currentModelId: 'legacy', availableModels: [{ id: 'legacy', name: 'Legacy' }] },
  };
  const catalog = parseAcpCatalog(session, session);
  assert.deepEqual(catalog.models, []);
  assert.equal(catalog.status, 'unavailable');
  assert.equal(catalog.defaultModelStatus, 'unreported');
  assert.equal(catalog.defaultModel, undefined);
  assert.equal(catalog.selectedModel, undefined);
});

[
  ['unadvertised', ['another']],
  ['duplicate', ['observed', 'observed']],
  ['missing choices', []],
].forEach(([scenario, advertised]) => {
  test(`catalog does not confirm ${scenario} model or effort observations`, () => {
    const session = {
      configOptions: ['model', 'thought_level'].map((category) => ({
        id: category,
        category,
        currentValue: 'observed',
        options: advertised.map((value) => ({ value })),
      })),
    };
    const catalog = parseAcpCatalog(session, session);
    assert.equal(catalog.defaultModelStatus, 'unavailable');
    assert.equal(catalog.defaultModel, undefined);
    assert.equal(catalog.selectedModel, undefined);
    assert.equal(catalog.defaultEffort, undefined);
    assert.equal(catalog.selectedEffort, undefined);
    assert.equal(catalog.defaultEffortSource, undefined);
    assert.equal(catalog.selectedEffortSource, undefined);
  });
});

['fresh', 'warm resume', 'cold resume'].forEach((path) => {
  test(`native ACP ${path} reaches the prompt without replaying unadvertised defaults`, async () => {
    const catId = `issue1933-${path.replaceAll(' ', '-')}`;
    catRegistry.register(catId, {
      id: catId,
      clientId: 'acp',
      configurationSource: 'native_tool',
      defaultModel: '',
      mcpSupport: false,
    });
    const calls = [];
    const describe = (sessionId) => ({
      sessionId,
      configOptions: ['model', 'thought_level'].map((category) => ({
        id: category,
        category,
        currentValue: `observed-${category}`,
        options: [{ value: `selectable-${category}` }],
      })),
    });
    const poolKey = { projectPath: '/fixture', providerProfile: catId };
    const client = {
      async newSession() {
        calls.push('new');
        return describe(path === 'cold resume' ? 'probe' : 'history');
      },
      async loadSession(id) {
        calls.push(`load:${id}`);
        return describe(id);
      },
      async closeSession(id) {
        calls.push(`close:${id}`);
      },
      setSessionConfigOption: () => assert.fail('unadvertised defaults must not be replayed'),
      async *promptStream(id) {
        calls.push(`prompt:${id}`);
        yield {
          sessionId: id,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } },
        };
      },
      onCapacity() {},
      offCapacity() {},
      clearRecentCapacitySignal() {},
    };
    const service = new AcpAgentService({
      catId,
      pool: { acquire: async () => ({ client, poolKey, release() {} }) },
      poolKey,
      projectRoot: '/fixture',
      providerName: 'acp',
      modelName: '',
    });
    if (path === 'warm resume') {
      for await (const message of service.invoke('first')) assert.notEqual(message.type, 'error');
      calls.length = 0;
    }
    const messages = [];
    for await (const message of service.invoke('hello', path === 'fresh' ? {} : { sessionId: 'history' })) {
      messages.push(message);
    }
    assert.equal(
      messages.find((message) => message.type === 'error'),
      undefined,
    );
    assert.equal(messages.find((message) => message.type === 'text')?.content, 'ok');
    assert.equal(messages.find((message) => message.type === 'text')?.metadata?.model, 'observed-model');
    assert.deepEqual(
      calls,
      path === 'fresh'
        ? ['new', 'prompt:history']
        : path === 'warm resume'
          ? ['load:history', 'prompt:history']
          : ['new', 'close:probe', 'load:history', 'prompt:history'],
    );
  });
});

test('ACP discovery does not recommend a model merely because a member saved it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'issue1933-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catId = 'issue1933-saved';
  catRegistry.register(catId, {
    id: catId,
    clientId: 'acp',
    defaultModel: 'stale-saved-model',
    configurationSource: 'native_tool',
  });
  await writeFile(
    join(root, 'cat-template.json'),
    JSON.stringify({
      breeds: [
        { id: 'fixture', variants: [{ id: 'default', catId, acp: { command: process.execPath, startupArgs: [] } }] },
      ],
    }),
  );
  const found = await discoverNativeRuntimes(root, () => null);
  assert.deepEqual(found.runtimes.find((runtime) => runtime.id === `acp:${catId}`)?.models, []);
  assert.equal(
    catRegistry.tryGet(catId).config.defaultModel,
    'stale-saved-model',
    'discovery never rewrites preferences',
  );
});

test('equal-current model aliases still reject provider ambiguity', () => {
  const session = {
    configOptions: [{ id: 'model', currentValue: 'pro', options: [{ value: 'a/pro' }, { value: 'b/pro' }] }],
  };
  assert.throws(() => resolveSessionOption(session, 'model', 'pro'), /不唯一/);
});

test('an invalid explicit model remains rejected with an actionable correction', async () => {
  await assert.rejects(
    applySessionConfiguration(
      { setSessionConfigOption: () => assert.fail('invalid explicit preference must not be sent') },
      { sessionId: 'history', configOptions: [{ id: 'model', currentValue: 'other', options: [{ value: 'other' }] }] },
      { model: 'stale-saved-model' },
    ),
    /重选模型.*清空模型/,
  );
});

test('plugin initialization recovery keeps unconfirmed defaults inherited and sends one business prompt', async () => {
  const catId = 'issue1933-plugin-recovery';
  catRegistry.register(catId, { id: catId, clientId: 'acp', configurationSource: 'native_tool', defaultModel: '' });
  let current = true;
  const capabilityId = 'plugin:issue1933:optional';
  const server = {
    name: capabilityId.replaceAll(':', '__'),
    command: process.execPath,
    args: ['--fixture-plugin'],
    env: [{ name: 'CLOWDER_PLUGIN_ACTION_TOKEN', value: 'fixture-token' }],
    hostSource: 'plugin',
  };
  const initializations = [],
    prompts = [];
  const client = {
    async newSession(_cwd, servers) {
      initializations.push(servers.map(({ name }) => name));
      if (initializations.length === 1) {
        current = false;
        throw new Error('ACP error -32603: Internal error');
      }
      return {
        sessionId: 'history',
        configOptions: [{ id: 'model', currentValue: 'observed', options: [{ value: 'real' }] }],
      };
    },
    setSessionConfigOption: () => assert.fail('recovery must not select an unconfirmed model'),
    async *promptStream(_id, prompt) {
      prompts.push(prompt);
      yield { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } };
    },
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
  };
  const service = new AcpAgentService({
    catId,
    projectRoot: '/fixture',
    mcpServers: [server],
    poolKey: { projectPath: '/fixture', providerProfile: catId },
    pool: { acquire: async () => ({ client, release() {} }) },
  });
  const frozen = await withInvocationPluginMcpView(() => service.captureInvocationOptions({}), {
    entries: [
      {
        capabilityId,
        pluginId: 'issue1933',
        isCurrent: () => current,
        server: {
          command: server.command,
          args: server.args,
          env: { CLOWDER_PLUGIN_ACTION_TOKEN: 'fixture-token' },
        },
      },
    ],
  });
  const messages = [];
  for await (const message of service.invoke('business prompt', frozen)) messages.push(message);
  assert.deepEqual(initializations, [[server.name], []]);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /business prompt/);
  assert.equal(
    messages.find((message) => message.type === 'error'),
    undefined,
  );
  assert.equal(messages.find((message) => message.type === 'text')?.content, 'ok');
});

[' ["unknown","unknown"] \n', '["\\u0075nknown","unknown"]', '["unknown","\\u0075nknown"]'].forEach((value) => {
  test(`semantic unknown pair is not captured or replayed on resume: ${JSON.stringify(value)}`, async () => {
    const option = { id: 'model', category: 'model', currentValue: value, options: [{ value }] };
    const calls = [];
    const client = {
      async setSessionConfigOption(_id, _configId, selected) {
        calls.push(selected);
        return { configOptions: [{ ...option, currentValue: selected }] };
      },
    };
    const captured = await captureNativeDefaults(client, { sessionId: 'new', configOptions: [option] }, '/fixture');
    const resumed = await defaultsForNativeResume(client, '/fixture', {}, () => assert.fail('already cached'));
    await applySessionConfiguration(
      client,
      { sessionId: 'history', configOptions: [{ ...option, currentValue: 'real' }] },
      resumed,
    );
    assert.deepEqual(captured, {});
    assert.deepEqual(resumed, {});
    assert.deepEqual(calls, []);
  });
});

['', ' ["provider","\\u006dodel"] '].forEach((value) => {
  test(`advertised non-unknown wire values remain byte-for-byte replayable: ${JSON.stringify(value)}`, async () => {
    const option = { id: 'model', category: 'model', currentValue: value, options: [{ value }] };
    const calls = [];
    const client = {
      async setSessionConfigOption(_id, _configId, selected) {
        calls.push(selected);
        return { configOptions: [{ ...option, currentValue: selected }] };
      },
    };
    const captured = await captureNativeDefaults(client, { sessionId: 'new', configOptions: [option] }, '/fixture');
    await applySessionConfiguration(
      client,
      { sessionId: 'history', configOptions: [{ ...option, currentValue: 'real' }] },
      captured,
    );
    assert.deepEqual(captured, { model: value });
    assert.deepEqual(calls, [value]);
  });
});
