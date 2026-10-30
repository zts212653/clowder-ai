/**
 * C05 / C26 / O2 — model, effort and configuration source are frozen at
 * invocation admission. A member edit that lands while the invocation waits for
 * its ACP pool lease must not reach the client; the next invocation uses it.
 * Asserted at the consumer boundary (values actually sent via
 * session/set_config_option), not on the snapshot object.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

const { AcpAgentService } = await import('../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js');
const { freezeRuntimeSelection } = await import('../dist/domains/cats/services/agents/invocation/runtime-selection.js');
const { freezeExecutionAccountBinding } = await import(
  '../dist/domains/cats/services/agents/invocation/execution-account-binding.js'
);

const CAT = 'freeze-acp';

function member(overrides = {}) {
  return {
    id: CAT,
    name: CAT,
    displayName: 'Freeze',
    avatar: '',
    color: { primary: '#000', secondary: '#fff' },
    mentionPatterns: [],
    clientId: 'acp',
    carrier: 'acp',
    configurationSource: 'native_tool',
    defaultModel: 'model-a',
    mcpSupport: false,
    roleDescription: '',
    personality: '',
    cli: { command: 'acp', outputFormat: 'json', effort: 'high' },
    ...overrides,
  };
}

function setMember(overrides) {
  catRegistry.reset();
  catRegistry.register(CAT, member(overrides));
}

function configOptions(model = 'native-default', effort = 'medium') {
  return [
    {
      id: 'model',
      category: 'model',
      currentValue: model,
      options: [{ value: 'model-a' }, { value: 'model-b' }, { value: 'native-default' }],
    },
    {
      id: 'reasoning_effort',
      category: 'thought_level',
      currentValue: effort,
      options: [{ value: 'high' }, { value: 'low' }, { value: 'medium' }],
    },
  ];
}

function makeClient() {
  let model = 'native-default';
  let effort = 'medium';
  const client = {
    sent: [],
    recentCapacitySignal: null,
    async newSession() {
      model = 'native-default';
      effort = 'medium';
      return { sessionId: `s-${client.sent.length}`, configOptions: configOptions(model, effort) };
    },
    async setSessionConfigOption(_sessionId, configId, value) {
      client.sent.push({ configId, value });
      if (configId === 'model') model = value;
      else effort = value;
      return { configOptions: configOptions(model, effort) };
    },
    cancelSession() {},
    async *promptStream(sessionId) {
      yield { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } };
    },
    onCapacity() {},
    offCapacity() {},
    clearRecentCapacitySignal() {},
  };
  return client;
}

/** A pool whose acquire() blocks until the test releases it. */
function makeGatedPool(client) {
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  return {
    pool: {
      async acquire() {
        await gate;
        return { client, release() {} };
      },
      rememberSession() {},
    },
    open: () => open(),
  };
}

function makeService(pool) {
  return new AcpAgentService({
    catId: CAT,
    pool,
    poolKey: { projectPath: '/tmp', providerProfile: 'freeze' },
    projectRoot: '/tmp',
    providerName: 'acp',
    mcpServers: [],
  });
}

/** Distinct values the client was asked to apply, per option (the native-defaults probe may resend one). */
function sentValues(client) {
  const result = {};
  for (const { configId, value } of client.sent) {
    result[configId] ??= [];
    if (!result[configId].includes(value)) result[configId].push(value);
  }
  return result;
}

async function drain(iterable) {
  const messages = [];
  for await (const message of iterable) messages.push(message);
  return messages;
}

afterEach(() => {
  catRegistry.reset();
  delete process.env.CAT_FREEZE_ACP_MODEL;
});

