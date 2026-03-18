import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { LimbRegistry } from '../dist/domains/limb/LimbRegistry.js';
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
  let validInvocationId;
  let validToken;

  beforeEach(async () => {
    app = Fastify();
    limbRegistry = new LimbRegistry();
    invocationRegistry = new InvocationRegistry();

    // Create a real invocation so verify() returns a record
    const creds = invocationRegistry.create('user-1', 'opus', 'thread-1');
    validInvocationId = creds.invocationId;
    validToken = creds.callbackToken;

    registerCallbackLimbRoutes(app, {
      limbRegistry,
      invocationRegistry,
    });

    await app.ready();
  });

  it('POST /api/callback/limb/list returns 200 with empty nodes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/list',
      payload: { invocationId: validInvocationId, callbackToken: validToken },
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
      payload: { invocationId: validInvocationId, callbackToken: validToken },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.nodes.length, 1);
    assert.equal(body.nodes[0].nodeId, 'iphone-1');
  });

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
      payload: { invocationId: validInvocationId, callbackToken: validToken, capability: 'camera' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.nodes.length, 1);
    assert.equal(body.nodes[0].nodeId, 'iphone-1');
  });

  it('POST /api/callback/limb/list returns 403 with bad credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/list',
      payload: { invocationId: 'bad', callbackToken: 'bad' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('POST /api/callback/limb/invoke calls node and returns result', async () => {
    await limbRegistry.register(mockNode());

    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/invoke',
      payload: {
        invocationId: validInvocationId,
        callbackToken: validToken,
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

  it('POST /api/callback/limb/invoke returns error for unknown node', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/invoke',
      payload: {
        invocationId: validInvocationId,
        callbackToken: validToken,
        nodeId: 'nonexistent',
        command: 'test',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.success, false);
    assert.ok(body.error.includes('Unknown node'));
  });

  it('POST /api/callback/limb/invoke returns 403 with bad credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/invoke',
      payload: { invocationId: 'bad', callbackToken: 'bad', nodeId: 'x', command: 'y' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('POST /api/callback/limb/invoke returns 400 for missing required fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callback/limb/invoke',
      payload: { invocationId: validInvocationId, callbackToken: validToken },
    });
    assert.equal(res.statusCode, 400);
  });
});
