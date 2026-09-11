/**
 * ProviderAvailabilityRegistry tests.
 *
 * The properties worth locking in: publishing is copy-on-write and advisory, a report's age is
 * explicit (so a consumer can tell "we checked" from "we checked a while ago"), and concurrent
 * refresh callers share one round instead of each sweeping PATH.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { ProviderAvailabilityRegistry, resolveDiscoveryIntervalMs } = await import(
  '../dist/domains/cats/services/agents/providers/ProviderAvailabilityRegistry.js'
);

function provider(overrides = {}) {
  return {
    clientId: 'anthropic',
    toolId: 'claude',
    label: 'Claude',
    installed: true,
    command: 'claude',
    resolvedPath: '/usr/local/bin/claude',
    resolvedVia: 'path',
    hasApiKey: false,
    status: 'configured',
    installHint: 'npm install -g @anthropic-ai/claude-code',
    localCli: true,
    ...overrides,
  };
}

function report(providers, detectedAt = new Date().toISOString()) {
  return { detectedAt, versionProbeEnabled: false, providers };
}

test('seed publishes without running detection', () => {
  const resolveCommand = () => {
    throw new Error('detection must not run during seed');
  };
  const registry = new ProviderAvailabilityRegistry({ resolveCommand });

  registry.seed(report([provider()]));

  assert.equal(registry.getReport().providers.length, 1);
  assert.equal(registry.getProvider('anthropic').installed, true);
  assert.equal(registry.getProvider('openai'), undefined);
});

test('refresh runs detection and notifies onReport', async () => {
  const seen = [];
  const registry = new ProviderAvailabilityRegistry({
    resolveCommand: (command) => (command === 'claude' ? '/usr/local/bin/claude' : null),
    env: {},
    onReport: (r) => seen.push(r),
  });

  const published = await registry.refresh();

  assert.equal(registry.getReport(), published);
  assert.equal(seen.length, 1, 'onReport fires once per published round');
  assert.equal(registry.getProvider('anthropic').installed, true);
  assert.equal(registry.getProvider('openai').installed, false);
});

test('concurrent refreshes share a single round', async () => {
  const registry = new ProviderAvailabilityRegistry({ resolveCommand: () => null, env: {} });

  const first = registry.refresh();
  const second = registry.refresh();

  assert.equal(first, second, 'the second caller joins the in-flight round');
  await first;
  // Once settled the slot is free again, so a later caller starts a fresh round.
  const third = registry.refresh();
  assert.notEqual(third, first);
  await third;
});

test('a throwing onReport hook never fails the round', async () => {
  const registry = new ProviderAvailabilityRegistry({
    resolveCommand: () => null,
    env: {},
    onReport: () => {
      throw new Error('persistence exploded');
    },
  });

  await assert.doesNotReject(() => registry.refresh());
  assert.equal(registry.getReport().providers.length, 9);
});

test('report age is explicit and staleness is queryable', async () => {
  let now = 1_000;
  const registry = new ProviderAvailabilityRegistry({
    resolveCommand: () => null,
    env: {},
    now: () => now,
  });

  assert.equal(registry.getAgeMs(), null, 'nothing published yet');
  assert.equal(registry.getFreshReport(1_000), null, 'no report is never a fresh report');

  await registry.refresh();
  assert.equal(registry.getAgeMs(), 0);
  assert.ok(registry.getFreshReport(1_000));

  now = 5_000;
  assert.equal(registry.getAgeMs(), 4_000);
  assert.equal(registry.getFreshReport(1_000), null, 'a stale report must not read as current');
  assert.ok(registry.getFreshReport(10_000));
});

test('resolveDiscoveryIntervalMs validates and defaults', () => {
  assert.equal(resolveDiscoveryIntervalMs({}), 300_000);
  assert.equal(resolveDiscoveryIntervalMs({ CAT_PROVIDER_DISCOVERY_INTERVAL_MS: '' }), 300_000);
  assert.equal(resolveDiscoveryIntervalMs({ CAT_PROVIDER_DISCOVERY_INTERVAL_MS: '0' }), 0);
  assert.equal(resolveDiscoveryIntervalMs({ CAT_PROVIDER_DISCOVERY_INTERVAL_MS: '1500' }), 1500);
  assert.equal(resolveDiscoveryIntervalMs({ CAT_PROVIDER_DISCOVERY_INTERVAL_MS: 'abc' }), 300_000);
  assert.equal(resolveDiscoveryIntervalMs({ CAT_PROVIDER_DISCOVERY_INTERVAL_MS: '-5' }), 300_000);
});

test('start is idempotent and stop clears the loop', async () => {
  const registry = new ProviderAvailabilityRegistry({ resolveCommand: () => null, env: {} });

  registry.start({ intervalMs: 0 });
  assert.equal(registry.isRunning(), false, '0 disables the periodic loop');
  await registry.refresh();
  assert.ok(registry.getReport(), 'the immediate round still ran');

  registry.start({ intervalMs: 20 });
  assert.equal(registry.isRunning(), true);
  registry.start({ intervalMs: 20 });
  assert.equal(registry.isRunning(), true, 'a second start is a no-op');

  registry.stop();
  assert.equal(registry.isRunning(), false);
  registry.stop();
  assert.equal(registry.isRunning(), false, 'stop is idempotent');
});
