import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('F293 routing context composition', () => {
  test('binds owner reads, writes and preflight to one resolver/store graph', async () => {
    const { createRoutingContextRuntime } = await import('../dist/domains/routing-context/RoutingContextRuntime.js');
    const redis = {};
    const runtime = createRoutingContextRuntime({ redis, projectRoot: process.cwd(), getConfigs: () => ({}) });
    assert.equal(runtime.signalStore.redis, redis);
    assert.equal(runtime.preferenceStore.redis, redis);
    assert.equal(runtime.resolver.dependencies.signalStore, runtime.signalStore);
    assert.equal(runtime.resolver.dependencies.preferenceStore, runtime.preferenceStore);
    assert.equal(runtime.readService.dependencies.resolver, runtime.resolver);
    assert.equal(runtime.preflightService.resolver, runtime.resolver);
    assert.ok(runtime.promptProjector);
    assert.ok(runtime.promptProjection);
  });
});
