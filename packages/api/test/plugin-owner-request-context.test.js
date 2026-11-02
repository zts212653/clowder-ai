import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import * as contexts from '../dist/domains/plugin/carrier/plugin-call-context.js';
import { DeclaredRuntimeContributions } from '../dist/domains/plugin/declared/declared-runtime-contributions.js';
import { pluginWebhookForwardingRoutes } from '../dist/routes/plugin/plugin-webhook-forwarding-routes.js';

const owner = process.env.DEFAULT_OWNER_USER_ID?.trim() || 'owner';

async function fixture(t, handler, { anonymous = false, timeoutMs = 1000, fastifyOptions = {} } = {}) {
  const webhooks = new DeclaredRuntimeContributions({
    packages: {
      resolveInstalledPackage: async () => {
        throw Error('unexpected package IO');
      },
    },
    configuration: { readConfig: async () => {}, readSecret: async () => {} },
  });
  await webhooks.activate(
    {
      instance: { pluginInstanceId: 'instance' },
      packageRecord: {
        pluginId: 'dev.clowder.owner-context',
        manifest: {
          contributions: [
            {
              type: 'webhook',
              id: 'owner',
              path: 'owner',
              methods: ['GET', 'POST'],
              action: { method: 'owner.call' },
              ...(anonymous ? { verificationSecretRef: 'secret' } : {}),
            },
          ],
        },
      },
    },
    handler,
  );
  const app = Fastify(fastifyOptions);
  t.after(() => app.close());
  app.decorateRequest('sessionUserId', undefined);
  // Test auth seam: unlike the body principal, only this authenticated session reaches the Host guard.
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = owner;
  });
  await app.register(pluginWebhookForwardingRoutes, { webhooks, timeoutMs });
  return {
    app,
    webhooks,
    request: (method = 'GET', payload) =>
      app.inject({
        method,
        headers: { origin: 'http://localhost:5173' },
        url: '/api/plugins/dev.clowder.owner-context/owner',
        ...(payload ? { payload } : {}),
      }),
  };
}
function current() {
  return contexts.currentPluginOwnerRequestContext?.('instance');
}
test('anonymous webhooks never acquire owner authority from a session or body principal', async (t) => {
  let seen;
  const f = await fixture(
    t,
    async () => {
      seen = current();
      return { status: 200, body: {} };
    },
    { anonymous: true },
  );
  assert.equal((await f.request('POST', { principal: { kind: 'owner', id: 'owner' } })).statusCode, 200);
  assert.equal(seen, undefined);
});
test('authenticated forwarding captures Host identity independently of plugin business data', async (t) => {
  let captured;
  const f = await fixture(t, async (_id, _method, input) => {
    captured = current();
    input.request.principal.id = 'forged';
    return { status: 200, body: {} };
  });
  assert.equal((await f.request('POST', { userId: 'forged', principal: { id: 'forged' } })).statusCode, 200);
  assert.ok(captured, 'Host owner request context missing');
  assert.equal(captured.userId, owner);
  assert.equal(captured.operation, 'write');
  assert.equal(Object.isFrozen(captured), true);
});
test('owner context is scoped to the exact activated instance and never supplies native identity', async (t) => {
  let captured, other, native;
  const f = await fixture(t, async () => {
    captured = current();
    other = contexts.currentPluginOwnerRequestContext?.('another-instance');
    native = contexts.currentPluginCallContext('instance');
    return { status: 200, body: {} };
  });
  assert.equal((await f.request()).statusCode, 200);
  assert.ok(captured, 'Host owner request context missing');
  assert.equal(captured.operation, 'read');
  assert.equal(other, undefined);
  assert.equal(native, undefined);
});
test('completed request expires a saved owner context and its cancellation signal', async (t) => {
  let captured;
  const f = await fixture(t, async () => {
    captured = current();
    return { status: 200, body: {} };
  });
  assert.equal((await f.request()).statusCode, 200);
  assert.ok(captured, 'Host owner request context missing');
  await assert.rejects(() => captured.assertCurrent(), /no longer current/);
  assert.equal(captured.signal.aborted, true);
  assert.equal(current(), undefined);
});
test('HTTP timeout expires authority while an unfinished plugin callback is still alive', async (t) => {
  let captured, finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const f = await fixture(
    t,
    async () => {
      captured = current();
      await pending;
      return { status: 200, body: {} };
    },
    { timeoutMs: 10 },
  );
  t.after(() => finish());
  assert.equal((await f.request()).statusCode, 504);
  assert.ok(captured, 'Host owner request context missing');
  await assert.rejects(() => captured.assertCurrent(), /no longer current/);
  assert.equal(captured.signal.aborted, true);
});
test('deactivating the contribution invalidates owner authority before callback completion', async (t) => {
  let captured, rejection;
  const f = await fixture(t, async () => {
    captured = current();
    f.webhooks.deactivate('instance');
    if (captured) {
      try {
        await captured.assertCurrent();
      } catch (error) {
        rejection = error;
      }
    }
    return { status: 200, body: {} };
  });
  assert.equal((await f.request()).statusCode, 200);
  assert.ok(captured, 'Host owner request context missing');
  assert.match(rejection?.message ?? '', /no longer current/);
});

