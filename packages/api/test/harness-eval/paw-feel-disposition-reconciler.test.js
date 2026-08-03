import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import {
  derivePawFeelCoverageHealth,
  PawFeelDispositionReconciler,
} from '../../dist/infrastructure/harness-eval/paw-feel-disposition/reconciler.js';

const DAY = 86_400_000;
const MINUTE = 60_000;
const NOW_MS = Date.parse('2026-07-26T12:00:00.000Z');
const NOW = new Date(NOW_MS).toISOString();

class MemoryCoverageStore {
  record;
  failNextSuccess = false;

  constructor(initial) {
    this.record = initial;
  }

  async getOrInitialize(coverageStartAt, typedCaptureActivatedAt) {
    this.record ??= { coverageStartAt, typedCaptureActivatedAt, status: 'uninitialized' };
    this.record.typedCaptureActivatedAt ??= typedCaptureActivatedAt;
    return structuredClone(this.record);
  }

  async recordStarted(kind, startedAt) {
    if (kind === 'full') this.record.lastFullScanStartedAt = startedAt;
    return structuredClone(this.record);
  }

  async recordSucceeded(kind, startedAt, completedAt, lastSeenTimelineAt) {
    if (this.failNextSuccess) {
      this.failNextSuccess = false;
      throw new Error('coverage checkpoint unavailable');
    }
    this.record = {
      ...this.record,
      ...(kind === 'full'
        ? { lastFullScanStartedAt: startedAt, lastFullScanCompletedAt: completedAt }
        : { lastOverlapCompletedAt: completedAt }),
      lastSeenTimelineAt,
      status: 'healthy',
      lagMs: 0,
    };
    delete this.record.unavailableReason;
    return structuredClone(this.record);
  }

  async recordUnavailable(kind, attemptedAt, reason) {
    if (kind === 'full') this.record.lastFullScanStartedAt = attemptedAt;
    this.record = { ...this.record, status: 'unavailable', unavailableReason: reason };
    return structuredClone(this.record);
  }
}

class RecordingDiscoveryService {
  seen = new Map();
  calls = [];

  async discover(candidate, options) {
    this.calls.push({
      signalId: candidate.signalId,
      backfilled: options.backfilled,
      captureMethod: options.captureMethod,
      captureAssessment: options.captureAssessment,
    });
    if (this.seen.has(candidate.signalId)) {
      return { outcome: 'duplicate', projection: this.seen.get(candidate.signalId) };
    }
    const projection = { signalId: candidate.signalId };
    this.seen.set(candidate.signalId, projection);
    return { outcome: 'appended', projection };
  }
}

function append(store, ageMs, content = '[爪感差: tool+phenomenon]', overrides = {}) {
  return store.append({
    userId: 'user-1',
    catId: 'codex-sol',
    threadId: 'thread-source',
    content,
    mentions: [],
    timestamp: NOW_MS - ageMs,
    ...overrides,
  });
}

function makeReconciler(overrides = {}) {
  const messageStore = overrides.messageStore ?? new MessageStore();
  const coverageStore = overrides.coverageStore ?? new MemoryCoverageStore();
  const service = overrides.service ?? new RecordingDiscoveryService();
  return {
    messageStore,
    coverageStore,
    service,
    reconciler: new PawFeelDispositionReconciler({
      messageStore,
      coverageStore,
      dispositionService: service,
      now: () => NOW,
      initialBackfillMs: 7 * DAY,
      overlapWindowMs: 15 * MINUTE,
      fullScanIntervalMs: DAY,
    }),
  };
}