describe('admission-frozen runtime selection (C05/C26)', () => {
  it('an edit landing during the lease wait does not reach the in-flight invocation', async () => {
    setMember({});
    const client = makeClient();
    const gated = makeGatedPool(client);
    const service = makeService(gated.pool);

    const admitted = freezeRuntimeSelection(CAT, catRegistry.tryGet(CAT).config);
    const inflight = drain(service.invoke('first', { runtimeSelection: admitted }));
    await new Promise((resolve) => setImmediate(resolve));

    // The member is edited while the invocation waits for its lease.
    setMember({ defaultModel: 'model-b', cli: { command: 'acp', outputFormat: 'json', effort: 'low' } });
    gated.open();
    const messages = await inflight;

    assert.ok(!messages.some((message) => message.type === 'error'), JSON.stringify(messages));
    assert.deepEqual(sentValues(client), { model: ['model-a'], reasoning_effort: ['high'] });

    // The next invocation is admitted after the edit and uses it.
    client.sent.length = 0;
    const next = freezeRuntimeSelection(CAT, catRegistry.tryGet(CAT).config);
    await drain(
      makeService({ acquire: async () => ({ client, release() {} }), rememberSession() {} }).invoke('second', {
        runtimeSelection: next,
      }),
    );
    assert.deepEqual(sentValues(client), { model: ['model-b'], reasoning_effort: ['low'] });
  });

  it('a direct caller is snapshotted at invoke entry, before the lease wait', async () => {
    setMember({});
    const client = makeClient();
    const gated = makeGatedPool(client);
    const inflight = drain(makeService(gated.pool).invoke('direct'));
    await new Promise((resolve) => setImmediate(resolve));
    setMember({ defaultModel: 'model-b', cli: { command: 'acp', outputFormat: 'json', effort: 'low' } });
    gated.open();
    await inflight;
    assert.deepEqual(sentValues(client), { model: ['model-a'], reasoning_effort: ['high'] });
  });

  it('C26: native_tool with empty model/effort inherits both and sends nothing', async () => {
    setMember({ defaultModel: '', cli: { command: 'acp', outputFormat: 'json' } });
    const selection = freezeRuntimeSelection(CAT, catRegistry.tryGet(CAT).config);
    assert.equal(selection.model, '');
    assert.equal(selection.inheritedEffort, '');
    assert.equal(selection.savedModel, undefined);
    assert.equal(selection.savedEffort, undefined);
    assert.equal(selection.effortSource, 'native_inherit');
    const client = makeClient();
    await drain(
      makeService({ acquire: async () => ({ client, release() {} }), rememberSession() {} }).invoke('x', {
        runtimeSelection: selection,
      }),
    );
    assert.deepEqual(client.sent, [], 'no UI placeholder value may be sent as an explicit preference');
  });

  it('C26: effort-only edit keeps model inherited and sends only effort', async () => {
    setMember({ defaultModel: '', cli: { command: 'acp', outputFormat: 'json', effort: 'low' } });
    const client = makeClient();
    const selection = freezeRuntimeSelection(CAT, catRegistry.tryGet(CAT).config);
    await drain(
      makeService({ acquire: async () => ({ client, release() {} }), rememberSession() {} }).invoke('x', {
        runtimeSelection: selection,
      }),
    );
    assert.deepEqual(client.sent, [{ configId: 'reasoning_effort', value: 'low' }]);
  });

  it('records model source: native_tool, env override and member config are distinct', () => {
    setMember({});
    assert.equal(freezeRuntimeSelection(CAT, catRegistry.tryGet(CAT).config).modelSource, 'native_tool');
    setMember({ configurationSource: 'managed_account', defaultModel: 'model-a' });
    assert.equal(freezeRuntimeSelection(CAT, catRegistry.tryGet(CAT).config).modelSource, 'member_config');
    process.env.CAT_FREEZE_ACP_MODEL = 'model-env';
    const selection = freezeRuntimeSelection(CAT, catRegistry.tryGet(CAT).config);
    assert.equal(selection.model, 'model-env');
    assert.equal(selection.modelSource, 'env_override');
    assert.equal(selection.savedModel, 'model-a', 'saved preference stays separate from the resolved request');
    const missing = freezeRuntimeSelection('missing-cat', undefined);
    assert.equal(missing.modelSource, 'unresolved');
    assert.equal(missing.inheritedEffort, null, 'no member snapshot: consumers keep their provider default');
  });

  it('the execution binding carries the selection captured with its catConfig', () => {
    setMember({});
    const catConfig = catRegistry.tryGet(CAT).config;
    const selection = freezeRuntimeSelection(CAT, catConfig);
    const binding = freezeExecutionAccountBinding({
      catId: CAT,
      catConfig,
      runtimeSelection: selection,
      workspace: { workingProjectRoot: '/tmp' },
    });
    assert.equal(binding.runtimeSelection, selection);
    assert.ok(Object.isFrozen(binding.runtimeSelection));
  });
});