test('direct dispatch cannot manufacture owner authority from a request principal', async (t) => {
  let seen;
  const f = await fixture(t, async () => {
    seen = current();
    return { status: 200, body: {} };
  });
  await f.webhooks.callPluginWebhook('dev.clowder.owner-context', 'owner', { principal: { kind: 'owner', id: owner } });
  assert.equal(seen, undefined);
});
test('nested direct dispatch cannot reuse an authenticated route seed', async (t) => {
  let first,
    nested,
    calls = 0;
  const f = await fixture(t, async () => {
    if (++calls === 1) {
      first = current();
      await f.webhooks.callPluginWebhook('dev.clowder.owner-context', 'owner', {
        principal: { kind: 'owner', id: owner },
      });
      assert.equal(current(), first);
    } else nested = current();
    return { status: 200, body: {} };
  });
  assert.equal((await f.request()).statusCode, 200);
  assert.ok(first);
  assert.equal(nested, undefined);
});
test('verifier isolation clears HTTP authority and its route seed, then restores the caller', async (t) => {
  let isolated, saved;
  const f = await fixture(t, async () => {
    saved = current();
    isolated = await contexts.withoutPluginCallContext(async () => current());
    assert.equal(current(), saved);
    return { status: 200, body: {} };
  });
  assert.equal((await f.request()).statusCode, 200);
  assert.ok(saved);
  assert.equal(isolated, undefined);
});
test('native invocation entry clears HTTP authority without disturbing the outer owner request', async (t) => {
  let outer, nativeOwner;
  const f = await fixture(t, async () => {
    outer = current();
    await contexts.withPluginCallContext(
      'instance',
      { catId: 'cat', userId: owner, threadId: 'thread', invocationId: 'inv', assertCurrent: async () => {} },
      async () => {
        nativeOwner = current();
        assert.equal(contexts.currentPluginCallContext('instance').invocationId, 'inv');
      },
    );
    assert.equal(current(), outer);
    return { status: 200, body: {} };
  });
  assert.equal((await f.request()).statusCode, 200);
  assert.ok(outer);
  assert.equal(nativeOwner, undefined);
});
test('disconnected HTTP request invalidates a still-running package handler', async (t) => {
  let request, captured, rejected;
  const f = await fixture(t, async () => {
    captured = current();
    request.raw.emit('aborted');
    try {
      await captured.assertCurrent();
    } catch (error) {
      rejected = error;
    }
    return { status: 200, body: {} };
  });
  f.app.addHook('onRequest', async (value) => {
    request = value;
  });
  await f.request();
  assert.ok(captured);
  assert.match(rejected?.message ?? '', /no longer current/);
  assert.equal(captured.signal.aborted, true);
});

const digest = (value) => createHash('sha256').update(value).digest('hex');

test('Host captures immutable request semantics before package mutation and binds the actual instance', async (t) => {
  const body = '{"requestId":"package-chosen","task":"one"}';
  let identity;
  const f = await fixture(t, async (_id, _method, input) => {
    identity = current().requestIdentity;
    input.request.body.requestId = 'other';
    input.request.body.task = 'other';
    input.request.path = 'different';
    input.request.query.mode = 'changed';
    input.request.rawBody.fill(0);
    return { status: 200, body: {} };
  });
  const response = await f.app.inject({
    method: 'POST',
    url: '/api/plugins/dev.clowder.owner-context/owner?mode=a%2Fb',
    headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' },
    payload: body,
  });
  assert.equal(response.statusCode, 200);
  assert.ok(identity, 'Host request identity missing');
  assert.equal(identity.kind, 'owner_http');
  assert.equal(identity.pluginId, 'dev.clowder.owner-context');
  assert.equal(identity.pluginInstanceId, 'instance');
  assert.equal(identity.userId, owner);
  assert.equal(identity.contributionId, 'owner');
  assert.equal(identity.method, 'POST');
  assert.equal(identity.declaredPath, 'owner');
  assert.equal(identity.path, 'owner');
  assert.equal(identity.bodyDigest, digest(body));
  assert.equal(identity.queryDigest, digest('mode=a%2Fb'));
  assert.notEqual(identity.requestId, 'package-chosen');
  assert.ok(Object.isFrozen(identity));
  assert.throws(() => {
    identity.requestId = 'forged';
  }, TypeError);
});

