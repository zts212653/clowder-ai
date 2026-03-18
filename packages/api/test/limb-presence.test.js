import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { LimbPresenceManager, mapProbeStateToLimbStatus } from '../dist/domains/limb/LimbPresenceManager.js';
import { LimbRegistry } from '../dist/domains/limb/LimbRegistry.js';

function mockNode(overrides = {}) {
  return {
    nodeId: 'iphone-1',
    displayName: 'iPhone 15 Pro',
    platform: 'ios',
    capabilities: [{ cap: 'camera', commands: ['camera.snap'], authLevel: 'leased' }],
    register: async () => {},
    invoke: async () => ({ success: true }),
    healthCheck: async () => 'online',
    deregister: async () => {},
    ...overrides,
  };
}

describe('LimbPresenceManager', () => {
  let registry;
  let presence;

  beforeEach(() => {
    registry = new LimbRegistry();
    presence = new LimbPresenceManager(registry, {
      timeoutMs: 50, // 50ms for fast tests
      checkIntervalMs: 10, // 10ms
    });
  });

  it('checkAll marks timed-out node as offline', async () => {
    await registry.register(mockNode());
    assert.equal(registry.getNode('iphone-1').status, 'online');

    // Wait longer than timeout
    await new Promise((r) => setTimeout(r, 60));

    presence.checkAll();
    assert.equal(registry.getNode('iphone-1').status, 'offline');
  });

  it('checkAll keeps node online if heartbeat is fresh', async () => {
    await registry.register(mockNode());

    // Record heartbeat within timeout
    await new Promise((r) => setTimeout(r, 20));
    registry.recordHeartbeat('iphone-1');

    presence.checkAll();
    assert.equal(registry.getNode('iphone-1').status, 'online');
  });

  it('checkAll skips already-offline nodes', async () => {
    await registry.register(mockNode());
    registry.updateStatus('iphone-1', 'offline');

    await new Promise((r) => setTimeout(r, 60));

    // Should not throw or change anything
    const changes = [];
    presence.onStatusChange((id, from, to) => changes.push({ id, from, to }));
    presence.checkAll();
    assert.equal(changes.length, 0);
  });

  it('offline node capabilities removed from available list', async () => {
    await registry.register(mockNode());
    assert.equal(registry.findByCapability('camera').length, 1);

    registry.updateStatus('iphone-1', 'offline');
    assert.equal(registry.findByCapability('camera').length, 0);
  });

  it('onStatusChange callback fires on transition', async () => {
    await registry.register(mockNode());

    const changes = [];
    presence.onStatusChange((nodeId, from, to) => {
      changes.push({ nodeId, from, to });
    });

    await new Promise((r) => setTimeout(r, 60));
    presence.checkAll();

    assert.equal(changes.length, 1);
    assert.equal(changes[0].nodeId, 'iphone-1');
    assert.equal(changes[0].from, 'online');
    assert.equal(changes[0].to, 'offline');
  });

  it('start/stop lifecycle', async () => {
    assert.equal(presence.running, false);

    presence.start();
    assert.equal(presence.running, true);

    // Starting again is idempotent
    presence.start();
    assert.equal(presence.running, true);

    presence.stop();
    assert.equal(presence.running, false);
  });

  it('start triggers periodic checks that mark timed-out nodes', async () => {
    await registry.register(mockNode());

    presence.start();

    // Wait for timeout + at least one check cycle
    await new Promise((r) => setTimeout(r, 80));

    presence.stop();

    assert.equal(registry.getNode('iphone-1').status, 'offline');
  });
});

describe('mapProbeStateToLimbStatus', () => {
  it('maps active → online', () => {
    assert.equal(mapProbeStateToLimbStatus('active'), 'online');
  });

  it('maps busy-silent → busy', () => {
    assert.equal(mapProbeStateToLimbStatus('busy-silent'), 'busy');
  });

  it('maps idle-silent → degraded', () => {
    assert.equal(mapProbeStateToLimbStatus('idle-silent'), 'degraded');
  });

  it('maps dead → offline', () => {
    assert.equal(mapProbeStateToLimbStatus('dead'), 'offline');
  });
});
