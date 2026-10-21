import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateManifest } from '@clowder-ai/plugin-contract';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { createModuleHostInvocation } from '../dist/domains/plugin/builtin-runtime/carriers/module-host-invocation.js';
import { currentPluginCallContext } from '../dist/domains/plugin/carrier/plugin-call-context.js';
import { NativePluginActions } from '../dist/domains/plugin/declared/native-plugin-actions.js';
import { createDormantPluginRuntimeComposition } from '../dist/domains/plugin/runtime-composition.js';

async function composition(t, owner) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'f202-custody-registry-'));
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    messageStore: new MessageStore(),
    ...(owner === undefined ? {} : { threadOwnerUserId: owner }),
    mcpConfigIO: { read: async () => ({}), write: async () => {} },
  });
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  return runtime;
}

test('production composition exposes no plugin completion provider', async (t) => {
  const runtime = await composition(t, 'owner');
  assert.equal(Object.hasOwn(runtime, 'predicateProvider'), false);
});

function nativeFixture() {
  const admission = {
    instance: {
      pluginInstanceId: 'instance',
      pluginId: 'dev.clowder.registry-test',
      packageDigest: 'digest',
      lifecycleRevision: 1,
      activationState: 'enabled',
      lifecycleState: 'installed',
      configReadiness: 'ready',
    },
    packageRecord: {
      pluginId: 'dev.clowder.registry-test',
      packageDigest: 'digest',
      manifest: {
        pluginId: 'dev.clowder.registry-test',
        version: '1.0.0',
        contractVersion: '0.1.0',
        name: 'Native custody test',
        runtime: { transport: 'builtin', entrypoint: 'plugin.js' },
        features: [
          {
            id: 'invoke',
            name: 'Invoke',
            resources: [],
            capabilities: [],
            contributions: [{ type: 'mcp', id: 'native' }],
          },
        ],
        contributions: [
          {
            type: 'mcp',
            id: 'native',
            runtime: { transport: 'stdio', entrypoint: 'mcp.js' },
            actions: [{ method: 'review.submit' }],
          },
        ],
      },
    },
    effectiveGrants: [],
  };
  const validation = validateManifest(admission.packageRecord.manifest);
  assert.equal(validation.valid, true, JSON.stringify(validation));
  let inventoryReads = 0;
  let callerCurrent = true;
  const actions = new NativePluginActions(async () => {
    inventoryReads++;
    return admission;
  });
  return {
    actions,
    admission,
    reads: () => inventoryReads,
    expireCaller: () => {
      callerCurrent = false;
    },
    caller: {
      catId: 'reviewer',
      threadId: 'target',
      userId: 'owner',
      invocationId: 'invocation',
      assertCurrent: async () => {
        if (!callerCurrent) throw Error('invocation expired');
      },
      // Host-provided invocation-only check must not reenter the inventory lock.
      assertInvocationCurrent: async () => {
        if (!callerCurrent) throw Error('invocation expired');
      },
    },
    token: () => actions.environment('instance', 'native').CLOWDER_PLUGIN_ACTION_TOKEN,
  };
}

test('native invocation-only authority never reenters inventory and expires with the call', async () => {
  const f = nativeFixture();
  let saved;
  f.actions.activate(f.admission, 0, async () => {
    saved = currentPluginCallContext('instance');
    assert.equal(typeof saved?.assertInvocationCurrent, 'function', 'invocation-only authority missing');
    assert.notEqual(
      saved.assertInvocationCurrent,
      f.caller.assertInvocationCurrent,
      'must capture Host turn and activation',
    );
    const reads = f.reads();
    await saved.assertInvocationCurrent();
    assert.equal(f.reads(), reads, 'inventory lock must not be reentered');
    f.expireCaller();
    await assert.rejects(() => saved.assertInvocationCurrent(), /invocation expired/);
  });
  await assert.rejects(f.actions.call(f.token(), 'review.submit', {}, f.caller), /invocation expired/);
  await assert.rejects(() => saved.assertInvocationCurrent());
});

test('invocation-only authority rejects stop and cannot be revived by a new activation', async () => {
  const f = nativeFixture();
  f.actions.activate(f.admission, 0, async () => {
    const context = currentPluginCallContext('instance');
    assert.equal(typeof context?.assertInvocationCurrent, 'function', 'invocation-only authority missing');
    f.actions.deactivate('instance');
    f.actions.activate(f.admission, f.actions.generation('instance'), async () => {});
    await assert.rejects(() => context.assertInvocationCurrent(), /no longer current/);
  });
  await assert.rejects(f.actions.call(f.token(), 'review.submit', {}, f.caller), /no longer current/);
});

test('ordinary module action receives no internal inventory-safe authority function', async () => {
  const f = nativeFixture();
  const module = createModuleHostInvocation({
    runtime: {
      actions: () => ({
        'review.submit': async (_input, context) => {
          assert.equal(context.assertInvocationCurrent, undefined);
          assert.equal(typeof context.assertCurrent, 'function');
          assert.equal(context.catId, 'reviewer');
          await context.assertCurrent();
          return 'ok';
        },
      }),
    },
  });
  f.actions.activate(f.admission, 0, (method, input) => module.invoke('instance', method, input));
  assert.equal(await f.actions.call(f.token(), 'review.submit', {}, f.caller), 'ok');
});
