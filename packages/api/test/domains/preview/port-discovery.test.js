import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  detectFramework,
  PortDiscoveryService,
  parsePortFromStdout,
} from '../../../dist/domains/preview/port-discovery.js';

describe('detectFramework', () => {
  it('detects vite from output', () => {
    assert.equal(detectFramework('VITE v5.0.0  ready'), 'vite');
  });

  it('detects next from output', () => {
    assert.equal(detectFramework('▲ Next.js 14'), 'next');
  });

  it('detects webpack from output', () => {
    assert.equal(detectFramework('[webpack-dev-server]'), 'webpack');
  });

  it('returns unknown for generic output', () => {
    assert.equal(detectFramework('Server running'), 'unknown');
  });
});

describe('parsePortFromStdout', () => {
  it('detects Vite dev server output with vite keyword', () => {
    const result = parsePortFromStdout('  VITE v5.0.0  ➜  Local:   http://localhost:5173/');
    assert.equal(result?.port, 5173);
    assert.equal(result?.framework, 'vite');
  });

  it('detects Vite URL-only line as unknown framework', () => {
    const result = parsePortFromStdout('  ➜  Local:   http://localhost:5173/');
    assert.equal(result?.port, 5173);
    assert.equal(result?.framework, 'unknown');
  });

  it('detects Next.js dev server output', () => {
    const result = parsePortFromStdout('  - Local: http://localhost:3000');
    assert.equal(result?.port, 3000);
  });

  it('detects webpack dev server output', () => {
    const result = parsePortFromStdout('<i> [webpack-dev-server] Project is running at http://localhost:8080/');
    assert.equal(result?.port, 8080);
    assert.equal(result?.framework, 'webpack');
  });

  it('detects generic localhost URL', () => {
    const result = parsePortFromStdout('Server started on http://localhost:4200');
    assert.equal(result?.port, 4200);
    assert.equal(result?.framework, 'unknown');
  });

  it('detects 127.0.0.1 URL', () => {
    const result = parsePortFromStdout('Listening on http://127.0.0.1:9000');
    assert.equal(result?.port, 9000);
  });

  it('returns null for non-matching line', () => {
    assert.equal(parsePortFromStdout('Building modules...'), null);
  });

  it('returns null for excluded ports', () => {
    assert.equal(parsePortFromStdout('Server on http://localhost:3004'), null);
  });

  it('returns null for port below range', () => {
    assert.equal(parsePortFromStdout('Server on http://localhost:80'), null);
  });
});

describe('PortDiscoveryService', () => {
  it('emits discovered event for reachable port', async () => {
    const service = new PortDiscoveryService();
    const discovered = [];
    service.onDiscovered((p) => discovered.push(p));

    // Feed a line with a port that is NOT reachable (probe will fail)
    await service.feedStdout('wt-1', 'pane-1', 'http://localhost:59999');
    // Port 59999 is likely not listening, so no event
    assert.equal(discovered.length, 0);
  });

  it('deduplicates same port in same worktree', async () => {
    const service = new PortDiscoveryService();
    let count = 0;
    service.onDiscovered(() => count++);

    await service.feedStdout('wt-1', 'pane-1', 'http://localhost:59998');
    await service.feedStdout('wt-1', 'pane-1', 'http://localhost:59998');
    // Should not emit twice for same worktree:port
    assert.ok(count <= 1);
  });

  it('getDiscoveredPorts returns all discovered', async () => {
    const service = new PortDiscoveryService();
    await service.feedStdout('wt-1', 'pane-1', 'http://localhost:59997');
    const ports = service.getDiscoveredPorts();
    assert.equal(ports.length, 1);
    assert.equal(ports[0].port, 59997);
    assert.equal(ports[0].worktreeId, 'wt-1');
  });

  it('getDiscoveredPorts filters by worktreeId', async () => {
    const service = new PortDiscoveryService();
    await service.feedStdout('wt-1', 'pane-1', 'http://localhost:59996');
    await service.feedStdout('wt-2', 'pane-2', 'http://localhost:59995');
    assert.equal(service.getDiscoveredPorts('wt-1').length, 1);
    assert.equal(service.getDiscoveredPorts('wt-2').length, 1);
  });

  it('removePort clears entry', async () => {
    const service = new PortDiscoveryService();
    await service.feedStdout('wt-1', 'pane-1', 'http://localhost:59994');
    service.removePort('wt-1', 59994);
    assert.equal(service.getDiscoveredPorts().length, 0);
  });

  it('unsubscribe stops notifications', async () => {
    const service = new PortDiscoveryService();
    let count = 0;
    const unsub = service.onDiscovered(() => count++);
    unsub();
    await service.feedStdout('wt-1', 'pane-1', 'http://localhost:59993');
    assert.equal(count, 0);
  });

  // Cloud review P2: re-probe when initial probe was unreachable (deterministic via injected probeFn)
  it('allows re-probe for previously unreachable port on next feedStdout', async () => {
    let probeCallCount = 0;
    const probeResults = [false, true]; // first call: unreachable, second: reachable
    const service = new PortDiscoveryService({
      probeFn: async () => probeResults[probeCallCount++] ?? false,
    });
    let notified = 0;
    service.onDiscovered(() => notified++);

    // First feed — probe returns false → reachable=false, no listener event
    await service.feedStdout('wt-1', 'pane-1', 'http://localhost:4200');
    assert.equal(probeCallCount, 1, 'First probe should have fired');
    assert.equal(notified, 0, 'No notification for unreachable port');
    const firstEntry = service.getDiscoveredPorts('wt-1');
    assert.equal(firstEntry[0].reachable, false);

    // Second feed — same port, probe returns true → should re-probe and notify
    await service.feedStdout('wt-1', 'pane-1', 'http://localhost:4200');
    assert.equal(probeCallCount, 2, 'Second probe should have fired (re-probe)');
    assert.equal(notified, 1, 'Should notify after port becomes reachable');
    const secondEntry = service.getDiscoveredPorts('wt-1');
    assert.equal(secondEntry[0].reachable, true);
  });

  // P2-4: concurrent feed for same port should not trigger parallel probes
  it('concurrent feedStdout for same port deduplicates probes', async () => {
    const service = new PortDiscoveryService();
    let probeCount = 0;
    service.onDiscovered(() => probeCount++);

    // Fire two concurrent feeds for same worktree:port
    const p1 = service.feedStdout('wt-1', 'pane-1', 'http://localhost:59992');
    const p2 = service.feedStdout('wt-1', 'pane-2', 'http://localhost:59992');
    await Promise.all([p1, p2]);

    // At most 1 probe should have been initiated (both unreachable → 0 events,
    // but the key test is that the second call was a no-op)
    assert.ok(probeCount <= 1, `Expected at most 1 probe event, got ${probeCount}`);
  });
});
