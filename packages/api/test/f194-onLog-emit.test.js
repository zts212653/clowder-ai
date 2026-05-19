/**
 * F194 Phase B (Bundle) AC-B11/B12 — getThreadLiveInvocations onLog hook tests.
 *
 * Verifies the helper emits structured diagnostic events at the matching decision points:
 * - liveness_degraded: source='record+draft' (degraded path)
 * - liveness_pending:  source='record-only' (grace window)
 * - record_zombie_detected: zombie outcome
 *
 * Plus contract requirements:
 * - healthy record+tracker (degraded=false) must NOT emit
 * - sink throwing must NOT interrupt the read
 * - omitting onLog dep is supported (backward compat)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_ZOMBIE_GRACE_MS,
  getThreadLiveInvocations,
} from '../dist/domains/cats/services/agents/invocation/getThreadLiveInvocations.js';

const THREAD_ID = 'thread-test-onlog';
const USER_ID = 'user-onlog';

function makeRecord(overrides = {}) {
  const now = overrides.updatedAt ?? Date.now();
  return {
    id: overrides.id ?? 'inv-1',
    threadId: overrides.threadId ?? THREAD_ID,
    userId: overrides.userId ?? USER_ID,
    userMessageId: 'msg-1',
    targetCats: overrides.targetCats ?? ['opus'],
    intent: 'execute',
    status: overrides.status ?? 'running',
    idempotencyKey: 'k',
    createdAt: overrides.createdAt ?? now,
    updatedAt: now,
    ...overrides,
  };
}

function makeDraft(overrides = {}) {
  const updatedAt = overrides.updatedAt ?? Date.now();
  return {
    userId: USER_ID,
    threadId: THREAD_ID,
    invocationId: overrides.invocationId ?? 'inv-1',
    catId: overrides.catId ?? 'opus',
    content: 'x',
    createdAt: overrides.createdAt ?? updatedAt,
    updatedAt,
  };
}

function makeDeps({ records = [], drafts = [], slots = [], trackerUserIds = {}, onLog } = {}) {
  return {
    listRunningRecords: () => records,
    getDrafts: () => drafts,
    getActiveSlots: () => slots,
    getTrackerUserId: (_t, catId) => trackerUserIds[catId] ?? null,
    onLog,
  };
}

describe('F194 onLog emit — AC-B11/B12', () => {
  it('emits liveness_degraded for record+draft (degraded source)', async () => {
    const now = 1_000_000;
    const record = makeRecord({ id: 'inv-degraded', updatedAt: now - 60_000 });
    const draft = makeDraft({ invocationId: 'inv-degraded', updatedAt: now - 100, createdAt: now - 50_000 });
    const events = [];
    const deps = makeDeps({ records: [record], drafts: [draft], slots: [], onLog: (e) => events.push(e) });

    await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(events.length, 1);
    const ev = events[0];
    assert.equal(ev.kind, 'liveness_degraded');
    assert.equal(ev.source, 'record+draft');
    assert.equal(ev.reason, 'record_running_with_fresh_draft');
    assert.equal(ev.invocationId, 'inv-degraded');
    assert.equal(ev.catId, 'opus');
    assert.equal(ev.recordStatus, 'running');
    assert.equal(ev.trackerSlotPresent, false);
    assert.equal(ev.draftFresh, true);
    assert.ok(typeof ev.draftAge === 'number' && ev.draftAge >= 0);
  });

  it('emits liveness_pending for record-only grace path', async () => {
    const now = 10_000_000;
    const record = makeRecord({ id: 'inv-pending', updatedAt: now - 60_000 });
    const events = [];
    const deps = makeDeps({ records: [record], drafts: [], slots: [], onLog: (e) => events.push(e) });

    await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'liveness_pending');
    assert.equal(events[0].source, 'record-only');
    assert.equal(events[0].reason, 'liveness_pending');
    assert.equal(events[0].draftFresh, null, 'no draft → null');
    assert.equal(events[0].draftAge, null, 'no draft → null');
  });

  it('emits record_zombie_detected for zombie outcome', async () => {
    const now = 10_000_000;
    const record = makeRecord({
      id: 'inv-zombie',
      updatedAt: now - DEFAULT_ZOMBIE_GRACE_MS - 1_000,
    });
    const events = [];
    const deps = makeDeps({ records: [record], drafts: [], slots: [], onLog: (e) => events.push(e) });

    await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'record_zombie_detected');
    assert.equal(events[0].source, null);
    assert.equal(events[0].reason, 'no_tracker_no_fresh_draft_age_exceeded');
    assert.equal(events[0].invocationId, 'inv-zombie');
    assert.equal(events[0].recordUpdatedAt, record.updatedAt);
  });

  it('does NOT emit for non-degraded record+tracker (healthy live)', async () => {
    const now = 1_000_000;
    const record = makeRecord({ id: 'inv-healthy', updatedAt: now - 5_000 });
    const slot = { catId: 'opus', startedAt: now - 4_000 };
    const events = [];
    const deps = makeDeps({
      records: [record],
      slots: [slot],
      trackerUserIds: { opus: USER_ID },
      onLog: (e) => events.push(e),
    });

    await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(events.length, 0, 'healthy record+tracker (degraded=false) must not emit');
  });

  it('emits multiple events for multiple candidates', async () => {
    const now = 10_000_000;
    const records = [
      makeRecord({ id: 'inv-degraded', updatedAt: now - 60_000 }),
      makeRecord({
        id: 'inv-zombie',
        targetCats: ['gpt52'],
        updatedAt: now - DEFAULT_ZOMBIE_GRACE_MS - 1_000,
      }),
    ];
    const draft = makeDraft({
      invocationId: 'inv-degraded',
      updatedAt: now - 100,
      createdAt: now - 50_000,
    });
    const events = [];
    const deps = makeDeps({ records, drafts: [draft], slots: [], onLog: (e) => events.push(e) });

    await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(events.length, 2);
    const kinds = new Set(events.map((e) => e.kind));
    assert.ok(kinds.has('liveness_degraded'), 'must emit degraded for record+draft');
    assert.ok(kinds.has('record_zombie_detected'), 'must emit zombie for zombie outcome');
  });

  it('sink throwing does NOT interrupt the read', async () => {
    const now = 10_000_000;
    const record = makeRecord({ id: 'inv-z', updatedAt: now - DEFAULT_ZOMBIE_GRACE_MS - 1_000 });
    const deps = makeDeps({
      records: [record],
      drafts: [],
      slots: [],
      onLog: () => {
        throw new Error('logger broke');
      },
    });

    // Must not propagate exception; helper still returns full result
    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });
    assert.equal(result.zombies.length, 1);
    assert.equal(result.zombies[0].invocationId, 'inv-z');
  });

  it('omitting onLog dep is supported (backward compat)', async () => {
    const now = 10_000_000;
    const record = makeRecord({ id: 'inv-x', updatedAt: now - 60_000 });
    const deps = makeDeps({ records: [record], drafts: [], slots: [] });
    // no onLog field
    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });
    assert.equal(result.active.length, 1, 'helper still returns result when onLog absent');
  });
});
