import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createModuleHostInvocation } from '../dist/domains/plugin/builtin-runtime/carriers/module-host-invocation.js';
import { withPluginCallContext } from '../dist/domains/plugin/carrier/plugin-call-context.js';
import { captureNativeCallbackCurrentness } from '../dist/routes/plugin-native-action-currentness.js';

function fixture(overrides = {}) {
  const record = {
    userId: 'owner',
    threadId: 'thread',
    catId: 'cat',
    invocationId: 'inv',
    originTriggerMessageId: 'origin',
    ownerAuthProvenance: 'strict',
    ...overrides,
  };
  const target = { instanceId: 'plugin', contributionId: 'native', method: 'example.send' };
  const fence = captureNativeCallbackCurrentness(record, 'private-token', target, {
    registry: { verifyLatest: async () => ({ ok: true, record }) },
    threadStore: { get: async () => ({ id: 'thread', createdBy: 'owner' }) },
  });
  return { record, fence };
}

test('ordinary native module receives authenticated owner provenance and exact origin separately from input', async () => {
  const { fence } = fixture();
  const runtime = createModuleHostInvocation({
    runtime: {
      actions: () => ({
        'example.send': async (input, context) => {
          await context.assertCurrent();
          assert.equal(context.ownerAuthProvenance, 'strict');
          assert.equal(context.originTriggerMessageId, 'origin');
          assert.equal(context.source.sourceMessageId, 'adopted-source');
          assert.equal(context.toolExecutionPolicy, undefined);
          assert.equal(Object.hasOwn(context, 'callbackToken'), false);
          assert.equal(Object.isFrozen(context), true);
          assert.equal(input.ownerAuthProvenance, 'spoof');
          return 'sent';
        },
      }),
    },
  });
  try {
    const result = await withPluginCallContext(
      'plugin',
      {
        ...fence.identity,
        source: { kind: 'adopted_hold', sourceMessageId: 'adopted-source', holdTaskId: 'hold' },
        assertCurrent: fence.assertCurrent,
        assertInvocationCurrent: fence.assertInvocationCurrent,
      },
      () => runtime.invoke('plugin', 'example.send', { ownerAuthProvenance: 'spoof' }),
    );
    assert.equal(result, 'sent');
  } finally {
    fence.close();
  }
});

test('restricted native scope remains a detached immutable policy, not owner authority', async () => {
  const policy = {
    mode: 'plugin_native',
    pluginInstanceId: 'plugin',
    contributionId: 'native',
    actionMethods: ['example.send'],
  };
  const { fence, record } = fixture({ ownerAuthProvenance: 'unknown', toolExecutionPolicy: policy });
  assert.equal(fence.identity.ownerAuthProvenance, 'unknown');
  assert.deepEqual(fence.identity.toolExecutionPolicy, policy);
  assert.notEqual(fence.identity.toolExecutionPolicy, record.toolExecutionPolicy);
  assert.equal(Object.isFrozen(fence.identity.toolExecutionPolicy.actionMethods), true);
  await fence.assertCurrent();
  record.toolExecutionPolicy.actionMethods.push('example.other');
  await assert.rejects(fence.assertInvocationCurrent, /no longer current/);
  assert.deepEqual(fence.identity.toolExecutionPolicy.actionMethods, ['example.send']);
  fence.close();
});

for (const provenance of ['compatibility_fallback', 'unknown', undefined]) {
  test(`owner provenance ${String(provenance)} is never upgraded to strict`, () => {
    const { fence } = fixture({ ownerAuthProvenance: provenance });
    assert.equal(fence.identity.ownerAuthProvenance, provenance ?? 'unknown');
    fence.close();
  });
}

for (const [name, mutate] of [
  [
    'owner downgrade',
    (r) => {
      r.ownerAuthProvenance = 'unknown';
    },
  ],
  [
    'owner compatibility downgrade',
    (r) => {
      r.ownerAuthProvenance = 'compatibility_fallback';
    },
  ],
  [
    'policy introduction',
    (r) => {
      r.toolExecutionPolicy = {
        mode: 'plugin_native',
        pluginInstanceId: 'plugin',
        contributionId: 'native',
        actionMethods: ['example.send'],
      };
    },
  ],
]) {
  test(`${name} during a native call poisons the request even after restoration`, async () => {
    const { record, fence } = fixture();
    await fence.assertCurrent();
    mutate(record);
    await assert.rejects(fence.assertCurrent, /no longer current/);
    record.ownerAuthProvenance = 'strict';
    delete record.toolExecutionPolicy;
    await assert.rejects(fence.assertCurrent, /no longer current/);
    fence.close();
  });
}

test('removing an allowed native policy invalidates the original call', async () => {
  const { record, fence } = fixture({
    ownerAuthProvenance: 'unknown',
    toolExecutionPolicy: {
      mode: 'plugin_native',
      pluginInstanceId: 'plugin',
      contributionId: 'native',
      actionMethods: ['example.send'],
    },
  });
  await fence.assertCurrent();
  delete record.toolExecutionPolicy;
  await assert.rejects(fence.assertCurrent, /no longer current/);
  fence.close();
});
