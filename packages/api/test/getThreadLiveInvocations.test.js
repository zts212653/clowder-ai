/**
 * F194 Phase A: Tests for getThreadLiveInvocations canonical read model helper.
 *
 * Covers the 5 categories from the F194 decision table (KD-3, KD-6):
 *   1. record running + tracker active           → active, source='record+tracker', degraded=false
 *   2. record running + tracker missing + fresh   → active, source='record+draft', degraded=true,
 *                                                   reason='record_running_with_fresh_draft'
 *   3. record running + tracker missing + stale   → zombie (no_tracker_no_fresh_draft_age_exceeded)
 *   4. record running + tracker missing + grace   → active, source='record-only', degraded=true,
 *                                                   reason='liveness_pending'
 *   5. record not running                          → not exposed
 *
 * Plus AC-A4: active[] and zombies[] mutually exclusive on invocationId.
 * Plus AC-A6: threshold injection works.
 * Plus AC-A5: helper does not mutate any store (read-only).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_FRESH_DRAFT_WINDOW_MS,
  DEFAULT_ZOMBIE_GRACE_MS,
  getThreadLiveInvocations,
} from '../dist/domains/cats/services/agents/invocation/getThreadLiveInvocations.js';

const THREAD_ID = 'thread-test-1';
const USER_ID = 'user-1';

function makeRecord(overrides = {}) {
  const now = overrides.updatedAt ?? Date.now();
  return {
    id: overrides.id ?? 'inv-1',
    threadId: overrides.threadId ?? THREAD_ID,
    userId: overrides.userId ?? USER_ID,
    userMessageId: overrides.userMessageId ?? 'msg-1',
    targetCats: overrides.targetCats ?? ['opus'],
    intent: overrides.intent ?? 'execute',
    status: overrides.status ?? 'running',
    idempotencyKey: overrides.idempotencyKey ?? 'idem-1',
    createdAt: overrides.createdAt ?? now,
    updatedAt: now,
    ...overrides,
  };
}

function makeDraft(overrides = {}) {
  const updatedAt = overrides.updatedAt ?? Date.now();
  return {
    userId: overrides.userId ?? USER_ID,
    threadId: overrides.threadId ?? THREAD_ID,
    invocationId: overrides.invocationId ?? 'inv-1',
    catId: overrides.catId ?? 'opus',
    content: overrides.content ?? 'partial...',
    createdAt: overrides.createdAt ?? updatedAt,
    updatedAt,
  };
}

function makeDeps({ records = [], drafts = [], slots = [], trackerUserIds = {} } = {}) {
  return {
    listRunningRecords: (_t, _u) => records,
    getDrafts: (_u, _t) => drafts,
    getActiveSlots: (_t) => slots,
    getTrackerUserId: (_t, catId) => trackerUserIds[catId] ?? null,
  };
}

describe('F194 getThreadLiveInvocations — decision table', () => {
  it('case 1: record running + tracker active → active record+tracker, degraded=false', async () => {
    const now = 1_000_000;
    const record = makeRecord({ id: 'inv-tracker', updatedAt: now - 5_000 });
    const slot = { catId: 'opus', startedAt: now - 4_000 };
    const deps = makeDeps({
      records: [record],
      slots: [slot],
      trackerUserIds: { opus: USER_ID },
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(result.active.length, 1);
    assert.equal(result.zombies.length, 0);
    assert.deepEqual(result.active[0], {
      catId: 'opus',
      invocationId: 'inv-tracker',
      startedAt: slot.startedAt,
      source: 'record+tracker',
      degraded: false,
      reason: 'tracker_present',
    });
  });

  it('case 2: record running + tracker missing + fresh draft → active record+draft, degraded=true', async () => {
    const now = 1_000_000;
    const record = makeRecord({ id: 'inv-draft', updatedAt: now - 60_000 });
    const draft = makeDraft({ invocationId: 'inv-draft', updatedAt: now - 100, createdAt: now - 50_000 });
    const deps = makeDeps({ records: [record], drafts: [draft], slots: [] });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(result.active.length, 1);
    assert.equal(result.zombies.length, 0);
    const live = result.active[0];
    assert.equal(live.invocationId, 'inv-draft');
    assert.equal(live.source, 'record+draft');
    assert.equal(live.degraded, true);
    assert.equal(live.reason, 'record_running_with_fresh_draft');
    assert.equal(live.startedAt, draft.createdAt);
    assert.equal(live.catId, 'opus');
  });

  it('case 3: record running + tracker missing + stale draft (age > zombieGrace) → zombie', async () => {
    const now = 10_000_000;
    const record = makeRecord({ id: 'inv-zombie', updatedAt: now - DEFAULT_ZOMBIE_GRACE_MS - 1_000 });
    const deps = makeDeps({ records: [record], drafts: [], slots: [] });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(result.active.length, 0, 'zombie must not be exposed in active[]');
    assert.equal(result.zombies.length, 1);
    assert.deepEqual(result.zombies[0], {
      invocationId: 'inv-zombie',
      catId: 'opus',
      recordStatus: 'running',
      recordUpdatedAt: record.updatedAt,
      reason: 'no_tracker_no_fresh_draft_age_exceeded',
    });
  });

  it('case 4: record running + tracker missing + no draft + age <= grace → active record-only, liveness_pending', async () => {
    const now = 10_000_000;
    const record = makeRecord({ id: 'inv-pending', updatedAt: now - 60_000 });
    const deps = makeDeps({ records: [record], drafts: [], slots: [] });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(result.active.length, 1);
    assert.equal(result.zombies.length, 0);
    const live = result.active[0];
    assert.equal(live.invocationId, 'inv-pending');
    assert.equal(live.source, 'record-only');
    assert.equal(live.degraded, true);
    assert.equal(live.reason, 'liveness_pending');
    assert.equal(live.startedAt, record.updatedAt);
  });

  it('case 5: record not running (e.g. queued / failed / succeeded) → not exposed', async () => {
    const now = 1_000_000;
    const records = [
      makeRecord({ id: 'inv-queued', status: 'queued', updatedAt: now - 1_000 }),
      makeRecord({ id: 'inv-failed', status: 'failed', updatedAt: now - 1_000 }),
      makeRecord({ id: 'inv-succeeded', status: 'succeeded', updatedAt: now - 1_000 }),
      makeRecord({ id: 'inv-canceled', status: 'canceled', updatedAt: now - 1_000 }),
    ];
    const deps = makeDeps({ records, drafts: [], slots: [] });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(result.active.length, 0);
    assert.equal(result.zombies.length, 0);
  });
});

describe('F194 getThreadLiveInvocations — invariants', () => {
  it('AC-A4: active[] and zombies[] never share an invocationId', async () => {
    const now = 10_000_000;
    const records = [
      makeRecord({ id: 'inv-A', updatedAt: now - 5_000 }), // tracker active
      makeRecord({ id: 'inv-B', updatedAt: now - 60_000 }), // fresh draft
      makeRecord({ id: 'inv-C', updatedAt: now - DEFAULT_ZOMBIE_GRACE_MS - 1, targetCats: ['gpt52'] }), // zombie
      makeRecord({ id: 'inv-D', updatedAt: now - 60_000, targetCats: ['gemini'] }), // pending grace
    ];
    const drafts = [makeDraft({ invocationId: 'inv-B', updatedAt: now - 100, createdAt: now - 50_000 })];
    const slots = [{ catId: 'opus', startedAt: now - 4_000 }];
    const deps = makeDeps({ records, drafts, slots, trackerUserIds: { opus: USER_ID } });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    const activeIds = new Set(result.active.map((s) => s.invocationId));
    const zombieIds = new Set(result.zombies.map((s) => s.invocationId));
    for (const id of zombieIds) {
      assert.equal(activeIds.has(id), false, `zombie invocationId ${id} must not appear in active[]`);
    }
    assert.equal(result.active.length, 3, 'A/B/D should be active');
    assert.equal(result.zombies.length, 1, 'C should be zombie');
    assert.equal(result.zombies[0].invocationId, 'inv-C');
  });

  it('AC-A5: helper does not mutate the dependency objects', async () => {
    const now = 1_000_000;
    const record = makeRecord({ id: 'inv-1', updatedAt: now - 5_000 });
    const draft = makeDraft({ updatedAt: now - 100 });
    const slot = { catId: 'opus', startedAt: now - 4_000 };
    const recordsArr = [record];
    const draftsArr = [draft];
    const slotsArr = [slot];
    const deps = makeDeps({
      records: recordsArr,
      drafts: draftsArr,
      slots: slotsArr,
      trackerUserIds: { opus: USER_ID },
    });

    const recordSnap = JSON.stringify(record);
    const draftSnap = JSON.stringify(draft);
    const slotSnap = JSON.stringify(slot);

    await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(JSON.stringify(record), recordSnap, 'record must not be mutated');
    assert.equal(JSON.stringify(draft), draftSnap, 'draft must not be mutated');
    assert.equal(JSON.stringify(slot), slotSnap, 'slot must not be mutated');
    assert.equal(recordsArr.length, 1);
    assert.equal(draftsArr.length, 1);
    assert.equal(slotsArr.length, 1);
  });

  it('AC-A6: threshold injection — overriding zombieGraceMs flips pending → zombie', async () => {
    const now = 10_000_000;
    const record = makeRecord({ id: 'inv-pending-or-zombie', updatedAt: now - 30_000 });
    const deps = makeDeps({ records: [record], drafts: [], slots: [] });

    // With default 600s grace: pending
    const r1 = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });
    assert.equal(r1.active.length, 1);
    assert.equal(r1.zombies.length, 0);
    assert.equal(r1.active[0].reason, 'liveness_pending');

    // Tighten grace to 10s: same record now zombie
    const r2 = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now, zombieGraceMs: 10_000 });
    assert.equal(r2.active.length, 0);
    assert.equal(r2.zombies.length, 1);
  });

  it('AC-A6: threshold injection — overriding freshDraftWindowMs flips fresh → stale (drops to grace)', async () => {
    const now = 10_000_000;
    const record = makeRecord({ id: 'inv-borderline', updatedAt: now - 60_000 });
    const draft = makeDraft({ invocationId: 'inv-borderline', updatedAt: now - 30_000, createdAt: now - 50_000 });
    const deps = makeDeps({ records: [record], drafts: [draft], slots: [] });

    // With default 300s window: draft updatedAt 30s ago is fresh
    const r1 = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });
    assert.equal(r1.active[0].source, 'record+draft');
    assert.equal(r1.active[0].degraded, true);
    assert.equal(r1.active[0].reason, 'record_running_with_fresh_draft');

    // Tighten window to 10s: 30s-old draft no longer fresh, falls into grace → record-only
    const r2 = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now, freshDraftWindowMs: 10_000 });
    assert.equal(r2.active[0].source, 'record-only');
    assert.equal(r2.active[0].reason, 'liveness_pending');
  });
});

describe('F194 getThreadLiveInvocations — guards', () => {
  it('skips records belonging to a different user', async () => {
    const now = 1_000_000;
    const records = [
      makeRecord({ id: 'inv-mine', updatedAt: now - 1_000 }),
      makeRecord({ id: 'inv-theirs', userId: 'other-user', updatedAt: now - 1_000 }),
    ];
    const slots = [{ catId: 'opus', startedAt: now - 500 }];
    const deps = makeDeps({ records, slots, trackerUserIds: { opus: USER_ID } });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(result.active.length, 1);
    assert.equal(result.active[0].invocationId, 'inv-mine');
  });

  it('skips records belonging to a different thread', async () => {
    const now = 1_000_000;
    const records = [
      makeRecord({ id: 'inv-here', updatedAt: now - 1_000 }),
      makeRecord({ id: 'inv-elsewhere', threadId: 'thread-other', updatedAt: now - 1_000 }),
    ];
    const slots = [{ catId: 'opus', startedAt: now - 500 }];
    const deps = makeDeps({ records, slots, trackerUserIds: { opus: USER_ID } });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(result.active.length, 1);
    assert.equal(result.active[0].invocationId, 'inv-here');
  });

  it('does NOT count tracker slot owned by a different user (cross-user collision)', async () => {
    const now = 1_000_000;
    const record = makeRecord({ id: 'inv-x', updatedAt: now - 60_000 });
    const slots = [{ catId: 'opus', startedAt: now - 500 }];
    const deps = makeDeps({ records: [record], slots, trackerUserIds: { opus: 'other-user' } });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    // tracker slot exists but owner mismatch → falls through to grace (no draft) → record-only pending
    assert.equal(result.active.length, 1);
    assert.equal(result.active[0].source, 'record-only');
    assert.equal(result.active[0].reason, 'liveness_pending');
  });

  it('default constants match F194 KD-3/KD-4 spec', () => {
    assert.equal(DEFAULT_FRESH_DRAFT_WINDOW_MS, 300_000, '5-min DraftStore TTL');
    assert.equal(DEFAULT_ZOMBIE_GRACE_MS, 600_000, '2× DraftStore TTL = 10 min');
  });
});

describe('F194 getThreadLiveInvocations — R1 P1-1: record-missing recovery via tracker+draft', () => {
  it('record absent + tracker active + draft fresh (slot.startedAt ≤ draft.createdAt) → active source=tracker+draft', async () => {
    // Scenario: InvocationRecord lookup raced or hadn't been written yet, but the tracker
    // is still holding a slot that started before the draft was first created. F194 spec
    // AC-B5 requires this messages.ts:1400-1406 hotfix3 behavior to be preserved.
    const now = 1_000_000;
    const draft = makeDraft({ invocationId: 'inv-recovery', createdAt: now - 5_000, updatedAt: now - 1_000 });
    const slot = { catId: 'opus', startedAt: now - 6_000 }; // started BEFORE draft.createdAt — anchors to this draft
    const deps = makeDeps({
      records: [], // record absent (race / startup window / lookup miss)
      drafts: [draft],
      slots: [slot],
      trackerUserIds: { opus: USER_ID },
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(result.active.length, 1, 'tracker+draft must produce one active entry');
    assert.equal(result.zombies.length, 0);
    assert.deepEqual(result.active[0], {
      catId: 'opus',
      invocationId: 'inv-recovery',
      startedAt: slot.startedAt,
      source: 'tracker+draft',
      degraded: true,
      reason: 'tracker_active_missing_record',
    });
  });

  it('record absent + tracker active but slot newer than draft.createdAt → drop (orphan)', async () => {
    // The new tracker slot must NOT retroactively claim an older draft — that would resurrect
    // an unrelated invocation's content.
    const now = 1_000_000;
    const draft = makeDraft({ invocationId: 'inv-orphan', createdAt: now - 50_000, updatedAt: now - 1_000 });
    const slot = { catId: 'opus', startedAt: now - 5_000 }; // slot started AFTER draft.createdAt → not associated
    const deps = makeDeps({
      records: [],
      drafts: [draft],
      slots: [slot],
      trackerUserIds: { opus: USER_ID },
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(result.active.length, 0, 'unanchored tracker slot must not surface orphan draft');
    assert.equal(result.zombies.length, 0);
  });

  it('record absent + tracker active but tracker user mismatches → drop', async () => {
    const now = 1_000_000;
    const draft = makeDraft({ invocationId: 'inv-x', createdAt: now - 5_000, updatedAt: now - 1_000 });
    const slot = { catId: 'opus', startedAt: now - 6_000 };
    const deps = makeDeps({
      records: [],
      drafts: [draft],
      slots: [slot],
      trackerUserIds: { opus: 'other-user' }, // tracker owned by someone else
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(result.active.length, 0);
    assert.equal(result.zombies.length, 0);
  });

  it('record absent + draft fresh + NO tracker slot → drop (orphan filter, not tracker+draft)', async () => {
    // Pure draft without any tracker evidence is orphan, not live recovery.
    const now = 1_000_000;
    const draft = makeDraft({ invocationId: 'inv-only-draft', createdAt: now - 5_000, updatedAt: now - 1_000 });
    const deps = makeDeps({
      records: [],
      drafts: [draft],
      slots: [],
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(result.active.length, 0);
    assert.equal(result.zombies.length, 0);
  });
});

describe('F194 getThreadLiveInvocations — R1 P1-2: tracker association guard (cat slot reuse)', () => {
  it('two same-cat running records + tracker slot anchored to one draft → only that one gets record+tracker', async () => {
    // The tracker slot key is (threadId, catId), not invocationId. When the same cat has multiple
    // running records (e.g. old zombie not yet swept + new invocation just started), a fresh slot
    // must NOT retroactively prove the older record. Only the record whose draft anchors the slot
    // (slot.startedAt ≤ draft.createdAt) gets record+tracker; the rest fall through.
    const now = 10_000_000;
    const recordA = makeRecord({
      id: 'inv-A',
      createdAt: now - 100_000,
      updatedAt: now - 60_000,
    });
    const draftA = makeDraft({ invocationId: 'inv-A', createdAt: now - 90_000, updatedAt: now - 100 });
    const recordB = makeRecord({
      id: 'inv-B',
      createdAt: now - 50_000,
      updatedAt: now - 50_000,
    });
    const slot = { catId: 'opus', startedAt: now - 95_000 }; // BEFORE draftA.createdAt → anchors A
    const deps = makeDeps({
      records: [recordA, recordB],
      drafts: [draftA],
      slots: [slot],
      trackerUserIds: { opus: USER_ID },
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(result.active.length, 2);
    const a = result.active.find((s) => s.invocationId === 'inv-A');
    const b = result.active.find((s) => s.invocationId === 'inv-B');
    assert.ok(a, 'A must be in active');
    assert.ok(b, 'B must be in active');
    assert.equal(a.source, 'record+tracker', 'A: anchored to slot via draft → record+tracker');
    assert.notEqual(
      b.source,
      'record+tracker',
      'B: same cat slot must NOT retroactively prove a second running record',
    );
    assert.equal(b.source, 'record-only', 'B falls through to grace pending');
    assert.equal(b.reason, 'liveness_pending');
  });

  it('two same-cat running records + tracker slot newer than any draft → neither gets record+tracker', async () => {
    const now = 10_000_000;
    const recordA = makeRecord({
      id: 'inv-A',
      createdAt: now - 100_000,
      updatedAt: now - 60_000,
    });
    const draftA = makeDraft({ invocationId: 'inv-A', createdAt: now - 90_000, updatedAt: now - 100 });
    const recordB = makeRecord({
      id: 'inv-B',
      createdAt: now - 50_000,
      updatedAt: now - 50_000,
    });
    const slot = { catId: 'opus', startedAt: now - 30_000 }; // newer than draftA.createdAt
    const deps = makeDeps({
      records: [recordA, recordB],
      drafts: [draftA],
      slots: [slot],
      trackerUserIds: { opus: USER_ID },
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    for (const live of result.active) {
      assert.notEqual(
        live.source,
        'record+tracker',
        `${live.invocationId}: unanchored slot must not prove either record`,
      );
    }
    // A still surfaces via record+draft (fresh), B via record-only pending
    const a = result.active.find((s) => s.invocationId === 'inv-A');
    const b = result.active.find((s) => s.invocationId === 'inv-B');
    assert.equal(a?.source, 'record+draft');
    assert.equal(b?.source, 'record-only');
  });

  it('weak association: single running record per cat + tracker slot started after record.createdAt → record+tracker', async () => {
    // The weak path lets the unambiguous single-record case still surface as record+tracker even
    // without a draft. record.createdAt ≤ slot.startedAt rules out reverse-time false positives.
    const now = 1_000_000;
    const record = makeRecord({ id: 'inv-single', createdAt: now - 8_000, updatedAt: now - 8_000 });
    const slot = { catId: 'opus', startedAt: now - 5_000 };
    const deps = makeDeps({
      records: [record],
      slots: [slot],
      trackerUserIds: { opus: USER_ID },
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(result.active.length, 1);
    assert.equal(result.active[0].source, 'record+tracker');
    assert.equal(result.active[0].reason, 'tracker_present');
  });

  it('R2 P1: same-cat zombie record + record-missing tracker+draft coexist → zombie surfaces, draft is tracker+draft', async () => {
    // Failure case 砚砚 surfaced in R2: old single running record (zombie) + new draft-only invocation
    // share a cat. The new draft strongly anchors the slot (slot.startedAt ≤ newDraft.createdAt).
    // Without the R2 P1 cross-check, the zombie record was satisfying the weak association
    // (sameCatRecordCount === 1, record.createdAt ≤ slot.startedAt) and being judged
    // record+tracker — so the same slot was 'proving' two unrelated invocations and the
    // zombie never reached zombies[].
    const now = 10_000_000;
    const oldZombie = makeRecord({
      id: 'inv-old-zombie',
      targetCats: ['opus'],
      createdAt: now - 1_000_000,
      updatedAt: now - DEFAULT_ZOMBIE_GRACE_MS - 100_000, // way past grace, no draft anymore
    });
    const newDraft = makeDraft({
      invocationId: 'inv-new-draft',
      catId: 'opus',
      createdAt: now - 5_000,
      updatedAt: now - 100,
    });
    // Slot started before newDraft.createdAt → strongly anchors new draft, NOT the zombie
    const slot = { catId: 'opus', startedAt: now - 6_000 };
    const deps = makeDeps({
      records: [oldZombie],
      drafts: [newDraft],
      slots: [slot],
      trackerUserIds: { opus: USER_ID },
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    // Old zombie must surface in zombies[] (slot doesn't prove it because the new draft owns it)
    assert.equal(result.zombies.length, 1, 'old zombie must reach zombies[]');
    assert.equal(result.zombies[0].invocationId, 'inv-old-zombie');
    assert.equal(result.zombies[0].reason, 'no_tracker_no_fresh_draft_age_exceeded');

    // Only the new draft should be active (via tracker+draft recovery path)
    assert.equal(result.active.length, 1, 'only the new draft should be active');
    assert.equal(result.active[0].invocationId, 'inv-new-draft');
    assert.equal(result.active[0].source, 'tracker+draft');
    assert.equal(result.active[0].reason, 'tracker_active_missing_record');

    // Hard mutual-exclusion guard: zombie invocationId never appears in active[]
    const zombieIds = new Set(result.zombies.map((z) => z.invocationId));
    for (const live of result.active) {
      assert.equal(zombieIds.has(live.invocationId), false);
    }
  });

  it('R3 P1: reverse ownership — orphan draft owns slot, same-cat record+draft must NOT use record+tracker', async () => {
    // R3 P1 case: a single tracker slot has TWO candidates whose drafts both individually
    // timing-anchor it (slot.startedAt ≤ both draft.createdAt). The earliest-anchored draft is
    // the orphan (record absent); the later candidate has its own record+draft. Pre-R3 fix,
    // the later candidate's strong path saw `slotAssocWithDraft=true` (timing-only) and
    // produced record+tracker, so the same slot proved BOTH invocations. Post-R3, only the
    // owner draft (earliest-anchored) may surface as tracker+draft; the non-owner record+draft
    // must fall back to record+draft fresh path.
    const now = 10_000_000;
    const orphanOwnerDraft = makeDraft({
      invocationId: 'inv-orphan-owner',
      catId: 'opus',
      createdAt: now - 90_000, // earliest-anchored → owns slot
      updatedAt: now - 100,
    });
    const recordLate = makeRecord({
      id: 'inv-record-late',
      targetCats: ['opus'],
      createdAt: now - 50_000,
      updatedAt: now - 30_000,
    });
    const draftLate = makeDraft({
      invocationId: 'inv-record-late',
      catId: 'opus',
      createdAt: now - 85_000, // later than orphan, but slot.startedAt still ≤ this (timing-anchored)
      updatedAt: now - 100,
    });
    // Slot: started before BOTH drafts (timing-anchors both). Earliest claim wins → orphan owns.
    const slot = { catId: 'opus', startedAt: now - 95_000 };
    const deps = makeDeps({
      records: [recordLate],
      drafts: [orphanOwnerDraft, draftLate],
      slots: [slot],
      trackerUserIds: { opus: USER_ID },
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    const orphan = result.active.find((s) => s.invocationId === 'inv-orphan-owner');
    const recordLateLive = result.active.find((s) => s.invocationId === 'inv-record-late');

    assert.ok(orphan, 'orphan (slot owner) must surface as tracker+draft');
    assert.equal(orphan.source, 'tracker+draft');
    assert.equal(orphan.reason, 'tracker_active_missing_record');

    assert.ok(recordLateLive, 'record+late-draft must still be active (via fresh draft fallback)');
    assert.notEqual(
      recordLateLive.source,
      'record+tracker',
      'non-owner record MUST NOT claim tracker-backed source — same slot cannot prove two invocations',
    );
    assert.equal(recordLateLive.source, 'record+draft', 'falls back to fresh-draft path');
    assert.equal(recordLateLive.reason, 'record_running_with_fresh_draft');

    // Hard mutual-exclusion: at most one tracker-backed source per cat slot
    const trackerBacked = result.active.filter((s) => s.source === 'record+tracker' || s.source === 'tracker+draft');
    assert.equal(
      trackerBacked.length,
      1,
      `single slot must back at most one source per cat; got ${trackerBacked.length}: ${JSON.stringify(trackerBacked)}`,
    );
  });

  it('R2 P1: same-cat record + record-missing draft, slot anchors record (not draft) → record+tracker, draft drops', async () => {
    // Symmetric variant: when slot strongly anchors the record's own draft, weak association is
    // not needed; record gets record+tracker via STRONG, and the unrelated record-missing draft
    // (whose anchor is later than slot.startedAt) drops as orphan.
    const now = 10_000_000;
    const recordWithDraft = makeRecord({
      id: 'inv-anchored',
      targetCats: ['opus'],
      createdAt: now - 100_000,
      updatedAt: now - 60_000,
    });
    const ownDraft = makeDraft({
      invocationId: 'inv-anchored',
      catId: 'opus',
      createdAt: now - 90_000,
      updatedAt: now - 100,
    });
    const orphanDraft = makeDraft({
      invocationId: 'inv-orphan-draft',
      catId: 'opus',
      createdAt: now - 50_000,
      updatedAt: now - 100,
    });
    // Slot started before BOTH drafts; the earliest-anchored one (ownDraft) wins ownership
    const slot = { catId: 'opus', startedAt: now - 95_000 };
    const deps = makeDeps({
      records: [recordWithDraft],
      drafts: [ownDraft, orphanDraft],
      slots: [slot],
      trackerUserIds: { opus: USER_ID },
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    // record+tracker for the anchored record; orphan-draft drops because slot is owned by ownDraft
    const anchored = result.active.find((s) => s.invocationId === 'inv-anchored');
    const orphan = result.active.find((s) => s.invocationId === 'inv-orphan-draft');
    assert.ok(anchored, 'anchored record must be active');
    assert.equal(anchored.source, 'record+tracker');
    assert.equal(orphan, undefined, 'orphan draft must NOT surface tracker+draft when slot is owned by another draft');
  });

  it('Cloud R5 P1: stale draft must NOT claim slot ownership and disable a live record’s weak path', async () => {
    // Cloud codex P1: buildSlotClaimedByDraft was admitting any time-anchored draft regardless
    // of freshness. With DraftStore TTL > helper's freshDraftWindowMs (or with freshDraftWindow
    // explicitly tightened), a stale draft could land in slotClaimedByDraft, set
    // slotClaimedByOtherDraft for the real running invocation, and demote a still-live
    // record+tracker to record-only pending.
    const now = 10_000_000;
    // Real running invocation — single record per cat, tracker live, no own draft yet.
    const liveRecord = makeRecord({
      id: 'inv-live',
      targetCats: ['opus'],
      createdAt: now - 1_000,
      updatedAt: now - 500,
    });
    const slot = { catId: 'opus', startedAt: now - 800 };
    // Stale (zombie) draft from a previous, unrelated invocation. Anchor still happens to be
    // earlier than slot.startedAt (could survive even though stale).
    const staleDraft = makeDraft({
      invocationId: 'inv-stale-from-past',
      catId: 'opus',
      createdAt: now - 2_000,
      updatedAt: now - 250_000, // FAR past freshDraftWindowMs (we'll use 30_000)
    });
    const deps = makeDeps({
      records: [liveRecord],
      drafts: [staleDraft],
      slots: [slot],
      trackerUserIds: { opus: USER_ID },
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, {
      now,
      freshDraftWindowMs: 30_000, // tighter than draft.updatedAt age (250_000ms)
    });

    // The stale draft must NOT appear (orphan filter) and MUST NOT block the live record.
    const live = result.active.find((s) => s.invocationId === 'inv-live');
    assert.ok(live, 'live record must remain active');
    assert.equal(
      live.source,
      'record+tracker',
      'live record gets weak record+tracker (single-record-per-cat, no fresh draft contention)',
    );
    assert.equal(live.degraded, false);

    // Stale draft must drop entirely (not appear as tracker+draft either)
    const stale = result.active.find((s) => s.invocationId === 'inv-stale-from-past');
    assert.equal(stale, undefined, 'stale draft must not surface');
  });

  it('Cloud R5 P1: stale draft does NOT block weak path even when slot anchor would otherwise claim ownership', async () => {
    // Variant: stale draft's anchor is earlier than slot.startedAt (would-be slot owner under
    // the old logic). Live record without its own draft should still get record+tracker.
    const now = 10_000_000;
    const liveRecord = makeRecord({
      id: 'inv-live-2',
      targetCats: ['gpt52'],
      createdAt: now - 5_000,
      updatedAt: now - 1_000,
    });
    const slot = { catId: 'gpt52', startedAt: now - 3_000 };
    const staleDraft = makeDraft({
      invocationId: 'inv-old-stale',
      catId: 'gpt52',
      createdAt: now - 10_000, // would be earliest-anchored
      updatedAt: now - 400_000, // way past default freshDraftWindowMs (300_000)
    });
    const deps = makeDeps({
      records: [liveRecord],
      drafts: [staleDraft],
      slots: [slot],
      trackerUserIds: { gpt52: USER_ID },
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    const live = result.active.find((s) => s.invocationId === 'inv-live-2');
    assert.ok(live);
    assert.equal(live.source, 'record+tracker', 'stale draft did not steal slot ownership');
  });

  it('weak association rejected: single record but slot.startedAt < record.createdAt (slot predates record)', async () => {
    // A slot that started before the record was created cannot belong to that record.
    const now = 1_000_000;
    const record = makeRecord({ id: 'inv-late', createdAt: now - 5_000, updatedAt: now - 5_000 });
    const slot = { catId: 'opus', startedAt: now - 8_000 }; // slot is OLDER than record
    const deps = makeDeps({
      records: [record],
      slots: [slot],
      trackerUserIds: { opus: USER_ID },
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    // No draft + no association → falls into record-only pending (record is fresh enough)
    assert.equal(result.active.length, 1);
    assert.equal(result.active[0].source, 'record-only');
    assert.equal(result.active[0].reason, 'liveness_pending');
  });
});
