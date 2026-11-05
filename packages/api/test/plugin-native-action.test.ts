import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { type McpContribution, validateManifest } from '@clowder-ai/plugin-contract';
import { pluginMcpEnvironment } from '../src/config/capabilities/plugin-mcp-environment.js';
import { createModuleHostInvocation } from '../src/domains/plugin/builtin-runtime/carriers/module-host-invocation.js';
import { currentPluginCallContext } from '../src/domains/plugin/carrier/plugin-call-context.js';
import { DeclaredRuntimeContributions } from '../src/domains/plugin/declared/declared-runtime-contributions.js';
import { NativePluginActions } from '../src/domains/plugin/declared/native-plugin-actions.js';
import { createPluginTaskHost } from '../src/domains/plugin/host-surface/task/plugin-task-host.js';

const admission = (id = 'instance') => ({
  instance: {
    pluginInstanceId: id,
    pluginId: id,
    packageDigest: 'digest',
    lifecycleRevision: 1,
    activationState: 'enabled',
    lifecycleState: 'installed',
    configReadiness: 'ready',
  },
  packageRecord: {
    pluginId: id,
    packageDigest: 'digest',
    manifest: {
      pluginId: id,
      version: '1.0.0',
      contractVersion: '0.1.0',
      runtime: { transport: 'builtin', entrypoint: 'dist/plugin.js' },
      name: 'Native action fixture',
      features: [
        { id: 'main', name: 'Main', resources: [], capabilities: [], contributions: [{ type: 'mcp', id: 'example' }] },
      ],
      contributions: [
        {
          type: 'mcp',
          id: 'example',
          runtime: { transport: 'stdio', entrypoint: 'dist/mcp.js' },
        } satisfies McpContribution,
      ],
    },
  },
});
const caller = () => ({
  catId: 'cat',
  threadId: 'thread',
  userId: 'user',
  invocationId: 'inv',
  assertCurrent: async () => {},
});
const fixture = () => {
  const authority = admission();
  const validation = validateManifest(authority.packageRecord.manifest);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  const actions = new NativePluginActions(async () => authority as never);
  return { actions, authority };
};
const actionToken = async (actions: NativePluginActions, contributionId = 'example') => {
  const file = actions.environment('instance', contributionId).CLOWDER_PLUGIN_ACTION_CREDENTIAL_FILE;
  assert.ok(file);
  return (JSON.parse(await readFile(file, 'utf8')) as { token: string }).token;
};

test('each admitted action receives a Host call identity that overrides claimed metadata and expires with the call', async () => {
  const { actions, authority } = fixture();
  let check: (() => Promise<void>) | undefined;
  actions.activate(authority as never, 0, async () => {
    const context = currentPluginCallContext('instance')!;
    check = context.assertCurrent;
    return context.nativeAction;
  });
  const token = actions.environment('instance', 'example').CLOWDER_PLUGIN_ACTION_TOKEN!;
  const claimed = { ...caller(), nativeAction: { id: 'forged', contributionId: 'other', method: 'other.run' } };
  const first = await actions.call(token, 'example.run', {}, claimed);
  const second = await actions.call(token, 'example.run', {}, claimed);
  assert.ok(first && typeof first === 'object' && 'id' in first);
  assert.ok(second && typeof second === 'object' && 'id' in second);
  assert.notEqual(first.id, 'forged');
  assert.notEqual(first.id, second.id);
  assert.deepEqual({ ...first, id: 'ignored' }, { id: 'ignored', contributionId: 'example', method: 'example.run' });
  await assert.rejects(check!(), /no longer current/);
});

test('MCP dispatch reaches the current plugin handlers and retains contribution identity', async () => {
  const authority = admission();
  authority.packageRecord.manifest.features.push({
    id: 'other',
    name: 'Other',
    resources: [],
    capabilities: [],
    contributions: [{ type: 'mcp', id: 'other' }],
  });
  for (const id of ['other'])
    authority.packageRecord.manifest.contributions.push({
      type: 'mcp',
      id,
      runtime: { transport: 'stdio', entrypoint: `dist/${id}.js` },
    });
  const validation = validateManifest(authority.packageRecord.manifest);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
  const actions = new NativePluginActions(async () => authority as never);
  await actions.activate(authority as never, 0, async (method) => method);
  const token = await actionToken(actions);
  assert.equal(await actions.call(token, 'example.run', {}, caller()), 'example.run');
  assert.equal(await actions.call(token, 'other.run', {}, caller()), 'other.run');
  const otherToken = await actionToken(actions, 'other');
  assert.notEqual(otherToken, token);
  assert.equal(await actions.call(otherToken, 'other.run', {}, caller()), 'other.run');
  assert.deepEqual(actions.environment('instance', 'undeclared'), {});
  const declared = new DeclaredRuntimeContributions({} as never);
  await declared.activate(authority as never, async () => {
    throw Error('direct tool must not run');
  });
  assert.deepEqual(declared.listPluginTools('instance'), []);
  await assert.rejects(declared.callPluginTool('instance', 'example', 'example.run', {}), {
    code: 'DELIVERY_REJECTED',
    message: 'instance/example/example.run is not a declared direct tool',
  });
  actions.deactivate('instance');
  await assert.rejects(actions.call(otherToken, 'other.run', {}, caller()));
});

