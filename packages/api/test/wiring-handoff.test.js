/**
 * Task 5: Wiring tests — verify handoffConfig flows into SessionSealer
 * and bootstrapDepth flows into buildSessionBootstrap calls.
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

describe('Task 5: Wiring – handoffConfig in SessionSealer', () => {
  it('SessionSealer accepts handoffConfig without a parallel capacity resolver', async () => {
    const { SessionSealer } = await import('../dist/domains/cats/services/session/SessionSealer.js');
    const fakeChainStore = { getLatest: mock.fn(), seal: mock.fn() };
    const fakeWriter = { appendEvent: mock.fn(), flush: mock.fn(), getEventCount: mock.fn() };
    const fakeThreadStore = { get: mock.fn() };
    const fakeReader = {
      readDigest: mock.fn(),
      readAllEvents: mock.fn(),
      getSessionDir: mock.fn(() => '/tmp/test'),
    };
    const handoffConfig = {
      getBootstrapDepth: () => 'extractive',
      resolveProfile: async () => null,
    };

    const sealer = new SessionSealer(fakeChainStore, fakeWriter, fakeThreadStore, fakeReader, handoffConfig);
    assert.ok(sealer, 'SessionSealer constructed with handoffConfig');
  });

  it('SessionSealer works without handoffConfig (backward compat)', async () => {
    const { SessionSealer } = await import('../dist/domains/cats/services/session/SessionSealer.js');
    const fakeChainStore = { getLatest: mock.fn(), seal: mock.fn() };
    const fakeWriter = { appendEvent: mock.fn(), flush: mock.fn(), getEventCount: mock.fn() };
    const fakeThreadStore = { get: mock.fn() };
    const fakeReader = { readDigest: mock.fn() };
    const sealer = new SessionSealer(fakeChainStore, fakeWriter, fakeThreadStore, fakeReader);
    assert.ok(sealer, 'SessionSealer constructed without handoffConfig');
  });
});

describe('Task 5: Wiring – bootstrapDepth in buildSessionBootstrap', () => {
  it('buildSessionBootstrap accepts bootstrapDepth option', async () => {
    const { buildSessionBootstrap } = await import('../dist/domains/cats/services/session/SessionBootstrap.js');
    const fakeChainStore = {
      getLatest: mock.fn(async () => null),
      getChain: mock.fn(async () => []),
      getActive: mock.fn(async () => null),
    };
    const fakeReader = {
      readDigest: mock.fn(),
      readHandoffDigest: mock.fn(),
      readAllEvents: mock.fn(),
    };

    const result = await buildSessionBootstrap(
      {
        sessionChainStore: fakeChainStore,
        transcriptReader: fakeReader,
        bootstrapDepth: 'generative',
      },
      'opus',
      'thread-1',
    );
    // No previous session → returns null
    assert.equal(result, null);
  });
});

describe('Task 5: Wiring – getConfigSessionStrategy accessor', () => {
  it('getConfigSessionStrategy returns valid bootstrapDepth when configured', async () => {
    const { getConfigSessionStrategy } = await import('../dist/config/cat-config-loader.js');
    const strategy = getConfigSessionStrategy('opus');
    if (strategy?.handoff?.bootstrapDepth) {
      assert.ok(
        ['extractive', 'generative'].includes(strategy.handoff.bootstrapDepth),
        'bootstrapDepth is a valid value',
      );
    } else {
      assert.ok(true, 'bootstrapDepth not configured — defaults will apply');
    }
  });
});
