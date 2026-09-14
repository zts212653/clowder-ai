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
  return { detectedAt, providers };
}

/**
 * Read one provider out of the published report. The registry deliberately exposes no
 * per-client lookup — an unused convenience accessor is speculative surface — so callers
 * index the report.
 */
function findProvider(registry, clientId) {
  return registry.getReport()?.providers.find((p) => p.clientId === clientId);
}

test('seed publishes without running detection', () => {
  const resolveCommand = () => {
    throw new Error('detection must not run during seed');
  };
  const registry = new ProviderAvailabilityRegistry({ resolveCommand });

  registry.seed(report([provider()]));

  assert.equal(registry.getReport().providers.length, 1);
  assert.equal(findProvider(registry, 'anthropic').installed, true);
  assert.equal(findProvider(registry, 'openai'), undefined);
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
  assert.equal(findProvider(registry, 'anthropic').installed, true);
  assert.equal(findProvider(registry, 'openai').installed, false);
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

test('age comes from the report itself, so hydration cannot launder a stale snapshot', async () => {
  // The injected clock is only meaningful for seeded reports, whose `detectedAt` the test
  // controls. A real round stamps its own `detectedAt` from the wall clock, so that half is
  // asserted with a tolerance instead of an exact fake-clock delta.
  let now = Date.now();
  const registry = new ProviderAvailabilityRegistry({
    resolveCommand: () => null,
    env: {},
    now: () => now,
  });

  assert.equal(registry.getAgeMs(), null, 'nothing published yet');

  // A snapshot written by a previous process three days ago. Seeding it must NOT reset its age:
  // stamping a "published at" clock here would make `/api/clients` report a fresh ageMs next to
  // a days-old detectedAt, and would let a consumer treat days-stale findings as current.
  const threeDaysMs = 3 * 24 * 60 * 60 * 1000;
  const oldDetectedAt = new Date(now - threeDaysMs).toISOString();
  registry.seed(report([provider()], oldDetectedAt));
  assert.equal(registry.getAgeMs(), threeDaysMs);
  assert.equal(registry.getReport().detectedAt, oldDetectedAt);

  // Age tracks the clock, it is not frozen at publish time.
  now += 4_000;
  assert.equal(registry.getAgeMs(), threeDaysMs + 4_000);

  // A real round is current by construction.
  await registry.refresh();
  const freshAge = registry.getAgeMs();
  assert.ok(freshAge !== null && freshAge < 5_000, `a fresh round should be near-zero age, got ${freshAge}`);
});

test('an unreadable timestamp reads as unknown, never as fresh', () => {
  const registry = new ProviderAvailabilityRegistry({ resolveCommand: () => null, env: {}, now: () => 5_000 });
  registry.seed(report([provider()], 'not-a-timestamp'));
  assert.equal(registry.getAgeMs(), null, 'unknown age must not be presented as age 0');
});

test('a future timestamp does not produce a negative age', () => {
  const registry = new ProviderAvailabilityRegistry({ resolveCommand: () => null, env: {}, now: () => 5_000 });
  registry.seed(report([provider()], new Date(9_000).toISOString()));
  assert.equal(registry.getAgeMs(), 0);
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
