import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { currentPluginCallContext } from '../dist/domains/plugin/carrier/plugin-call-context.js';
import { NativePluginActions } from '../dist/domains/plugin/declared/native-plugin-actions.js';
import { pluginNativeActionRoutes } from '../dist/routes/plugin-native-action-routes.js';

const publicBinding = () => ({
  version: 1,
  entryId: 'entry-1',
  carrier: {
    version: 1,
    admissionId: 'admission-1',
    sourceMessageId: 'source-1',
    sourcePluginRevision: 1,
    pluginInstanceId: 'instance',
    packageDigest: 'digest',
    lifecycleRevision: 1,
    grantRevision: 0,
    contributionId: 'native',
    actionMethods: ['native.read'],
    targetCatId: 'astra',
    authorityRef: 'authority-1',
    authorityRevision: 'r1',
  },
});
const policy = () => ({
  mode: 'plugin_native',
  pluginInstanceId: 'instance',
  contributionId: 'native',
  actionMethods: ['native.read'],
});
async function fixture(t, options = {}) {
  const app = Fastify();
  t.after(() => app.close());
  const registry = new InvocationRegistry();
  const credentials = await registry.create(
    'owner',
    'astra',
    'thread',
    undefined,
    undefined,
    policy(),
    'source-1',
    'unknown',
    undefined,
    options.ordinary ? undefined : publicBinding(),
  );
  const record = await registry.getRecord(credentials.invocationId);
  const admission = {
    instance: {
      pluginInstanceId: 'instance',
      packageDigest: 'digest',
      lifecycleRevision: 1,
      activationState: 'enabled',
      lifecycleState: 'installed',
      configReadiness: 'ready',
    },
    packageRecord: {
      manifest: {
        features: [{ capabilities: [], contributions: [{ type: 'mcp', id: 'native' }] }],
        contributions: [{ type: 'mcp', id: 'native', actions: [{ method: 'native.read' }] }],
      },
    },
    effectiveGrants: [],
  };
  let entered = 0,
    checks = 0,
    revoked = false,
    sourceExists = true,
    savedContext;
  const actions = new NativePluginActions(async () => admission);
  const state = {
    record,
    credentials,
    revoke: () => {
      revoked = true;
    },
    restore: () => {
      revoked = false;
    },
    deleteSource: () => {
      sourceExists = false;
    },
    entered: () => entered,
    checks: () => checks,
    context: () => savedContext,
  };
  actions.activate(admission, 0, async () => {
    entered++;
    savedContext = currentPluginCallContext('instance');
    await options.handler?.(state, savedContext);
    return 'private-result';
  });
  const verify = async (id, token) =>
    id === credentials.invocationId && token === credentials.callbackToken
      ? { ok: true, record }
      : { ok: false, reason: 'invalid_token' };
  await app.register(pluginNativeActionRoutes, {
    actions,
    registry: { verify, verifyLatest: verify, isStartupRecoveryComplete: () => true },
    sources: {
      messageStore: {
        getById: async () => {
          return sourceExists ? { id: 'source-1', userId: 'owner', threadId: 'thread' } : null;
        },
      },
    },
    threadStore: {
      get: async () => {
        await options.onThread?.(state);
        return { createdBy: 'owner' };
      },
    },
    ...(options.missingVerifier
      ? {}
      : {
          publicInvocations: {
            assertPublicInvocationCurrent: async (instanceId, carrier, binding, context) => {
              checks++;
              assert.equal(instanceId, 'instance');
              assert.deepEqual(carrier, publicBinding().carrier);
              assert.deepEqual(binding, {
                entryId: 'entry-1',
                userId: 'owner',
                threadId: 'thread',
                targetCatId: 'astra',
                invocationId: credentials.invocationId,
              });
              assert.ok(Object.isFrozen(carrier.actionMethods));
              assert.ok(context.signal instanceof AbortSignal);
              context.signal.throwIfAborted();
              await context.assertCurrent();
              if (revoked || !sourceExists) throw new Error('secret-authority-detail');
              await options.onVerify?.(state, context);
            },
          },
        }),
  });
  return {
    ...state,
    request: (input = {}) =>
      app.inject({
        method: 'POST',
        url: '/api/plugin-runtime/action',
        headers: {
          'x-invocation-id': credentials.invocationId,
          'x-callback-token': credentials.callbackToken,
          'x-clowder-plugin-action-token': actions.environment('instance', 'native').CLOWDER_PLUGIN_ACTION_TOKEN,
        },
        payload: { method: 'native.read', input },
      }),
  };
}

