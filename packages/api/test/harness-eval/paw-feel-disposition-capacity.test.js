import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { createPawFeelDutyTaskSpec } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/duty-task-spec.js';
import { PawFeelDispositionReadModel } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/read-model.js';
import { PawFeelDispositionReconciler } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/reconciler.js';
import { PawFeelDispositionService } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/service.js';

const DAY = 86_400_000;
const MINUTE = 60_000;
const NOW_MS = Date.parse('2026-07-26T12:00:00.000Z');
const NOW = new Date(NOW_MS).toISOString();
const SIGNAL_COUNT = 624;
const PAGE_SIZE = 50;

class MemoryEventLog {
  events = new Map();
  eventOwners = new Map();

  async append(event, expectedSequence) {
    const owner = this.eventOwners.get(event.eventId);
    if (owner) return { outcome: 'duplicate' };
    const current = this.events.get(event.signalId) ?? [];
    if (current.length !== expectedSequence) {
      return { outcome: 'conflict', actualSequence: current.length };
    }
    this.eventOwners.set(event.eventId, event.signalId);
    this.events.set(event.signalId, [...current, event]);
    return { outcome: 'appended', sequence: current.length };
  }

  async read(signalId, fromSequence = 0) {
    return (this.events.get(signalId) ?? []).slice(fromSequence);
  }

  async readMany(signalIds) {
    return new Map(signalIds.map((signalId) => [signalId, this.events.get(signalId) ?? []]));
  }

  async listSignalIds() {
    return [...this.events.keys()].sort();
  }
}

class MemoryCoverageStore {
  record;

  async getOrInitialize(coverageStartAt) {
    this.record ??= { coverageStartAt, status: 'uninitialized' };
    return structuredClone(this.record);
  }

  async recordStarted(kind, startedAt) {
    if (kind === 'full') this.record.lastFullScanStartedAt = startedAt;
    return structuredClone(this.record);
  }

  async recordSucceeded(kind, startedAt, completedAt, lastSeenTimelineAt) {
    this.record = {
      ...this.record,
      ...(kind === 'full'
        ? { lastFullScanStartedAt: startedAt, lastFullScanCompletedAt: completedAt }
        : { lastOverlapCompletedAt: completedAt }),
      lastSeenTimelineAt,
      status: 'healthy',
      lagMs: 0,
    };
    return structuredClone(this.record);
  }

  async recordUnavailable(kind, attemptedAt, reason) {
    if (kind === 'full') this.record.lastFullScanStartedAt = attemptedAt;
    this.record = { ...this.record, status: 'unavailable', unavailableReason: reason };
    return structuredClone(this.record);
  }

  async read() {
    return this.record ? structuredClone(this.record) : null;
  }
}

class MemoryWatermarkStore {
  current;

  async claim(watermark, claimedAt) {
    if (!this.current || this.current.watermark !== watermark) {
      this.current = { watermark, status: 'claimed', updatedAt: claimedAt };
      return { outcome: 'claimed' };
    }
    if (this.current.status === 'delivered') {
      return { outcome: 'resume_invocation', messageId: this.current.messageId };
    }
    return { outcome: this.current.status === 'complete' ? 'complete' : 'claimed_elsewhere' };
  }

  async markDelivered(watermark, messageId, updatedAt) {
    assert.equal(this.current.watermark, watermark);
    this.current = { watermark, status: 'delivered', messageId, updatedAt };
  }

  async markComplete(watermark, updatedAt) {
    assert.equal(this.current.watermark, watermark);
    this.current = { ...this.current, status: 'complete', updatedAt };
  }
}

function appendSevenDayCorpus(messageStore) {
  const span = 7 * DAY - 6 * MINUTE;
  for (let index = SIGNAL_COUNT - 1; index >= 0; index -= 1) {
    const ageMs = 5 * MINUTE + Math.floor((index * span) / (SIGNAL_COUNT - 1));
    messageStore.append({
      userId: 'user-1',
      catId: 'codex-sol',
      threadId: `thread-${index % 8}`,
      content: `[爪感差: tool-${index % 12}+capacity-signal-${index}]`,
      mentions: [],
      timestamp: NOW_MS - ageMs,
    });
  }
}

function command(type, signalId, expectedSequence, index, extra = {}) {
  return {
    type,
    eventId: `capacity:${type}:${index}`,
    signalId,
    expectedSequence,
    ...extra,
  };
}