describe('F278 paw-feel reconciliation', () => {
  it('initializes a seven-day boundary and backfills only canonical cat signals inside it', async () => {
    const fixture = makeReconciler();
    append(fixture.messageStore, 8 * DAY);
    append(fixture.messageStore, 6 * DAY, '[爪感差: one+old] [爪感差: two+old]');
    append(fixture.messageStore, DAY, '[爪感差: quoted+user]', { catId: null });

    const result = await fixture.reconciler.run();

    assert.equal(result.mode, 'full');
    assert.equal(result.scannedMessages, 2);
    assert.equal(result.canonicalSignals, 2);
    assert.equal(result.discoveredSignals, 2);
    assert.equal(result.duplicateSignals, 0);
    assert.deepEqual(
      fixture.service.calls.map(({ backfilled, captureMethod, captureAssessment }) => ({
        backfilled,
        captureMethod,
        captureAssessment,
      })),
      [
        { backfilled: true, captureMethod: 'legacy_parser', captureAssessment: 'ambiguous' },
        { backfilled: true, captureMethod: 'legacy_parser', captureAssessment: 'ambiguous' },
      ],
    );
    assert.equal(fixture.coverageStore.record.coverageStartAt, new Date(NOW_MS - 7 * DAY).toISOString());
    assert.equal(fixture.coverageStore.record.lastFullScanCompletedAt, NOW);
    assert.equal(fixture.coverageStore.record.lastSeenTimelineAt, NOW);
    assert.equal(fixture.coverageStore.record.status, 'healthy');
  });

  it('uses permissive legacy recall before activation and strict standalone rescue after activation', async () => {
    const activationAt = new Date(NOW_MS - 30 * MINUTE).toISOString();
    const initial = {
      coverageStartAt: new Date(NOW_MS - 7 * DAY).toISOString(),
      typedCaptureActivatedAt: activationAt,
      lastFullScanCompletedAt: new Date(NOW_MS - DAY - MINUTE).toISOString(),
      status: 'healthy',
    };
    const fixture = makeReconciler({ coverageStore: new MemoryCoverageStore(initial) });
    append(fixture.messageStore, 40 * MINUTE, '[爪感差: legacy+before activation]');
    append(fixture.messageStore, 10 * MINUTE, '[爪感差: missed+standalone]');
    append(fixture.messageStore, 9 * MINUTE, 'inline `[爪感差: example+not report]`');
    append(fixture.messageStore, 8 * MINUTE, '```\n[爪感差: fenced+not report]\n```');
    append(fixture.messageStore, 7 * MINUTE, '> [爪感差: quoted+not report]');

    const result = await fixture.reconciler.run();

    assert.equal(result.mode, 'full');
    assert.equal(result.scannedMessages, 5);
    assert.equal(result.canonicalSignals, 2);
    assert.equal(result.discoveredSignals, 2);
    assert.deepEqual(
      fixture.service.calls.map(({ backfilled, captureMethod, captureAssessment }) => ({
        backfilled,
        captureMethod,
        captureAssessment,
      })),
      [
        { backfilled: true, captureMethod: 'legacy_parser', captureAssessment: 'ambiguous' },
        { backfilled: false, captureMethod: 'legacy_parser', captureAssessment: 'ambiguous' },
      ],
    );
  });

  it('overlap reconciliation rescues a missed post-activation append and replays it idempotently', async () => {
    const activationAt = new Date(NOW_MS - 30 * MINUTE).toISOString();
    const initial = {
      coverageStartAt: new Date(NOW_MS - 7 * DAY).toISOString(),
      typedCaptureActivatedAt: activationAt,
      lastFullScanStartedAt: new Date(NOW_MS - 2 * 60 * MINUTE).toISOString(),
      lastFullScanCompletedAt: new Date(NOW_MS - 2 * 60 * MINUTE).toISOString(),
      lastSeenTimelineAt: new Date(NOW_MS - 20 * MINUTE).toISOString(),
      status: 'healthy',
    };
    const fixture = makeReconciler({ coverageStore: new MemoryCoverageStore(initial) });
    append(fixture.messageStore, 10 * MINUTE, '[爪感差: missed+post-persist failure]');

    const first = await fixture.reconciler.run();
    const replay = await fixture.reconciler.run();

    assert.equal(first.mode, 'overlap');
    assert.equal(first.discoveredSignals, 1);
    assert.equal(first.duplicateSignals, 0);
    assert.equal(replay.mode, 'overlap');
    assert.equal(replay.discoveredSignals, 0);
    assert.equal(replay.duplicateSignals, 1);
    assert.deepEqual(
      fixture.service.calls.map(({ backfilled, captureMethod, captureAssessment }) => ({
        backfilled,
        captureMethod,
        captureAssessment,
      })),
      [
        { backfilled: false, captureMethod: 'legacy_parser', captureAssessment: 'ambiguous' },
        { backfilled: false, captureMethod: 'legacy_parser', captureAssessment: 'ambiguous' },
      ],
    );
  });

  it('uses an overlap window between daily full scans and replays discoveries idempotently', async () => {
    const initial = {
      coverageStartAt: new Date(NOW_MS - 7 * DAY).toISOString(),
      lastFullScanStartedAt: new Date(NOW_MS - 2 * 60 * MINUTE).toISOString(),
      lastFullScanCompletedAt: new Date(NOW_MS - 2 * 60 * MINUTE).toISOString(),
      lastSeenTimelineAt: new Date(NOW_MS - 20 * MINUTE).toISOString(),
      status: 'healthy',
    };
    const fixture = makeReconciler({ coverageStore: new MemoryCoverageStore(initial) });
    append(fixture.messageStore, 40 * MINUTE, '[爪感差: outside+overlap]');
    append(fixture.messageStore, 30 * MINUTE, '[爪感差: late+inside]');
    append(fixture.messageStore, 10 * MINUTE, '[爪感差: current+inside]');

    const first = await fixture.reconciler.run();
    const second = await fixture.reconciler.run();

    assert.equal(first.mode, 'overlap');
    assert.equal(first.scannedMessages, 2);
    assert.equal(first.discoveredSignals, 2);
    assert.equal(second.mode, 'overlap');
    assert.equal(second.discoveredSignals, 0);
    assert.equal(second.duplicateSignals, 1, 'the next overlap only replays the most recent signal');
    assert.equal(fixture.coverageStore.record.lastOverlapCompletedAt, NOW);
  });

  it('selects a full replay once the last full completion is a day old', async () => {
    const initial = {
      coverageStartAt: new Date(NOW_MS - 7 * DAY).toISOString(),
      lastFullScanCompletedAt: new Date(NOW_MS - DAY - MINUTE).toISOString(),
      lastSeenTimelineAt: new Date(NOW_MS - 5 * MINUTE).toISOString(),
      status: 'healthy',
    };
    const fixture = makeReconciler({ coverageStore: new MemoryCoverageStore(initial) });
    append(fixture.messageStore, 6 * DAY);

    const result = await fixture.reconciler.run();

    assert.equal(result.mode, 'full');
    assert.equal(result.scannedMessages, 1);
  });

  it('appends discoveries before the coverage checkpoint and safely replays after a crash window', async () => {
    const coverageStore = new MemoryCoverageStore();
    coverageStore.failNextSuccess = true;
    const fixture = makeReconciler({ coverageStore });
    append(fixture.messageStore, MINUTE);

    await assert.rejects(fixture.reconciler.run(), /coverage checkpoint unavailable/);
    assert.equal(fixture.service.seen.size, 1, 'discovery became durable before checkpoint failure');
    assert.equal(fixture.coverageStore.record.status, 'unavailable');
    assert.equal(fixture.coverageStore.record.lastFullScanCompletedAt, undefined);

    const retried = await fixture.reconciler.run();
    assert.equal(retried.discoveredSignals, 0);
    assert.equal(retried.duplicateSignals, 1);
    assert.equal(fixture.service.seen.size, 1);
    assert.equal(fixture.coverageStore.record.lastFullScanCompletedAt, NOW);
  });

  it('preserves successful boundaries and marks coverage unavailable when the source scan fails', async () => {
    const initial = {
      coverageStartAt: new Date(NOW_MS - 7 * DAY).toISOString(),
      lastFullScanCompletedAt: new Date(NOW_MS - 2 * DAY).toISOString(),
      lastSeenTimelineAt: new Date(NOW_MS - DAY).toISOString(),
      status: 'lagging',
      lagMs: DAY,
    };
    const messageStore = {
      async getBefore() {
        throw new Error('timeline unavailable');
      },
    };
    const fixture = makeReconciler({
      messageStore,
      coverageStore: new MemoryCoverageStore(initial),
    });

    await assert.rejects(fixture.reconciler.run(), /timeline unavailable/);
    assert.equal(fixture.coverageStore.record.status, 'unavailable');
    assert.equal(fixture.coverageStore.record.lastFullScanCompletedAt, initial.lastFullScanCompletedAt);
    assert.equal(fixture.coverageStore.record.lastSeenTimelineAt, initial.lastSeenTimelineAt);
    assert.match(fixture.coverageStore.record.unavailableReason, /timeline unavailable/);
  });

  it('derives lag without turning missing coverage or unavailable coverage into health', () => {
    const healthy = derivePawFeelCoverageHealth(
      {
        coverageStartAt: new Date(NOW_MS - 7 * DAY).toISOString(),
        lastSeenTimelineAt: new Date(NOW_MS - 5 * MINUTE).toISOString(),
        status: 'healthy',
      },
      NOW_MS,
      30 * MINUTE,
    );
    const lagging = derivePawFeelCoverageHealth(
      {
        coverageStartAt: new Date(NOW_MS - 7 * DAY).toISOString(),
        lastSeenTimelineAt: new Date(NOW_MS - 31 * MINUTE).toISOString(),
        status: 'healthy',
      },
      NOW_MS,
      30 * MINUTE,
    );
    const unavailable = derivePawFeelCoverageHealth(
      {
        coverageStartAt: new Date(NOW_MS - 7 * DAY).toISOString(),
        lastSeenTimelineAt: new Date(NOW_MS - 5 * MINUTE).toISOString(),
        status: 'unavailable',
        unavailableReason: 'redis unavailable',
      },
      NOW_MS,
      30 * MINUTE,
    );

    assert.equal(healthy.status, 'healthy');
    assert.equal(healthy.lagMs, 5 * MINUTE);
    assert.equal(lagging.status, 'lagging');
    assert.equal(lagging.lagMs, 31 * MINUTE);
    assert.equal(unavailable.status, 'unavailable');
    assert.equal(unavailable.unavailableReason, 'redis unavailable');
  });

  it('fails closed when durable coverage initialization is unavailable', async () => {
    const service = new RecordingDiscoveryService();
    const fixture = makeReconciler({
      service,
      coverageStore: {
        async getOrInitialize() {
          throw new Error('redis unavailable');
        },
      },
    });

    await assert.rejects(fixture.reconciler.run(), /redis unavailable/);
    assert.equal(service.calls.length, 0);
  });
});
