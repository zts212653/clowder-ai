import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { registerBleRoutes } from '../dist/routes/ble-routes.js';

function managerStub() {
  return {
    status: () => ({
      platform: 'darwin',
      available: true,
      state: 'idle',
      reason: null,
      restartAttempts: 0,
      bindingCount: 0,
    }),
    listBindings: async () => [],
    scanSnapshot: () => ({
      active: false,
      sessionId: null,
      startedAt: null,
      expiresAt: null,
      discoveries: [],
    }),
    startScan: async () => ({ sessionId: 'scan-1', startedAt: 100, expiresAt: 30_100 }),
    stopScan: async () => {},
    bind: async () => ({
      bindingId: 'binding-1',
      displayName: 'Sensor',
      adapterId: 'standard.environmental',
      commands: ['ble.temperature.read'],
      nodeId: 'ble:binding-1',
      createdAt: 100,
      lastConnectedAt: 100,
    }),
    probeBinding: async (bindingId) =>
      bindingId === 'binding-1' ? { bindingId, state: 'reachable', checkedAt: 200 } : null,
    rebindBinding: async (bindingId) =>
      bindingId === 'binding-1'
        ? {
            bindingId,
            displayName: 'Sensor',
            adapterId: 'standard.environmental',
            commands: ['ble.temperature.read'],
            nodeId: 'ble:binding-1',
            createdAt: 100,
            lastConnectedAt: 200,
          }
        : null,
    unbind: async (bindingId) => bindingId === 'binding-1',
  };
}

async function createApp({ manager = managerStub(), authenticated = true } = {}) {
  const app = Fastify();
  if (authenticated) {
    app.addHook('onRequest', async (request) => {
      request.sessionUserId = 'owner';
    });
  }
  registerBleRoutes(app, { manager, platform: 'darwin' });
  await app.ready();
  return app;
}

describe('BLE operator routes', () => {
  it('requires a session identity for BLE status', async () => {
    const app = await createApp({ authenticated: false });
    const response = await app.inject({ method: 'GET', url: '/api/limb/ble/status' });
    assert.equal(response.statusCode, 401);
    const probe = await app.inject({ method: 'POST', url: '/api/limb/ble/bindings/binding-1/probe' });
    assert.equal(probe.statusCode, 401);
    const rebind = await app.inject({
      method: 'POST',
      url: '/api/limb/ble/bindings/binding-1/rebind',
      payload: { sessionId: 'scan-1', discoveryId: 'discovery-1' },
    });
    assert.equal(rebind.statusCode, 401);
  });

  it('returns status and never exposes a platform device ID', async () => {
    const app = await createApp();
    const status = await app.inject({ method: 'GET', url: '/api/limb/ble/status' });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().state, 'idle');

    const bindings = await app.inject({ method: 'GET', url: '/api/limb/ble/bindings' });
    assert.equal(bindings.statusCode, 200);
    assert.equal(bindings.payload.includes('platformDeviceId'), false);
  });

  it('starts and stops an explicit scan session', async () => {
    const app = await createApp();
    const started = await app.inject({ method: 'POST', url: '/api/limb/ble/scan', payload: {} });
    assert.equal(started.statusCode, 201);
    assert.equal(started.json().sessionId, 'scan-1');

    const stopped = await app.inject({ method: 'DELETE', url: '/api/limb/ble/scan' });
    assert.equal(stopped.statusCode, 204);
  });

  it('validates opaque bind input and supports explicit unbind', async () => {
    const app = await createApp();
    const invalid = await app.inject({ method: 'POST', url: '/api/limb/ble/bindings', payload: {} });
    assert.equal(invalid.statusCode, 400);

    const bound = await app.inject({
      method: 'POST',
      url: '/api/limb/ble/bindings',
      payload: { sessionId: 'scan-1', discoveryId: 'discovery-1' },
    });
    assert.equal(bound.statusCode, 201);
    assert.equal(bound.payload.includes('platformDeviceId'), false);

    const removed = await app.inject({ method: 'DELETE', url: '/api/limb/ble/bindings/binding-1' });
    assert.equal(removed.statusCode, 204);
    const missing = await app.inject({ method: 'DELETE', url: '/api/limb/ble/bindings/missing' });
    assert.equal(missing.statusCode, 404);
  });

  it('probes and explicitly rebinds without exposing a platform device ID', async () => {
    const app = await createApp();
    const probe = await app.inject({ method: 'POST', url: '/api/limb/ble/bindings/binding-1/probe' });
    assert.equal(probe.statusCode, 200);
    assert.equal(probe.json().state, 'reachable');
    assert.equal(probe.payload.includes('platformDeviceId'), false);

    const rebound = await app.inject({
      method: 'POST',
      url: '/api/limb/ble/bindings/binding-1/rebind',
      payload: { sessionId: 'scan-1', discoveryId: 'discovery-1' },
    });
    assert.equal(rebound.statusCode, 200);
    assert.equal(rebound.json().nodeId, 'ble:binding-1');
    assert.equal(rebound.payload.includes('platformDeviceId'), false);

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/limb/ble/bindings/binding-1/rebind',
      payload: { sessionId: 'scan-1', discoveryId: 'discovery-1', deviceId: 'private' },
    });
    assert.equal(invalid.statusCode, 400);
    const missing = await app.inject({ method: 'POST', url: '/api/limb/ble/bindings/missing/probe' });
    assert.equal(missing.statusCode, 404);
  });

  it('fails closed for mutating routes when persistent storage is unavailable', async () => {
    const app = await createApp({ manager: null });
    const status = await app.inject({ method: 'GET', url: '/api/limb/ble/status' });
    assert.equal(status.statusCode, 200);
    assert.equal(status.json().available, false);
    assert.match(status.json().reason, /Redis/);

    const scan = await app.inject({ method: 'POST', url: '/api/limb/ble/scan', payload: {} });
    assert.equal(scan.statusCode, 503);
  });

  it('maps an active-scan conflict without crashing the API', async () => {
    const manager = managerStub();
    manager.startScan = async () => {
      throw new Error('A BLE scan session is already active');
    };
    const app = await createApp({ manager });
    const response = await app.inject({ method: 'POST', url: '/api/limb/ble/scan', payload: {} });
    assert.equal(response.statusCode, 409);
    assert.match(response.json().error, /already active/);
  });

  it('maps an incompatible explicit rebind to an actionable client error', async () => {
    const manager = managerStub();
    manager.rebindBinding = async () => {
      throw new Error('BLE rebind target is not compatible with the existing binding');
    };
    const app = await createApp({ manager });
    const response = await app.inject({
      method: 'POST',
      url: '/api/limb/ble/bindings/binding-1/rebind',
      payload: { sessionId: 'scan-1', discoveryId: 'discovery-1' },
    });
    assert.equal(response.statusCode, 422);
    assert.match(response.json().error, /not compatible/);
  });
});