describe('F278 seven-day capacity contract', () => {
  it('keeps 624 identities visible through replay, paging, bulk signatures, filtering, and notice dedupe', async () => {
    const messageStore = new MessageStore({ maxMessages: 1_000 });
    const eventLog = new MemoryEventLog();
    const coverageStore = new MemoryCoverageStore();
    const service = new PawFeelDispositionService({ eventLog, now: () => NOW });
    const reconciler = new PawFeelDispositionReconciler({
      messageStore,
      coverageStore,
      dispositionService: service,
      now: () => NOW,
      initialBackfillMs: 7 * DAY,
      overlapWindowMs: 15 * MINUTE,
      fullScanIntervalMs: DAY,
      pageSize: 73,
    });
    appendSevenDayCorpus(messageStore);

    const initial = await reconciler.run();
    const replay = await reconciler.run();

    assert.equal(initial.mode, 'full');
    assert.equal(initial.canonicalSignals, SIGNAL_COUNT);
    assert.equal(initial.discoveredSignals, SIGNAL_COUNT);
    assert.equal(eventLog.events.size, SIGNAL_COUNT);
    assert.equal(replay.mode, 'overlap');
    assert.equal(replay.discoveredSignals, 0);
    assert.ok(replay.duplicateSignals >= 1, 'overlap must replay at least the newest signal');
    assert.equal(eventLog.events.size, SIGNAL_COUNT, 'replay must not create a second identity');

    const readModel = new PawFeelDispositionReadModel({
      eventLog,
      messageStore,
      coverageStore,
      semanticDegraded: () => true,
      now: () => NOW,
    });
    const first = await readModel.list({ limit: PAGE_SIZE });
    const selected = first.items.map((item) => item.disposition.signalId);
    assert.equal(selected.length, PAGE_SIZE);
    assert.equal(first.denominator.reportOccurrences, SIGNAL_COUNT);
    assert.equal(first.denominator.reviewBundles, SIGNAL_COUNT);
    assert.equal(first.bundleCounts.total, SIGNAL_COUNT);

    const seen = await service.executeMany(
      { kind: 'cat', id: 'opus' },
      selected.map((signalId, index) => command('mark_seen', signalId, 1, index)),
    );
    const disposed = await service.executeMany(
      { kind: 'cat', id: 'opus' },
      selected.map((signalId, index) =>
        command('mark_no_action', signalId, 2, index, { reasonCode: 'not_actionable' }),
      ),
    );
    assert.equal(
      seen.every((result) => result.outcome === 'appended'),
      true,
    );
    assert.equal(
      disposed.every((result) => result.outcome === 'appended'),
      true,
    );
    assert.equal(
      disposed.every((result) => result.outcome === 'appended' && result.projection.lastActorCatId === 'opus'),
      true,
      'bulk confirmation must preserve one cat signature per signal',
    );

    const visible = [];
    let cursor;
    do {
      const page = await readModel.list({ limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
      assert.equal(page.degraded, true);
      assert.equal(page.counts.total, SIGNAL_COUNT);
      visible.push(...page.items.map((item) => item.disposition.signalId));
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(visible.length, SIGNAL_COUNT);
    assert.equal(new Set(visible).size, SIGNAL_COUNT);
    assert.equal(Math.ceil(visible.length / PAGE_SIZE), 13);

    const filtered = await readModel.list({ states: ['no_action'], limit: PAGE_SIZE });
    const undispositioned = await readModel.listUndispositioned();
    assert.equal(filtered.items.length, PAGE_SIZE);
    assert.equal(filtered.counts.total, SIGNAL_COUNT, 'filters must not rewrite global counts');
    assert.equal(filtered.counts.disposed, PAGE_SIZE);
    assert.equal(undispositioned.length, SIGNAL_COUNT - PAGE_SIZE);

    const watermarkStore = new MemoryWatermarkStore();
    const task = createPawFeelDutyTaskSpec({
      loadUndispositioned: () => readModel.listUndispositioned(),
      loadDutyConfig: async () => ({
        systemThreadId: 'thread_eval_friction',
        primaryCatId: 'codex-sol',
        backupCatId: 'opus',
        version: 1,
        updatedAt: NOW,
        updatedBy: 'you',
      }),
      watermarkStore,
      ownerUserId: 'user-1',
      inboxHref: '/workspace?tab=eval&section=paw-feel',
      now: () => NOW,
    });
    const gate = await task.admission.gate({ taskId: task.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gate.run, true);
    assert.equal(gate.workItems[0].signal.rawSignalCount, SIGNAL_COUNT - PAGE_SIZE);
    assert.equal(gate.workItems[0].signal.reviewBundleCount, SIGNAL_COUNT - PAGE_SIZE);
    assert.match(
      gate.workItems[0].signal.content,
      new RegExp(`${SIGNAL_COUNT - PAGE_SIZE} 个 bundle / ${SIGNAL_COUNT - PAGE_SIZE} 条 raw signal`),
    );
    assert.equal(
      gate.workItems[0].signal.content.split('\n').filter((line) => line.startsWith('- ')).length,
      5,
      'the notice carries bounded representative refs while its watermark covers the complete inbox',
    );
    assert.doesNotMatch(gate.workItems[0].signal.content, /\[爪感差[:：]/);

    const delivered = [];
    await task.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {
      assignedCatId: null,
      async deliver(input) {
        delivered.push(input);
        return 'capacity-notice-1';
      },
      invokeTrigger: { async trigger() {} },
    });
    assert.equal(delivered.length, 1);
    assert.equal(watermarkStore.current.status, 'complete');
    const duplicateGate = await task.admission.gate({ taskId: task.id, lastRunAt: 1, tickCount: 2 });
    assert.deepEqual(duplicateGate, {
      run: false,
      reason: 'duty notice watermark already complete',
    });
  });
});