test('native MCP calls its active handler and carries separate verified context', async () => {
  const { actions, authority } = fixture();
  const invocation = createModuleHostInvocation({
    runtime: { actions: () => ({ 'example.run': async (input: unknown, context: unknown) => ({ input, context }) }) },
  });
  await actions.activate(authority as never, actions.generation('instance'), (method, input) =>
    invocation.invoke('instance', method, input),
  );
  const token = await actionToken(actions);
  const result = (await actions.call(token, 'example.run', { catId: 'spoofed' }, caller())) as any;
  assert.equal(result.input.catId, 'spoofed');
  assert.equal(result.context.catId, 'cat');
  assert.equal(result.context.callbackToken, undefined);
  assert.equal(currentPluginCallContext('instance'), undefined);
  await assert.rejects(actions.call(token, 'constructor', {}, caller()));
  await assert.rejects(actions.call('other-token', 'example.run', {}, caller()));
});

test('stop invalidates an in-flight call before its task mutation, and reload never revives old context', async () => {
  const { actions, authority } = fixture();
  let finish!: () => void;
  const paused = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let writes = 0;
  await actions.activate(authority as never, 0, async () => {
    const context = currentPluginCallContext('instance')!;
    entered();
    await paused;
    await context.assertCurrent();
    writes++;
  });
  const token = await actionToken(actions);
  const pending = actions.call(token, 'example.run', {}, caller());
  await started;
  actions.deactivate('instance');
  await actions.activate(authority as never, actions.generation('instance'), async () => {});
  finish();
  await assert.rejects(pending);
  assert.equal(writes, 0);
  await assert.rejects(actions.call(token, 'example.run', {}, caller()), { statusCode: 401 });
});

test('late startup cannot create a connection after stop intent', async () => {
  const { actions, authority } = fixture();
  const generation = actions.generation('instance');
  actions.deactivate('instance');
  await assert.rejects(actions.activate(authority as never, generation, async () => {}));
});

for (const change of ['disabled', 'package', 'caller'] as const) {
  test(`refuses ${change} changes before entering package action`, async () => {
    const { actions, authority } = fixture();
    let calls = 0;
    await actions.activate(authority as never, 0, async () => {
      calls++;
    });
    const token = await actionToken(actions);
    const identity = caller();
    if (change === 'disabled') authority.instance.activationState = 'disabled';
    if (change === 'package') authority.instance.packageDigest = 'other-package';
    if (change === 'caller')
      identity.assertCurrent = async () => {
        throw new Error('stale turn');
      };
    await assert.rejects(actions.call(token, 'example.run', {}, identity));
    assert.equal(calls, 0);
  });
}

test('SDK task mutation checks the invoking turn after provider work without relying on plugin checks', async () => {
  const { actions, authority } = fixture();
  let writes = 0;
  let current = true;
  const tasks = createPluginTaskHost({
    pluginId: 'instance',
    pluginInstanceId: 'instance',
    taskStore: {
      create: async () => {
        writes++;
        return {};
      },
    } as never,
  });
  await actions.activate(authority as never, 0, async () => {
    current = false;
    return tasks.create({ threadId: 'thread', title: 'late result' });
  });
  const identity = {
    ...caller(),
    assertCurrent: async () => {
      if (!current) throw new Error('stale invocation');
    },
  };
  await assert.rejects(actions.call(await actionToken(actions), 'example.run', {}, identity));
  assert.equal(writes, 0);
});

