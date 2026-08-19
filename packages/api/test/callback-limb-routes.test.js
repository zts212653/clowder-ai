import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MemoryLimbEmbodimentBindingStore } from '../dist/domains/limb/LimbEmbodimentBindingStore.js';
import { LimbPairingStore } from '../dist/domains/limb/LimbPairingStore.js';
import { LimbRegistry } from '../dist/domains/limb/LimbRegistry.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { registerCallbackLimbRoutes } from '../dist/routes/callback-limb-routes.js';

function mockNode(overrides = {}) {
  return {
    nodeId: 'iphone-1',
    displayName: 'iPhone 15 Pro',
    platform: 'ios',
    capabilities: [{ cap: 'camera', commands: ['camera.snap'], authLevel: 'leased' }],
    register: async () => {},
    invoke: async (cmd, params) => ({ success: true, data: { cmd, params } }),
    healthCheck: async () => 'online',
    deregister: async () => {},
    ...overrides,
  };
}

describe('callback-limb-routes (Fastify injection)', () => {
  let app;
  let limbRegistry;
  let invocationRegistry;
  let pairingStore;
  let bindingStore;
  let invocationRecordStore;
  let messageStore;
  let durableInvocationRecord;
  let triggerMessage;
  let validInvocationId;
  let validToken;

  beforeEach(async () => {
    app = Fastify();
    limbRegistry = new LimbRegistry();
    pairingStore = new LimbPairingStore();
    bindingStore = new MemoryLimbEmbodimentBindingStore();
    invocationRegistry = new InvocationRegistry();
    durableInvocationRecord = {
      id: 'parent-inv-1',
      threadId: 'thread-1',
      userId: 'user-1',
      userMessageId: 'msg-1',
    };
    triggerMessage = {
      id: 'msg-1',
      threadId: 'thread-1',
      userId: 'user-1',
      catId: null,
      content: 'Please read the WeChat conversation',
    };
    invocationRecordStore = {
      get: async (id) => (id === durableInvocationRecord?.id ? durableInvocationRecord : null),
    };
    messageStore = {
      getById: async (id) => (id === triggerMessage?.id ? triggerMessage : null),
    };

    // Create a real invocation so verify() returns a record
    const creds = await invocationRegistry.create('user-1', 'opus', 'thread-1', 'parent-inv-1');
    validInvocationId = creds.invocationId;
    validToken = creds.callbackToken;

    registerCallbackAuthHook(app, invocationRegistry);
    registerCallbackLimbRoutes(app, {
      limbRegistry,
      pairingStore,
      bindingStore,
      invocationRecordStore,
      messageStore,
    });

    await app.ready();
  });

  it('POST /api/callback/limb/list returns 200 with empty nodes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/list',
      headers: { 'x-invocation-id': validInvocationId, 'x-callback-token': validToken },
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.deepEqual(body.nodes, []);
  });

  it('POST /api/callback/limb/list returns registered nodes', async () => {
    await limbRegistry.register(mockNode());

    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/list',
      headers: { 'x-invocation-id': validInvocationId, 'x-callback-token': validToken },
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.nodes.length, 1);
    assert.equal(body.nodes[0].nodeId, 'iphone-1');
  });

  it('POST /api/callback/limb/list does NOT include commandSchemas (discovery only)', async () => {
    const schemas = {
      'camera.snap': {
        description: 'Take a photo',
        params: { resolution: { type: 'string', required: false, desc: 'Photo resolution' } },
      },
    };
    await limbRegistry.register(mockNode({ commandSchemas: schemas }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/list',
      headers: { 'x-invocation-id': validInvocationId, 'x-callback-token': validToken },
      payload: {},
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.nodes[0].commandSchemas, undefined, 'commandSchemas should not be in list response');
    assert.equal(body.nodes[0].nodeId, 'iphone-1');
  });

  // ── list-tools tests ──────────────────────────────────────────

  it('POST /api/callback/limb/list-tools returns all schemas for a node', async () => {
    const schemas = {
      'camera.snap': {
        description: 'Take a photo',
        params: { resolution: { type: 'string', required: false, desc: 'Photo resolution' } },
      },
      'camera.record': {
        description: 'Record video',
        params: { duration: { type: 'number', required: true, desc: 'Duration in seconds' } },
      },
    };
    await limbRegistry.register(mockNode({ commandSchemas: schemas }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/list-tools',
      headers: { 'x-invocation-id': validInvocationId, 'x-callback-token': validToken },
      payload: { nodeId: 'iphone-1' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.nodeId, 'iphone-1');
    assert.deepEqual(body.tools, schemas);
  });

  it('POST /api/callback/limb/list-tools filters by command name', async () => {
    const schemas = {
      'camera.snap': {
        description: 'Take a photo',
        params: { resolution: { type: 'string', required: false, desc: 'Photo resolution' } },
      },
      'camera.record': {
        description: 'Record video',
        params: { duration: { type: 'number', required: true, desc: 'Duration in seconds' } },
      },
    };
    await limbRegistry.register(mockNode({ commandSchemas: schemas }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/list-tools',
      headers: { 'x-invocation-id': validInvocationId, 'x-callback-token': validToken },
      payload: { nodeId: 'iphone-1', command: 'camera.snap' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.deepEqual(Object.keys(body.tools), ['camera.snap']);
    assert.equal(body.tools['camera.snap'].description, 'Take a photo');
  });

  it('POST /api/callback/limb/list-tools returns empty for unknown node', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/list-tools',
      headers: { 'x-invocation-id': validInvocationId, 'x-callback-token': validToken },
      payload: { nodeId: 'nonexistent' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.deepEqual(body.tools, {});
    assert.ok(body.error.includes('Unknown node'));
  });

  it('POST /api/callback/limb/list-tools returns empty for unknown command', async () => {
    const schemas = {
      'camera.snap': { description: 'Take a photo', params: {} },
    };
    await limbRegistry.register(mockNode({ commandSchemas: schemas }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/list-tools',
      headers: { 'x-invocation-id': validInvocationId, 'x-callback-token': validToken },
      payload: { nodeId: 'iphone-1', command: 'nonexistent.cmd' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.deepEqual(body.tools, {});
  });

  it('POST /api/callback/limb/list-tools returns empty when node has no schemas', async () => {
    await limbRegistry.register(mockNode());

    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/list-tools',
      headers: { 'x-invocation-id': validInvocationId, 'x-callback-token': validToken },
      payload: { nodeId: 'iphone-1' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.deepEqual(body.tools, {});
    assert.equal(body.nodeId, 'iphone-1');
  });

  it('POST /api/callback/limb/list-tools returns 401 with bad credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/list-tools',
      headers: { 'x-invocation-id': 'bad', 'x-callback-token': 'bad' },
      payload: { nodeId: 'iphone-1' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('POST /api/callback/limb/list-tools returns 400 for missing nodeId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/list-tools',
      headers: { 'x-invocation-id': validInvocationId, 'x-callback-token': validToken },
      payload: {},
    });
    assert.equal(res.statusCode, 400);
  });

  // ── list filter tests ──────────────────────────────────────────

  it('POST /api/callback/limb/list filters by capability', async () => {
    await limbRegistry.register(mockNode());
    await limbRegistry.register(
      mockNode({
        nodeId: 'server-1',
        displayName: 'GPU Server',
        capabilities: [{ cap: 'gpu_render', commands: ['render.run'], authLevel: 'free' }],
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/list',
      headers: { 'x-invocation-id': validInvocationId, 'x-callback-token': validToken },
      payload: { capability: 'camera' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.nodes.length, 1);
    assert.equal(body.nodes[0].nodeId, 'iphone-1');
  });

  it('POST /api/callback/limb/list returns 401 with bad credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/list',
      headers: { 'x-invocation-id': 'bad', 'x-callback-token': 'bad' },
      payload: {},
    });
    assert.equal(res.statusCode, 401);
  });

  it('POST /api/callback/limb/invoke calls node and returns result', async () => {
    await limbRegistry.register(mockNode());

    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/invoke',
      headers: { 'x-invocation-id': validInvocationId, 'x-callback-token': validToken },
      payload: {
        nodeId: 'iphone-1',
        command: 'camera.snap',
        params: { quality: 'high' },
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.success, true);
    assert.deepEqual(body.data, { cmd: 'camera.snap', params: { quality: 'high' } });
  });

  it('passes only server-verified owner-message provenance to the local node', async () => {
    let receivedContext;
    await limbRegistry.register(
      mockNode({
        invoke: async (cmd, params, context) => {
          receivedContext = context;
          return { success: true, data: { cmd, params } };
        },
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/invoke',
      headers: { 'x-invocation-id': validInvocationId, 'x-callback-token': validToken },
      payload: {
        nodeId: 'iphone-1',
        command: 'camera.snap',
        params: { quality: 'high' },
        userId: 'spoofed-user',
        threadId: 'spoofed-thread',
        userMessageId: 'spoofed-message',
      },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(receivedContext, {
      catId: 'opus',
      invocationId: validInvocationId,
      userId: 'user-1',
      threadId: 'thread-1',
      userMessageId: 'msg-1',
    });
  });

  it('withholds userMessageId when the durable origin is missing or not an owner message', async () => {
    const receivedContexts = [];
    await limbRegistry.register(
      mockNode({
        invoke: async (_cmd, _params, context) => {
          receivedContexts.push(context);
          return { success: true };
        },
      }),
    );

    const invoke = (invocationId = validInvocationId, token = validToken) =>
      app.inject({
        method: 'POST',
        url: '/api/callback/limb/invoke',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': token },
        payload: { nodeId: 'iphone-1', command: 'camera.snap', params: {} },
      });

    triggerMessage = null;
    await invoke();

    triggerMessage = {
      id: 'msg-1',
      threadId: 'different-thread',
      userId: 'user-1',
      catId: null,
      content: 'wrong thread',
    };
    await invoke();

    triggerMessage = {
      id: 'msg-1',
      threadId: 'thread-1',
      userId: 'scheduler',
      catId: null,
      content: 'scheduled wake',
    };
    await invoke();

    triggerMessage = {
      id: 'msg-1',
      threadId: 'thread-1',
      userId: 'user-1',
      catId: null,
      content: 'looks like an owner message but invocation is A2A',
    };
    const a2aCreds = await invocationRegistry.create(
      'user-1',
      'opus',
      'thread-1',
      'parent-inv-1',
      'a2a-trigger-message',
    );
    await invoke(a2aCreds.invocationId, a2aCreds.callbackToken);

    assert.equal(receivedContexts.length, 4);
    for (const context of receivedContexts) {
      assert.equal(context.userId, 'user-1');
      assert.equal(context.threadId, 'thread-1');
      assert.equal(context.catId, 'opus');
      assert.equal(context.userMessageId, undefined);
    }
  });

  it('POST /api/callback/limb/invoke returns error for unknown node', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/invoke',
      headers: { 'x-invocation-id': validInvocationId, 'x-callback-token': validToken },
      payload: {
        nodeId: 'nonexistent',
        command: 'test',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.success, false);
    assert.ok(body.error.includes('Unknown node'));
  });

  it('POST /api/callback/limb/invoke returns 401 with bad credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/invoke',
      headers: { 'x-invocation-id': 'bad', 'x-callback-token': 'bad' },
      payload: { nodeId: 'x', command: 'y' },
    });
    assert.equal(res.statusCode, 401);
  });

  it('POST /api/callback/limb/invoke returns 400 for missing required fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/invoke',
      headers: { 'x-invocation-id': validInvocationId, 'x-callback-token': validToken },
    });
    assert.equal(res.statusCode, 400);
  });

  it('never exposes a pending limb API key through the pairing list callback', async () => {
    const pairing = pairingStore.createRequest({
      nodeId: 'stackchan-yanyan-01',
      displayName: '砚砚的小身体',
      platform: 'stackchan',
      endpointUrl: 'http://127.0.0.1:8770',
      capabilities: [{ cap: 'limb.observe.touch', commands: [], authLevel: 'free' }],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/pair/list',
      headers: { 'x-invocation-id': validInvocationId, 'x-callback-token': validToken },
      payload: {},
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.requests.length, 1);
    assert.equal(body.requests[0].requestId, pairing.requestId);
    assert.equal(body.requests[0].nodeId, pairing.nodeId);
    assert.equal(body.requests[0].apiKey, undefined);
    assert.ok(!res.payload.includes(pairing.apiKey), 'pairing secret must not enter callback output');
  });

  it('returns 403 only for a real pairing owner conflict', async () => {
    const pairing = pairingStore.createRequest({
      nodeId: 'stackchan-yanyan-01',
      displayName: '砚砚的小身体',
      platform: 'stackchan',
      endpointUrl: 'http://127.0.0.1:8770',
      capabilities: [{ cap: 'limb.observe.touch', commands: [], authLevel: 'free' }],
    });
    await pairingStore.approve(pairing.requestId, 'user-2');

    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/pair/approve',
      headers: { 'x-invocation-id': validInvocationId, 'x-callback-token': validToken },
      payload: { requestId: pairing.requestId },
    });

    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.payload).error, /another user/i);
  });

  it('does not disguise a durable pairing outage as an owner conflict', async () => {
    pairingStore.approve = async () => {
      throw new Error('redis unavailable');
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/pair/approve',
      headers: { 'x-invocation-id': validInvocationId, 'x-callback-token': validToken },
      payload: { requestId: 'request-1' },
    });

    assert.equal(res.statusCode, 500);
    assert.doesNotMatch(res.payload, /another user/i);
  });

  it('binds an approved body to the server-verified current user, thread, and cat', async () => {
    const pairing = pairingStore.createRequest({
      nodeId: 'iphone-1',
      displayName: 'iPhone 15 Pro',
      platform: 'ios',
      endpointUrl: 'http://127.0.0.1:9090',
      capabilities: [{ cap: 'camera', commands: ['camera.snap'], authLevel: 'leased' }],
    });
    await pairingStore.approve(pairing.requestId, 'user-1');
    await limbRegistry.register(mockNode());

    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/embodiment/bind',
      headers: { 'x-invocation-id': validInvocationId, 'x-callback-token': validToken },
      payload: {
        nodeId: 'iphone-1',
        expressionRef: 'yanyan:happy',
        voiceProfileRef: 'yanyan:zh-cn',
        volumePercent: 55,
      },
    });

    assert.equal(res.statusCode, 200);
    const binding = await bindingStore.get('iphone-1');
    assert.deepEqual(binding && { ...binding, updatedAt: undefined }, {
      nodeId: 'iphone-1',
      userId: 'user-1',
      threadId: 'thread-1',
      catId: 'opus',
      expressionRef: 'yanyan:happy',
      voiceProfileRef: 'yanyan:zh-cn',
      volumePercent: 55,
      updatedAt: undefined,
    });
    assert.ok(binding.updatedAt > 0);
  });

  it('refuses embodiment binding from A2A or a user who did not approve the body', async () => {
    const a2aCreds = await invocationRegistry.create(
      'user-1',
      'opus',
      'thread-1',
      'parent-inv-1',
      'a2a-trigger-message',
    );
    const payload = {
      nodeId: 'iphone-1',
      expressionRef: 'yanyan:happy',
      voiceProfileRef: 'yanyan:zh-cn',
      volumePercent: 55,
    };
    const pairing = pairingStore.createRequest({
      nodeId: 'iphone-1',
      displayName: 'iPhone 15 Pro',
      platform: 'ios',
      endpointUrl: 'http://127.0.0.1:9090',
      capabilities: [{ cap: 'camera', commands: ['camera.snap'], authLevel: 'leased' }],
    });
    await pairingStore.approve(pairing.requestId, 'user-2');
    await limbRegistry.register(mockNode());

    const wrongOwner = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/embodiment/bind',
      headers: { 'x-invocation-id': validInvocationId, 'x-callback-token': validToken },
      payload,
    });
    assert.equal(wrongOwner.statusCode, 403);

    const a2a = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/embodiment/bind',
      headers: {
        'x-invocation-id': a2aCreds.invocationId,
        'x-callback-token': a2aCreds.callbackToken,
      },
      payload,
    });
    assert.equal(a2a.statusCode, 403);
    assert.equal(await bindingStore.get('iphone-1'), undefined);
  });
});
