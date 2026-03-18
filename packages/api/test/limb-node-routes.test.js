import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { LimbPairingStore } from '../dist/domains/limb/LimbPairingStore.js';
import { LimbRegistry } from '../dist/domains/limb/LimbRegistry.js';
import { registerLimbNodeRoutes } from '../dist/routes/limb-node-routes.js';

const REG_BODY = {
  nodeId: 'iphone-1',
  displayName: 'iPhone 15 Pro',
  platform: 'ios',
  endpointUrl: 'http://192.168.1.50:9090',
  capabilities: [{ cap: 'camera', commands: ['camera.snap'], authLevel: 'leased' }],
};

describe('limb-node-routes (Fastify injection)', () => {
  let app;
  let limbRegistry;
  let pairingStore;

  beforeEach(async () => {
    app = Fastify();
    limbRegistry = new LimbRegistry();
    pairingStore = new LimbPairingStore();
    registerLimbNodeRoutes(app, { limbRegistry, pairingStore });
    await app.ready();
  });

  // ── Registration ──

  it('POST /api/limb/register creates pending pairing request', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/limb/register', payload: REG_BODY });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.ok(body.requestId);
    assert.ok(body.apiKey);
    assert.equal(body.status, 'pending');
    // Node should NOT be in registry yet (not approved)
    assert.equal(limbRegistry.getNode('iphone-1'), undefined);
  });

  it('POST /api/limb/register is idempotent for pending', async () => {
    const r1 = await app.inject({ method: 'POST', url: '/api/limb/register', payload: REG_BODY });
    const r2 = await app.inject({ method: 'POST', url: '/api/limb/register', payload: REG_BODY });
    assert.equal(JSON.parse(r1.payload).requestId, JSON.parse(r2.payload).requestId);
  });

  it('POST /api/limb/register rejects invalid payload', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/limb/register', payload: {} });
    assert.equal(res.statusCode, 400);
  });

  // ── No public approval routes (P1-1 security fix) ──

  it('public approve route does not exist', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/limb/pair/approve', payload: { requestId: 'x' } });
    assert.equal(res.statusCode, 404);
  });

  it('public reject route does not exist', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/limb/pair/reject', payload: { requestId: 'x' } });
    assert.equal(res.statusCode, 404);
  });

  it('public pending route does not exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/limb/pair/pending' });
    assert.equal(res.statusCode, 404);
  });

  // ── Heartbeat (requires approved apiKey) ──

  it('POST /api/limb/heartbeat with approved apiKey succeeds', async () => {
    // Register via API
    const regRes = await app.inject({ method: 'POST', url: '/api/limb/register', payload: REG_BODY });
    const { requestId, apiKey } = JSON.parse(regRes.payload);

    // Approve via store directly (simulating MCP callback auth path)
    pairingStore.approve(requestId);

    // Need node in registry for heartbeat to have effect — re-register triggers reconnect
    await app.inject({ method: 'POST', url: '/api/limb/register', payload: { ...REG_BODY, apiKey } });

    const res = await app.inject({
      method: 'POST',
      url: '/api/limb/heartbeat',
      payload: { apiKey, nodeId: 'iphone-1' },
    });
    assert.equal(res.statusCode, 200);
  });

  it('POST /api/limb/heartbeat with unknown apiKey rejects 403', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/limb/heartbeat',
      payload: { apiKey: 'bad-key', nodeId: 'iphone-1' },
    });
    assert.equal(res.statusCode, 403);
  });

  // ── Deregister ──

  it('POST /api/limb/deregister removes node from registry', async () => {
    // Register + approve via store + re-register to trigger reconnect
    const regRes = await app.inject({ method: 'POST', url: '/api/limb/register', payload: REG_BODY });
    const { requestId, apiKey } = JSON.parse(regRes.payload);
    pairingStore.approve(requestId);
    await app.inject({ method: 'POST', url: '/api/limb/register', payload: { ...REG_BODY, apiKey } });
    assert.ok(limbRegistry.getNode('iphone-1'));

    const res = await app.inject({
      method: 'POST',
      url: '/api/limb/deregister',
      payload: { apiKey, nodeId: 'iphone-1' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(limbRegistry.getNode('iphone-1'), undefined);
  });

  // ── Reconnect (P1-2: approved node re-register rebuilds RemoteLimbNode) ──

  it('approved node re-register after deregister rebuilds RemoteLimbNode', async () => {
    const regRes = await app.inject({ method: 'POST', url: '/api/limb/register', payload: REG_BODY });
    const { requestId, apiKey } = JSON.parse(regRes.payload);
    pairingStore.approve(requestId);

    await app.inject({ method: 'POST', url: '/api/limb/register', payload: { ...REG_BODY, apiKey } });
    assert.ok(limbRegistry.getNode('iphone-1'));

    await app.inject({ method: 'POST', url: '/api/limb/deregister', payload: { apiKey, nodeId: 'iphone-1' } });
    assert.equal(limbRegistry.getNode('iphone-1'), undefined);

    const reconnectRes = await app.inject({
      method: 'POST',
      url: '/api/limb/register',
      payload: { ...REG_BODY, apiKey },
    });
    assert.equal(JSON.parse(reconnectRes.payload).status, 'approved');
    assert.ok(limbRegistry.getNode('iphone-1'));
  });

  it('reconnect with new endpointUrl updates pairing', async () => {
    const regRes = await app.inject({ method: 'POST', url: '/api/limb/register', payload: REG_BODY });
    const { requestId, apiKey } = JSON.parse(regRes.payload);
    pairingStore.approve(requestId);
    await app.inject({ method: 'POST', url: '/api/limb/register', payload: { ...REG_BODY, apiKey } });

    await app.inject({ method: 'POST', url: '/api/limb/deregister', payload: { apiKey, nodeId: 'iphone-1' } });

    const newBody = { ...REG_BODY, endpointUrl: 'http://10.0.0.99:9090', apiKey };
    await app.inject({ method: 'POST', url: '/api/limb/register', payload: newBody });

    const pairing = pairingStore.findByApiKey(apiKey);
    assert.equal(pairing.endpointUrl, 'http://10.0.0.99:9090');
  });

  it('offline node in registry re-registers with new endpoint → handle replaced', async () => {
    const regRes = await app.inject({ method: 'POST', url: '/api/limb/register', payload: REG_BODY });
    const { requestId, apiKey } = JSON.parse(regRes.payload);
    pairingStore.approve(requestId);
    await app.inject({ method: 'POST', url: '/api/limb/register', payload: { ...REG_BODY, apiKey } });

    assert.equal(limbRegistry.getNode('iphone-1').status, 'online');
    limbRegistry.updateStatus('iphone-1', 'offline');
    assert.equal(limbRegistry.getNode('iphone-1').status, 'offline');

    const newBody = { ...REG_BODY, endpointUrl: 'http://10.0.0.99:9090', apiKey };
    await app.inject({ method: 'POST', url: '/api/limb/register', payload: newBody });

    const node = limbRegistry.getNode('iphone-1');
    assert.ok(node);
    assert.equal(node.status, 'online');
    const handle = limbRegistry.getNodeHandle('iphone-1');
    assert.ok(handle);
  });

  it('reconnect without apiKey is rejected for approved nodes', async () => {
    const regRes = await app.inject({ method: 'POST', url: '/api/limb/register', payload: REG_BODY });
    const { requestId } = JSON.parse(regRes.payload);
    pairingStore.approve(requestId);

    // Try reconnect without apiKey
    const res = await app.inject({ method: 'POST', url: '/api/limb/register', payload: REG_BODY });
    assert.equal(res.statusCode, 403);
  });

  it('reconnect with wrong apiKey is rejected', async () => {
    const regRes = await app.inject({ method: 'POST', url: '/api/limb/register', payload: REG_BODY });
    const { requestId } = JSON.parse(regRes.payload);
    pairingStore.approve(requestId);

    const res = await app.inject({
      method: 'POST',
      url: '/api/limb/register',
      payload: { ...REG_BODY, apiKey: 'wrong-key' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('unapproved node cannot self-approve via any public route', async () => {
    // Register creates pending request
    const regRes = await app.inject({ method: 'POST', url: '/api/limb/register', payload: REG_BODY });
    const body = JSON.parse(regRes.payload);
    assert.equal(body.status, 'pending');

    // Node is NOT in registry
    assert.equal(limbRegistry.getNode('iphone-1'), undefined);

    // No public approve endpoint exists
    const approveRes = await app.inject({
      method: 'POST',
      url: '/api/limb/pair/approve',
      payload: { requestId: body.requestId },
    });
    assert.equal(approveRes.statusCode, 404);
  });
});