test('transport injects current invocation credentials only for installed plugin connections', () => {
  const plugin = {
    source: 'plugin',
    env: {
      CLOWDER_PLUGIN_ACTION_TOKEN: 'activation',
      CAT_CAFE_CALLBACK_TOKEN: 'old',
      CAT_CAFE_CREDENTIAL_FILE: 'old-file',
    },
  };
  const env = pluginMcpEnvironment(plugin, { CAT_CAFE_CALLBACK_TOKEN: 'new', CAT_CAFE_API_URL: 'http://host' })!;
  assert.equal(env.CAT_CAFE_CALLBACK_TOKEN, 'new');
  assert.equal(env.CAT_CAFE_CREDENTIAL_FILE, undefined);
  assert.equal(plugin.env.CAT_CAFE_CALLBACK_TOKEN, 'old');
  const external = { ...plugin, source: 'external' };
  assert.deepEqual(pluginMcpEnvironment(external, { CAT_CAFE_CALLBACK_TOKEN: 'new' }), external.env);
});

test('concurrent requests keep caller identity isolated and nested other-package actions get no inherited identity', async () => {
  const { actions, authority } = fixture();
  const invocation = createModuleHostInvocation({
    runtime: { actions: () => ({ 'example.run': async (_input: unknown, context: unknown) => context }) },
  });
  await actions.activate(authority as never, 0, async () => {
    await Promise.resolve();
    assert.equal(await invocation.invoke('another-instance', 'example.run', {}), undefined);
    return invocation.invoke('instance', 'example.run', {});
  });
  const token = await actionToken(actions);
  const [first, second] = (await Promise.all([
    actions.call(token, 'example.run', {}, { ...caller(), invocationId: 'first' }),
    actions.call(token, 'example.run', {}, { ...caller(), invocationId: 'second' }),
  ])) as any[];
  assert.equal(first.invocationId, 'first');
  assert.equal(second.invocationId, 'second');
  await assert.rejects(first.assertCurrent());
});

test('connection credentials rotate for each activation and do not survive a Host restart', async () => {
  const { actions, authority } = fixture();
  await actions.activate(authority as never, 0, async () => 'first');
  const token = await actionToken(actions);
  actions.deactivate('instance');
  await assert.rejects(actions.call(token, 'example.run', {}, caller()));
  await actions.activate(authority as never, actions.generation('instance'), async () => 'enabled-again');
  const reenabledToken = await actionToken(actions);
  assert.notEqual(reenabledToken, token);
  await assert.rejects(actions.call(token, 'example.run', {}, caller()));
  assert.equal(await actions.call(reenabledToken, 'example.run', {}, caller()), 'enabled-again');
  const restarted = new NativePluginActions(async () => authority as never);
  await restarted.activate(authority as never, 0, async () => 'new-host');
  assert.notEqual(await actionToken(restarted), reenabledToken);
  await assert.rejects(restarted.call(token, 'example.run', {}, caller()));
});

test('MCP registration uses a stable process-env reference across Host replacement', async () => {
  const { actions, authority } = fixture();
  await actions.activate(authority as never, 0, async () => ({ ok: true }));
  const refs = actions.environmentReferences('instance', 'example');
  assert.match(refs.CLOWDER_PLUGIN_ACTION_CREDENTIAL_FILE!, /^\$\{CLOWDER_PLUGIN_[A-F0-9]+_ACTION_CREDENTIAL_FILE\}$/);
  const env = pluginMcpEnvironment({ source: 'plugin', env: { ...refs } }, {})!;
  assert.equal(
    env.CLOWDER_PLUGIN_ACTION_CREDENTIAL_FILE,
    actions.environment('instance', 'example').CLOWDER_PLUGIN_ACTION_CREDENTIAL_FILE,
  );
  const previousFile = env.CLOWDER_PLUGIN_ACTION_CREDENTIAL_FILE;
  const replacement = new NativePluginActions(async () => authority as never);
  await replacement.activate(authority as never, 0, async () => ({ ok: true }));
  assert.deepEqual(replacement.environmentReferences('instance', 'example'), refs);
  const fresh = pluginMcpEnvironment({ source: 'plugin', env: { ...refs } }, {})!;
  assert.notEqual(fresh.CLOWDER_PLUGIN_ACTION_CREDENTIAL_FILE, previousFile);
  assert.equal(
    fresh.CLOWDER_PLUGIN_ACTION_CREDENTIAL_FILE,
    replacement.environment('instance', 'example').CLOWDER_PLUGIN_ACTION_CREDENTIAL_FILE,
  );
  const replacementToken = await actionToken(replacement);
  replacement.deactivate('instance');
  await assert.rejects(replacement.call(replacementToken, 'example.run', {}, caller()), {
    statusCode: 401,
  });
});