test('public callback validates frozen registry binding and exact child before package action', async (t) => {
  const f = await fixture(t);
  const result = await f.request({ source: 'spoof', invocationId: 'spoof', authority: 'spoof' });
  assert.equal(result.statusCode, 200, result.body);
  assert.ok(f.checks() > 0, 'missing public callback currentness fence');
  assert.equal(f.entered(), 1);
});
test('public callback fails closed when runtime currentness port is absent', async (t) => {
  const f = await fixture(t, { missingVerifier: true });
  assert.equal((await f.request()).statusCode, 409);
  assert.equal(f.entered(), 0);
});
test('public callback rejects revoked authority before package entry without exposing secrets', async (t) => {
  const f = await fixture(t);
  f.revoke();
  const response = await f.request();
  assert.equal(response.statusCode, 409);
  assert.equal(f.entered(), 0);
  assert.equal(response.body.includes('secret-authority-detail'), false);
});
test('public callback source deletion cannot downgrade to ordinary native action', async (t) => {
  const f = await fixture(t);
  f.deleteSource();
  assert.equal((await f.request()).statusCode, 409);
  assert.equal(f.entered(), 0);
});
test('public callback rejects binding removal during awaited thread lookup', async (t) => {
  const f = await fixture(t, {
    onThread: async ({ record }) => {
      delete record.publicInvocationBinding;
    },
  });
  assert.equal((await f.request()).statusCode, 409);
  assert.equal(f.entered(), 0);
});
test('public callback rejects binding substitution during awaited thread lookup', async (t) => {
  const f = await fixture(t, {
    onThread: async ({ record }) => {
      record.publicInvocationBinding = { ...publicBinding(), entryId: 'substituted' };
    },
  });
  assert.equal((await f.request()).statusCode, 409);
  assert.equal(f.entered(), 0);
});
test('public callback refuses malformed persistent marker instead of treating it as absent', async (t) => {
  const f = await fixture(t);
  f.record.publicInvocationBinding = {};
  assert.equal((await f.request()).statusCode, 409);
  assert.equal(f.entered(), 0);
});
test('public callback withholds result after package revokes authority', async (t) => {
  const f = await fixture(t, { handler: async (state) => state.revoke() });
  const response = await f.request();
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.includes('private-result'), false);
  assert.equal(f.entered(), 1);
});
test('public callback failed currentness cannot be swallowed and restored by action', async (t) => {
  const f = await fixture(t, {
    handler: async (state, context) => {
      state.revoke();
      try {
        await context.assertCurrent();
      } catch {
        /* package attempts to hide revocation */
      }
      state.restore();
    },
  });
  assert.equal((await f.request()).statusCode, 409);
});
test('public callback refuses ordinary-to-public identity drift during thread lookup', async (t) => {
  const f = await fixture(t, {
    ordinary: true,
    onThread: async ({ record }) => {
      record.publicInvocationBinding = publicBinding();
    },
  });
  assert.equal((await f.request()).statusCode, 409);
  assert.equal(f.entered(), 0);
});
test('public callback finished package context stays expired', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request()).statusCode, 200);
  await assert.rejects(() => f.context().assertCurrent());
});
test('public callback preserves ordinary native behavior without public verifier', async (t) => {
  const f = await fixture(t, { ordinary: true, missingVerifier: true });
  assert.equal((await f.request()).statusCode, 200);
  assert.equal(f.entered(), 1);
  assert.equal(f.checks(), 0);
});

test('public callback rejects binding drift across the verifier await', async (t) => {
  const f = await fixture(t, {
    onVerify: async ({ record }) => {
      delete record.publicInvocationBinding;
    },
  });
  assert.equal((await f.request()).statusCode, 409);
  assert.equal(f.entered(), 0);
});
test('public callback invocation-only fence does not cross package verifier ABI', async (t) => {
  const f = await fixture(t, {
    handler: async (state, context) => {
      const before = state.checks();
      await context.assertInvocationCurrent();
      assert.equal(state.checks(), before);
    },
  });
  assert.equal((await f.request()).statusCode, 200);
});
test('public callback latches a failed invocation-only fence despite identity restoration', async (t) => {
  const f = await fixture(t, {
    handler: async (state, context) => {
      const binding = state.record.publicInvocationBinding;
      delete state.record.publicInvocationBinding;
      await assert.rejects(() => context.assertInvocationCurrent());
      state.record.publicInvocationBinding = binding;
    },
  });
  assert.equal((await f.request()).statusCode, 409);
});
test('public callback verifier context expires with successful response', async (t) => {
  let verifierContext;
  const f = await fixture(t, {
    onVerify: async (_state, context) => {
      verifierContext = context;
    },
  });
  assert.equal((await f.request()).statusCode, 200);
  assert.equal(verifierContext.signal.aborted, true);
  await assert.rejects(() => verifierContext.assertCurrent());
});
test('public callback revalidates policy and owner scope before invoking package', async (t) => {
  const f = await fixture(t, {
    onThread: async ({ record }) => {
      record.ownerAuthProvenance = 'owner';
    },
  });
  assert.equal((await f.request()).statusCode, 409);
  assert.equal(f.entered(), 0);
});