test('two Host requests cannot alias through a repeated transport id or body requestId', async (t) => {
  const captured = [];
  const f = await fixture(
    t,
    async () => {
      captured.push(current().requestIdentity);
      return { status: 200, body: {} };
    },
    { fastifyOptions: { genReqId: () => 'same-transport-id' } },
  );
  for (let i = 0; i < 2; i++)
    assert.equal((await f.request('POST', { requestId: 'same-business-id' })).statusCode, 200);
  assert.ok(captured.every(Boolean), 'Host request identities missing');
  assert.notEqual(captured[0].requestId, captured[1].requestId);
  assert.equal(captured[0].transportRequestId, 'same-transport-id');
  assert.equal(captured[1].transportRequestId, 'same-transport-id');
  assert.equal(captured[0].bodyDigest, captured[1].bodyDigest);
});

test('same call keeps one private identity across awaits without exposing it in package arguments', async (t) => {
  let before, after, leaked;
  const f = await fixture(t, async (_id, _method, input) => {
    before = current().requestIdentity;
    await Promise.resolve();
    after = current().requestIdentity;
    leaked = JSON.stringify(input).includes(before?.requestId ?? 'missing');
    return { status: 200, body: {} };
  });
  assert.equal((await f.request('POST', {})).statusCode, 200);
  assert.ok(before, 'Host request identity missing');
  assert.equal(after, before);
  assert.equal(leaked, false);
});

test('request descriptor distinguishes raw payload and query bytes and exact HTTP method', async (t) => {
  const captured = [];
  const f = await fixture(t, async () => {
    captured.push(current().requestIdentity);
    return { status: 200, body: {} };
  });
  for (const [method, query, body] of [
    ['POST', 'q=a', '{"a":1}'],
    ['POST', 'q=%61', '{ "a":1 }'],
    ['GET', 'q=a', undefined],
  ]) {
    assert.equal(
      (
        await f.app.inject({
          method,
          url: `/api/plugins/dev.clowder.owner-context/owner?${query}`,
          headers: { origin: 'http://localhost:5173', ...(body ? { 'content-type': 'application/json' } : {}) },
          ...(body ? { payload: body } : {}),
        })
      ).statusCode,
      200,
    );
  }
  assert.ok(captured.every(Boolean), 'Host request identities missing');
  assert.notEqual(captured[0].bodyDigest, captured[1].bodyDigest);
  assert.notEqual(captured[0].queryDigest, captured[1].queryDigest);
  assert.equal(captured[2].method, 'GET');
  assert.equal(captured[2].bodyDigest, digest(''));
});

test('actual owner HTTP module handler receives captured facts and the existing request lifetime', async (t) => {
  const { createModuleHostInvocation } = await import(
    '../dist/domains/plugin/builtin-runtime/carriers/module-host-invocation.js'
  );
  let seen, native;
  const actions = {
    'owner.call': async (input, invocation, context) => {
      native = invocation;
      seen = context;
      input.request.body.requestId = 'package-rewrite';
      if (context) await context.assertCurrent();
      return { status: 200, body: { ok: true } };
    },
  };
  const module = createModuleHostInvocation({ runtime: { actions: () => actions } });
  const f = await fixture(t, (id, method, params) => module.invoke(id, method, params));
  assert.equal((await f.request('POST', { requestId: 'package-value' })).statusCode, 200);
  assert.ok(seen, 'owner HTTP context is not projected to package');
  assert.equal(seen.kind, 'owner-http-request');
  assert.equal(seen.userId, owner);
  assert.equal(seen.pluginInstanceId, 'instance');
  assert.equal(seen.operation, 'write');
  assert.equal(seen.requestIdentity.method, 'POST');
  assert.equal(seen.requestIdentity.contributionId, 'owner');
  assert.notEqual(seen.requestIdentity.requestId, 'package-value');
  assert.notEqual(seen.requestIdentity.requestId, 'package-rewrite');
  assert.ok(Object.isFrozen(seen));
  assert.ok(Object.isFrozen(seen.requestIdentity));
  assert.equal(native, undefined);
  await assert.rejects(() => seen.assertCurrent(), /no longer current/);
});

test('HTTP read keeps its operation and untrusted dispatch cannot manufacture owner context', async (t) => {
  const { createModuleHostInvocation } = await import(
    '../dist/domains/plugin/builtin-runtime/carriers/module-host-invocation.js'
  );
  const seen = [];
  const actions = {
    'owner.call': async (_input, _native, context) => {
      seen.push(context);
      return { status: 200, body: {} };
    },
  };
  const module = createModuleHostInvocation({ runtime: { actions: () => actions } });
  const dispatch = (id, method, params) => module.invoke(id, method, params);
  const f = await fixture(t, dispatch);
  assert.equal((await f.request()).statusCode, 200);
  assert.equal(seen[0]?.operation, 'read');
  await f.webhooks.callPluginWebhook('dev.clowder.owner-context', 'owner', {
    principal: { kind: 'owner', id: owner },
    requestIdentity: seen[0]?.requestIdentity,
  });
  assert.equal(seen[1], undefined);
  const anonymous = await fixture(t, dispatch, { anonymous: true });
  assert.equal((await anonymous.request('POST', { principal: { kind: 'owner', id: owner } })).statusCode, 200);
  assert.equal(seen[2], undefined);
});
