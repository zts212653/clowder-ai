// @ts-check

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const DAY = 24 * 60 * 60 * 1000;
const START = Date.UTC(2026, 6, 1);
const END = START + 2 * DAY;

class FakeRedis {
  constructor(values = {}, keyPrefix = 'test:') {
    this.options = { keyPrefix };
    this.values = new Map(Object.entries(values).map(([key, value]) => [`${keyPrefix}${key}`, String(value)]));
    this.scanPatterns = [];
  }

  async scan(_cursor, _matchToken, pattern) {
    this.scanPatterns.push(pattern);
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    return ['0', [...this.values.keys()].filter((key) => key.startsWith(prefix))];
  }

  async mget(...keys) {
    return keys.map((key) => this.values.get(`${this.options.keyPrefix}${key}`) ?? null);
  }
}

class RepeatingScanRedis extends FakeRedis {
  async scan(cursor, _matchToken, pattern) {
    this.scanPatterns.push(pattern);
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    const keys = [...this.values.keys()].filter((key) => key.startsWith(prefix));
    if (keys.length === 0) return ['0', []];
    return cursor === '0' ? ['1', keys] : ['0', keys];
  }
}

const selector = {
  kind: 'capability-tips-usage-window',
  windowStartMs: START,
  windowEndMs: END,
};

describe('F268 capability-tips-usage source adapter', () => {
  it('projects usage rows and batch-unit transport counters without inventing opportunity', async () => {
    const { CapabilityTipsUsageAdapter } = await import(
      '../../dist/infrastructure/harness-eval/capability-tips/capability-tips-usage-adapter.js'
    );
    const redis = new FakeRedis({
      'tip-telemetry:agg:2026-06-30:outside:capability_tip_exposed:shown': 99,
      'tip-telemetry:agg:2026-07-01:tip-a:capability_tip_exposed:shown': 2,
      'tip-telemetry:agg:2026-07-01:tip-a:capability_tip_action:opened': 1,
      'tip-telemetry:agg:2026-07-01:tip-a:capability_tip_action:failed': 1,
      'tip-telemetry:agg:2026-07-01:tip-a:capability_tip_dismissed:dismissed': 1,
      'tip-telemetry:agg:2026-07-02:tip-b:capability_tip_exposed:shown': 3,
      'tip-telemetry:transport:2026-07-01T00:accepted': 2,
      'tip-telemetry:transport:2026-07-01T01:duplicate': 1,
      'tip-telemetry:transport:2026-07-01T02:rejected': 1,
      'tip-telemetry:transport:2026-07-01T03:conflict': 1,
      'tip-telemetry:transport:2026-06-30T23:accepted': 50,
    });

    const snapshot = await new CapabilityTipsUsageAdapter(redis).resolve(selector);

    assert.equal(snapshot.status, 'insufficient');
    assert.deepEqual(snapshot.summary, {
      opportunity: null,
      exposure: 5,
      action: 2,
      dismiss: 1,
      failure: 1,
    });
    assert.deepEqual(snapshot.transport, { accepted: 2, duplicate: 1, rejected: 1, conflict: 1 });
    assert.equal(snapshot.opportunity.status, 'unavailable');
    assert.equal(snapshot.rows.length, 5);
    assert.equal(snapshot.provenance.sourceAdapter, 'capability-tips-usage');
    assert.deepEqual(redis.scanPatterns.sort(), ['test:tip-telemetry:agg:*', 'test:tip-telemetry:transport:*']);
  });

  it('returns explicit no_data for an empty valid window, never healthy', async () => {
    const { CapabilityTipsUsageAdapter } = await import(
      '../../dist/infrastructure/harness-eval/capability-tips/capability-tips-usage-adapter.js'
    );
    const snapshot = await new CapabilityTipsUsageAdapter(new FakeRedis()).resolve(selector);

    assert.equal(snapshot.status, 'no_data');
    assert.equal(snapshot.rows.length, 0);
    assert.deepEqual(snapshot.summary, {
      opportunity: null,
      exposure: 0,
      action: 0,
      dismiss: 0,
      failure: 0,
    });
  });

  it('counts each Redis key once when SCAN repeats it across cursor pages', async () => {
    const { CapabilityTipsUsageAdapter } = await import(
      '../../dist/infrastructure/harness-eval/capability-tips/capability-tips-usage-adapter.js'
    );
    const redis = new RepeatingScanRedis({
      'tip-telemetry:agg:2026-07-01:tip-a:capability_tip_exposed:shown': 2,
      'tip-telemetry:transport:2026-07-01T00:accepted': 3,
    });

    const snapshot = await new CapabilityTipsUsageAdapter(redis).resolve(selector);

    assert.equal(snapshot.summary.exposure, 2);
    assert.equal(snapshot.rows.length, 1);
    assert.equal(snapshot.transport.accepted, 3);
    assert.equal(snapshot.diagnostics.scannedAggregateKeys, 1);
    assert.equal(snapshot.diagnostics.scannedTransportKeys, 1);
  });

  it('marks malformed stored rows insufficient without echoing unsafe keys', async () => {
    const { CapabilityTipsUsageAdapter } = await import(
      '../../dist/infrastructure/harness-eval/capability-tips/capability-tips-usage-adapter.js'
    );
    const redis = new FakeRedis({
      'tip-telemetry:agg:2026-07-01:free text:capability_tip_exposed:shown': 2,
      'tip-telemetry:agg:2026-07-01:tip-a:capability_tip_exposed:shown': 'not-a-count',
    });

    const snapshot = await new CapabilityTipsUsageAdapter(redis).resolve(selector);

    assert.equal(snapshot.status, 'insufficient');
    assert.deepEqual(snapshot.diagnostics, {
      scannedAggregateKeys: 2,
      malformedAggregateKeys: 1,
      malformedAggregateValues: 1,
      scannedTransportKeys: 0,
      malformedTransportKeys: 0,
      malformedTransportValues: 0,
    });
    assert.doesNotMatch(JSON.stringify(snapshot), /free text/);
  });

  it('rejects misaligned, oversized, and wrong-kind windows', async () => {
    const { validateCapabilityTipsUsageSelector } = await import(
      '../../dist/infrastructure/harness-eval/capability-tips/capability-tips-usage-adapter.js'
    );

    assert.match(validateCapabilityTipsUsageSelector({ ...selector, windowStartMs: START + 1 }), /UTC midnight/);
    assert.match(validateCapabilityTipsUsageSelector({ ...selector, windowEndMs: START + 91 * DAY }), /90 days/);
    assert.match(validateCapabilityTipsUsageSelector({ ...selector, kind: 'wrong-kind' }), /kind/);
    assert.equal(validateCapabilityTipsUsageSelector(selector), null);
  });
});
