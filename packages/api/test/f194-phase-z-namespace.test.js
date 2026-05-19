/**
 * F194 Phase Z — namespace-aware canonical read model RED tests.
 *
 * 砚砚 R1 拍板（2026-05-09）+ R1 P1 三条修正：
 *   - parent recordStore invocation（routes/messages.ts:695 创建，整条 multi-cat 链共享）
 *   - per-cat-turn registry invocation（invoke-single-cat.ts:300 创建，drafts 用它做 invocationId）
 *   - 两个 namespace 不能合并 stamping（A 风险大），不能 hotfix rule（C 治标）
 *   - helper 走结构化 dep：getTurnInvocation + getLatestTurnInvocationId
 *
 * 测试覆盖 AC-Z2 四类场景（α/β/γ/δ）。所有测试现在应该 RED——helper 还没加 namespace
 * dep，会把 parent 当 record-only/pending、child 当 tracker+draft no-record，结果裂成
 * 两个 ghost identity。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getThreadLiveInvocations } from '../dist/domains/cats/services/agents/invocation/getThreadLiveInvocations.js';

const THREAD_ID = 'thread-z';
const USER_ID = 'user-z';

function makeRecord(overrides = {}) {
  const now = overrides.updatedAt ?? Date.now();
  return {
    id: overrides.id ?? 'parent-1',
    threadId: overrides.threadId ?? THREAD_ID,
    userId: overrides.userId ?? USER_ID,
    userMessageId: overrides.userMessageId ?? 'msg-1',
    targetCats: overrides.targetCats ?? ['opus'],
    intent: overrides.intent ?? 'execute',
    status: overrides.status ?? 'running',
    idempotencyKey: overrides.idempotencyKey ?? 'idem-z',
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
    invocationId: overrides.invocationId ?? 'child-1',
    catId: overrides.catId ?? 'opus',
    content: overrides.content ?? 'streaming...',
    createdAt: overrides.createdAt ?? updatedAt,
    updatedAt,
  };
}

/**
 * @param {object} opts
 * @param {Array} [opts.records] - parent records (recordStore namespace)
 * @param {Array} [opts.drafts] - drafts with child registry invocationId
 * @param {Array} [opts.slots] - tracker slots {catId, startedAt}
 * @param {Record<string, string>} [opts.trackerUserIds] - {catId: userId}
 * @param {Record<string, {parentInvocationId?: string, threadId: string, catId: string, createdAt: number}>} [opts.turnInvocations]
 *        - registry namespace: child invocationId → {parentInvocationId, threadId, catId, createdAt}
 * @param {Record<string, string>} [opts.latestTurnByCat] - {`${threadId}:${catId}`: latestChildInvocationId}
 */
function makeDeps({
  records = [],
  drafts = [],
  slots = [],
  trackerUserIds = {},
  turnInvocations = {},
  latestTurnByCat = {},
} = {}) {
  return {
    listRunningRecords: () => records,
    getDrafts: () => drafts,
    getActiveSlots: () => slots,
    getTrackerUserId: (_t, catId) => trackerUserIds[catId] ?? null,
    // Phase Z new deps (砚砚 R1 P1-1: 结构化 not boolean)
    getTurnInvocation: (childInvocationId) => turnInvocations[childInvocationId] ?? null,
    getLatestTurnInvocationId: (threadId, catId) => latestTurnByCat[`${threadId}:${catId}`] ?? null,
  };
}

describe('F194 Phase Z — namespace-aware (parent recordStore vs child registry)', () => {
  it('Z2-α: parent running + child fresh draft + tracker present → 1 active source=parent+child+tracker, startedAt=child turn createdAt', async () => {
    // Mirrors runtime thread_moxnb78ckc36xhga: parent 98d2949c (running 4min) + child a58a8757 (fresh draft) + tracker slot present.
    // Pre-Phase-Z: helper saw 2 ghost identities (parent record-only/pending + child tracker+draft no-record),
    // queue dedup picked earliest startedAt = parent.updatedAt → bubble split (slot timer stale, content fresh).
    const now = 1_000_000;
    const parentId = 'parent-1';
    const childId = 'child-1';
    const childCreatedAt = now - 50_000;
    const record = makeRecord({ id: parentId, updatedAt: now - 60_000, createdAt: now - 60_000 });
    const draft = makeDraft({ invocationId: childId, catId: 'opus', updatedAt: now - 100, createdAt: childCreatedAt });
    const slot = { catId: 'opus', startedAt: now - 40_000 };
    const deps = makeDeps({
      records: [record],
      drafts: [draft],
      slots: [slot],
      trackerUserIds: { opus: USER_ID },
      turnInvocations: {
        [childId]: {
          parentInvocationId: parentId,
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'opus',
          createdAt: childCreatedAt,
        },
      },
      latestTurnByCat: { [`${THREAD_ID}:opus`]: childId },
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    // After fix: 1 active per (thread, cat). Parent record + child draft + tracker = same execution chain.
    assert.equal(result.active.length, 1, 'must collapse parent + child to 1 active per (thread, cat)');
    assert.equal(result.zombies.length, 0, 'no zombie when parent has live child draft');
    const live = result.active[0];
    assert.equal(live.catId, 'opus');
    assert.equal(live.source, 'parent+child+tracker', 'source must reflect namespace bridge with tracker present');
    assert.equal(live.degraded, false);
    assert.equal(
      live.startedAt,
      childCreatedAt,
      'startedAt must come from child turn createdAt, NOT parent.updatedAt (was the runtime split symptom)',
    );
  });

  it('Z2-β: parent running + child fresh draft + tracker missing → 1 degraded active source=parent+child-draft (live not lost)', async () => {
    // 砚砚 R1 P1-2: tracker 丢了不能漏 live。parent + mapped child fresh draft 仍是合法 in-flight chain.
    const now = 1_000_000;
    const parentId = 'parent-2';
    const childId = 'child-2';
    const childCreatedAt = now - 30_000;
    const record = makeRecord({ id: parentId, updatedAt: now - 60_000, createdAt: now - 60_000 });
    const draft = makeDraft({ invocationId: childId, catId: 'opus', updatedAt: now - 100, createdAt: childCreatedAt });
    const deps = makeDeps({
      records: [record],
      drafts: [draft],
      slots: [], // ← tracker missing
      turnInvocations: {
        [childId]: {
          parentInvocationId: parentId,
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'opus',
          createdAt: childCreatedAt,
        },
      },
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(result.active.length, 1, 'tracker missing must not drop live execution chain');
    assert.equal(result.zombies.length, 0);
    const live = result.active[0];
    assert.equal(live.catId, 'opus');
    assert.equal(live.source, 'parent+child-draft', 'source reflects degraded path (no tracker)');
    assert.equal(live.degraded, true);
    assert.equal(live.startedAt, childCreatedAt, 'startedAt still from child turn');
  });

  it('Z2-γ: parent running + no child draft + cat slot reused by other parent → suppress ghost + zombie candidate', async () => {
    // Old parent's chain dead — cat slot让位 to a new parent; old parent has no own child draft.
    // Without Phase Z: helper sees old parent as record-only/pending, /queue surfaces old parent.startedAt → split.
    // With Phase Z: helper suppresses old parent from active (cat-slot reused signal), outputs as zombie candidate
    // for reconcile (砚砚 R1 P1-3: helper does NOT 擅自 terminal-ize, just suppress + zombie list).
    const now = 1_000_000;
    const oldParentId = 'old-parent';
    const newParentId = 'new-parent';
    const newChildId = 'new-child';
    const oldRecord = makeRecord({ id: oldParentId, updatedAt: now - 100_000, createdAt: now - 100_000 });
    // Cloud R2 P1: cat-slot reuse signal must be a CURRENT fresh draft from another parent,
    // not just historical latest pointer. Add new-parent's record + fresh draft so this fixture
    // reflects the real "actively reused" runtime scenario.
    const newRecord = makeRecord({
      id: newParentId,
      updatedAt: now - 6_000,
      createdAt: now - 6_000,
      targetCats: ['opus'],
    });
    const newDraft = makeDraft({
      invocationId: newChildId,
      catId: 'opus',
      updatedAt: now - 100,
      createdAt: now - 5_000,
    });
    const deps = makeDeps({
      records: [oldRecord, newRecord],
      drafts: [newDraft], // ← cloud R2 P1: new-parent currently has fresh opus draft
      slots: [{ catId: 'opus', startedAt: now - 5_000 }], // tracker slot present (held by new turn)
      trackerUserIds: { opus: USER_ID },
      turnInvocations: {
        [newChildId]: {
          parentInvocationId: newParentId,
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'opus',
          createdAt: now - 5_000,
        },
      },
      latestTurnByCat: { [`${THREAD_ID}:opus`]: newChildId }, // ← latest turn belongs to OTHER parent
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    // new-parent's active surfaces (legitimate live chain); old-parent suppressed from active
    assert.equal(result.active.length, 1, 'new-parent live chain remains active');
    assert.equal(result.active[0].invocationId, newChildId, 'active is new-parent child, not old');
    // Output as zombie candidate so reconcileZombies / producer can decide failed vs succeeded
    assert.equal(result.zombies.length, 1, 'old parent surfaces as zombie candidate');
    const z = result.zombies[0];
    assert.equal(z.invocationId, oldParentId);
    assert.equal(z.catId, 'opus');
    // Reason should signal cat-slot reuse so reconcile path / monitors can distinguish from age-based zombie
    assert.match(
      z.reason,
      /cat_slot_reused|namespace/,
      'zombie reason must indicate cat-slot reuse / namespace signal (not age-based)',
    );
  });

  it('Z2-δ: parallel multi-cat — same parent, 2 child drafts (opus + codex), each tracker slot present → 2 actives, no inter-cat suppression', async () => {
    // 砚砚 R1 P2: route-parallel 也要测。parallel chain 单 parent record + multiple child drafts in
    // different cats. helper must output one active per cat, both linked to same parent.
    const now = 1_000_000;
    const parentId = 'parent-parallel';
    const opusChildId = 'child-opus';
    const codexChildId = 'child-codex';
    const opusCreatedAt = now - 30_000;
    const codexCreatedAt = now - 25_000;
    const record = makeRecord({
      id: parentId,
      updatedAt: now - 60_000,
      createdAt: now - 60_000,
      targetCats: ['opus', 'codex'],
    });
    const opusDraft = makeDraft({
      invocationId: opusChildId,
      catId: 'opus',
      updatedAt: now - 100,
      createdAt: opusCreatedAt,
    });
    const codexDraft = makeDraft({
      invocationId: codexChildId,
      catId: 'codex',
      updatedAt: now - 100,
      createdAt: codexCreatedAt,
    });
    const deps = makeDeps({
      records: [record],
      drafts: [opusDraft, codexDraft],
      slots: [
        { catId: 'opus', startedAt: now - 40_000 },
        { catId: 'codex', startedAt: now - 35_000 },
      ],
      trackerUserIds: { opus: USER_ID, codex: USER_ID },
      turnInvocations: {
        [opusChildId]: {
          parentInvocationId: parentId,
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'opus',
          createdAt: opusCreatedAt,
        },
        [codexChildId]: {
          parentInvocationId: parentId,
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'codex',
          createdAt: codexCreatedAt,
        },
      },
      latestTurnByCat: { [`${THREAD_ID}:opus`]: opusChildId, [`${THREAD_ID}:codex`]: codexChildId },
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(result.active.length, 2, 'each cat in parallel chain must have its own live entry');
    assert.equal(result.zombies.length, 0);
    const byCatId = new Map(result.active.map((a) => [a.catId, a]));
    assert.ok(byCatId.has('opus'));
    assert.ok(byCatId.has('codex'));
    assert.equal(byCatId.get('opus').source, 'parent+child+tracker');
    assert.equal(byCatId.get('codex').source, 'parent+child+tracker');
    assert.equal(byCatId.get('opus').startedAt, opusCreatedAt);
    assert.equal(byCatId.get('codex').startedAt, codexCreatedAt);
  });

  it('R3 P2-1: parent + child fresh draft + tracker slot exists but owned by OTHER user → degraded parent+child-draft (NOT healthy parent+child+tracker)', async () => {
    // Default/system thread + cross-user tracker collision: tracker.getActiveSlots returns a slot
    // for opus, but getTrackerUserId says it belongs to user-B. For our user-A's parent+child
    // chain, that slot must NOT be treated as ours — surface as degraded `parent+child-draft`.
    const now = 1_000_000;
    const parentId = 'parent-cross-tracker';
    const childId = 'child-cross-tracker';
    const childCreatedAt = now - 30_000;
    const record = makeRecord({ id: parentId, updatedAt: now - 60_000, createdAt: now - 60_000 });
    const draft = makeDraft({ invocationId: childId, catId: 'opus', updatedAt: now - 100, createdAt: childCreatedAt });
    const deps = makeDeps({
      records: [record],
      drafts: [draft],
      slots: [{ catId: 'opus', startedAt: now - 40_000 }], // ← slot exists
      trackerUserIds: { opus: 'other-user' }, // ← but owned by other user
      turnInvocations: {
        [childId]: {
          parentInvocationId: parentId,
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'opus',
          createdAt: childCreatedAt,
        },
      },
      latestTurnByCat: { [`${THREAD_ID}:opus`]: childId },
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(result.active.length, 1);
    const live = result.active[0];
    assert.equal(live.source, 'parent+child-draft', 'cross-user tracker must NOT count as healthy tracker (R3 P2-1)');
    assert.equal(live.degraded, true);
  });

  it('R2 P1-B: cross-user isolation — latest turn belongs to OTHER user → no zombie misclassification (default/system thread guard)', async () => {
    // Default/system thread is public; getLatestId(threadId, catId) has no user dimension.
    // Without user guard, our parent (user-A) could be misclassified as zombie when the latest
    // turn for catId belongs to user-B.
    const now = 1_000_000;
    const myParentId = 'my-parent';
    const otherUserChildId = 'other-user-child';
    const myRecord = makeRecord({
      id: myParentId,
      updatedAt: now - 100_000,
      createdAt: now - 100_000,
      userId: USER_ID,
    });
    const deps = makeDeps({
      records: [myRecord],
      drafts: [],
      slots: [{ catId: 'opus', startedAt: now - 5_000 }],
      trackerUserIds: { opus: USER_ID },
      // latest turn belongs to OTHER user — must not zombie-classify our parent
      turnInvocations: {
        [otherUserChildId]: {
          parentInvocationId: 'other-user-parent',
          threadId: THREAD_ID,
          userId: 'other-user', // ← cross-user
          catId: 'opus',
          createdAt: now - 5_000,
        },
      },
      latestTurnByCat: { [`${THREAD_ID}:opus`]: otherUserChildId },
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(
      result.zombies.length,
      0,
      'must NOT zombie-classify when cat slot belongs to a different user (P1-B isolation)',
    );
  });

  it('R2 P1-C: same parent + same cat + multiple child drafts → latest pointer wins (NOT earliest, NOT newest fallback)', async () => {
    // Edge case: cleanup edge case left two fresh child drafts under same parent + cat.
    // Pre-fix: earliest createdAt won → re-surfaced stale child as live slot.
    // Fix: registry latest pointer is canonical "current turn" → wins over both newest and earliest.
    const now = 1_000_000;
    const parentId = 'parent-multi';
    const oldChildId = 'old-child';
    const newChildId = 'new-child';
    const oldChildCreatedAt = now - 80_000;
    const newChildCreatedAt = now - 30_000;
    const record = makeRecord({ id: parentId, updatedAt: now - 100_000, createdAt: now - 100_000 });
    const oldDraft = makeDraft({
      invocationId: oldChildId,
      catId: 'opus',
      updatedAt: now - 100,
      createdAt: oldChildCreatedAt,
    });
    const newDraft = makeDraft({
      invocationId: newChildId,
      catId: 'opus',
      updatedAt: now - 100,
      createdAt: newChildCreatedAt,
    });
    const deps = makeDeps({
      records: [record],
      drafts: [oldDraft, newDraft],
      slots: [{ catId: 'opus', startedAt: now - 90_000 }],
      trackerUserIds: { opus: USER_ID },
      turnInvocations: {
        [oldChildId]: {
          parentInvocationId: parentId,
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'opus',
          createdAt: oldChildCreatedAt,
        },
        [newChildId]: {
          parentInvocationId: parentId,
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'opus',
          createdAt: newChildCreatedAt,
        },
      },
      latestTurnByCat: { [`${THREAD_ID}:opus`]: newChildId }, // ← registry says new is latest
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(result.active.length, 1, 'one slot per cat after dedup');
    const live = result.active[0];
    assert.equal(live.invocationId, newChildId, 'must pick latest pointer winner, NOT earliest (was stale-replay bug)');
    assert.equal(live.startedAt, newChildCreatedAt);
  });

  it('R2 P1-C fallback: latest pointer absent → newest createdAt wins (NOT earliest)', async () => {
    const now = 1_000_000;
    const parentId = 'parent-no-latest';
    const oldChildId = 'older-child';
    const newChildId = 'newer-child';
    const record = makeRecord({ id: parentId, updatedAt: now - 100_000, createdAt: now - 100_000 });
    const oldDraft = makeDraft({
      invocationId: oldChildId,
      catId: 'opus',
      updatedAt: now - 100,
      createdAt: now - 80_000,
    });
    const newDraft = makeDraft({
      invocationId: newChildId,
      catId: 'opus',
      updatedAt: now - 100,
      createdAt: now - 30_000,
    });
    const deps = makeDeps({
      records: [record],
      drafts: [oldDraft, newDraft],
      slots: [{ catId: 'opus', startedAt: now - 90_000 }],
      trackerUserIds: { opus: USER_ID },
      turnInvocations: {
        [oldChildId]: {
          parentInvocationId: parentId,
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'opus',
          createdAt: now - 80_000,
        },
        [newChildId]: {
          parentInvocationId: parentId,
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'opus',
          createdAt: now - 30_000,
        },
      },
      // No latest pointer — fallback to newest createdAt
      latestTurnByCat: {},
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(result.active.length, 1);
    assert.equal(result.active[0].invocationId, newChildId, 'fallback must pick newest createdAt, not earliest');
  });

  it('R2 P2: namespace pass emits diagnostic events (parent+child-draft degraded + cat-slot reuse zombie)', async () => {
    const now = 1_000_000;
    const events = [];
    const onLog = (e) => events.push(e);

    // Scenario A: parent + child draft + tracker missing → degraded → emit liveness_degraded
    const parentId = 'parent-emit';
    const childId = 'child-emit';
    const childCreatedAt = now - 30_000;
    const record = makeRecord({ id: parentId, updatedAt: now - 60_000, createdAt: now - 60_000 });
    const draft = makeDraft({ invocationId: childId, catId: 'opus', updatedAt: now - 100, createdAt: childCreatedAt });
    const deps = {
      ...makeDeps({
        records: [record],
        drafts: [draft],
        slots: [], // ← tracker missing → degraded
        turnInvocations: {
          [childId]: {
            parentInvocationId: parentId,
            threadId: THREAD_ID,
            userId: USER_ID,
            catId: 'opus',
            createdAt: childCreatedAt,
          },
        },
      }),
      onLog,
    };

    await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    const degradedEvent = events.find((e) => e.kind === 'liveness_degraded' && e.source === 'parent+child-draft');
    assert.ok(degradedEvent, 'parent+child-draft degraded must emit liveness_degraded event');
    assert.equal(degradedEvent.invocationId, childId);
    assert.equal(degradedEvent.reason, 'namespace_chain_degraded');
    // Cloud R5 P2: tracker is missing in this fixture → trackerSlotPresent must be false
    assert.equal(
      degradedEvent.trackerSlotPresent,
      false,
      'tracker missing → trackerSlotPresent must be false (actual physical state)',
    );
  });

  it('Cloud R5 P2: degraded event trackerSlotPresent reflects actual physical state — tracker present but cross-user → degraded with trackerSlotPresent=true', async () => {
    // Cloud R5 P2 (PR #1614 commit e2b967d2a): emitNamespaceLiveEvent hardcoded
    // trackerSlotPresent: false for every degraded entry. But degraded path also fires when
    // tracker slot exists but is owned by another user (R3 P2-1 cross-user guard). In that case
    // emitting `false` makes monitoring/alerting misclassify ownership-collision as tracker-loss.
    const now = 1_000_000;
    const events = [];
    const onLog = (e) => events.push(e);
    const OTHER_USER = 'user-other';

    const parentId = 'parent-cross-user-emit';
    const childId = 'child-cross-user-emit';
    const childCreatedAt = now - 30_000;
    const record = makeRecord({ id: parentId, updatedAt: now - 60_000, createdAt: now - 60_000 });
    const draft = makeDraft({ invocationId: childId, catId: 'opus', updatedAt: now - 100, createdAt: childCreatedAt });
    const deps = {
      ...makeDeps({
        records: [record],
        drafts: [draft],
        slots: [{ catId: 'opus', startedAt: now - 5_000 }], // ← tracker slot PRESENT
        trackerUserIds: { opus: OTHER_USER }, // ← but owned by OTHER user
        turnInvocations: {
          [childId]: {
            parentInvocationId: parentId,
            threadId: THREAD_ID,
            userId: USER_ID,
            catId: 'opus',
            createdAt: childCreatedAt,
          },
        },
      }),
      onLog,
    };

    await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    const degradedEvent = events.find((e) => e.kind === 'liveness_degraded' && e.source === 'parent+child-draft');
    assert.ok(degradedEvent, 'cross-user tracker slot must emit degraded event for our parent+child');
    // Cloud R5 P2: tracker slot physically EXISTS (just owned by other user) → must report true
    assert.equal(
      degradedEvent.trackerSlotPresent,
      true,
      'tracker slot physically present (cross-user) → trackerSlotPresent must be true (not hardcoded false)',
    );
  });

  it('R2 P2: cat-slot reuse zombie emits record_zombie_detected event with namespace reason', async () => {
    const now = 1_000_000;
    const events = [];
    const onLog = (e) => events.push(e);

    const oldParentId = 'old-parent-emit';
    const newParentId = 'new-parent-emit';
    const newChildId = 'new-child-emit';
    const oldRecord = makeRecord({ id: oldParentId, updatedAt: now - 100_000, createdAt: now - 100_000 });
    // Cloud R2 P1: include new-parent's record + fresh draft so cat-slot reuse signal is current.
    const newRecord = makeRecord({
      id: newParentId,
      updatedAt: now - 6_000,
      createdAt: now - 6_000,
      targetCats: ['opus'],
    });
    const newDraft = makeDraft({
      invocationId: newChildId,
      catId: 'opus',
      updatedAt: now - 100,
      createdAt: now - 5_000,
    });
    const deps = {
      ...makeDeps({
        records: [oldRecord, newRecord],
        drafts: [newDraft],
        slots: [{ catId: 'opus', startedAt: now - 5_000 }],
        trackerUserIds: { opus: USER_ID },
        turnInvocations: {
          [newChildId]: {
            parentInvocationId: newParentId,
            threadId: THREAD_ID,
            userId: USER_ID,
            catId: 'opus',
            createdAt: now - 5_000,
          },
        },
        latestTurnByCat: { [`${THREAD_ID}:opus`]: newChildId },
      }),
      onLog,
    };

    await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    const zombieEvent = events.find(
      (e) => e.kind === 'record_zombie_detected' && e.reason === 'cat_slot_reused_no_self_draft',
    );
    assert.ok(zombieEvent, 'cat-slot reuse zombie must emit record_zombie_detected with namespace reason');
    assert.equal(zombieEvent.invocationId, oldParentId);
    assert.equal(zombieEvent.catId, 'opus');
    // Cloud R4 P2: tracker slot present in this fixture → trackerSlotPresent must be true.
    assert.equal(
      zombieEvent.trackerSlotPresent,
      true,
      'tracker slot is in fixture → trackerSlotPresent must be true (not hardcoded — actual state)',
    );
  });

  it('Cloud R4 P2: zombie event trackerSlotPresent must reflect actual tracker state (false when tracker missing)', async () => {
    // Cloud R4 P2 (PR #1614 commit 747e6c770): emit hardcoded `trackerSlotPresent: true` skews
    // monitoring/alerting. Now that detectCatSlotReuseZombie classifies via fresh drafts only
    // (no tracker dependency), the event must report actual tracker state.
    const now = 1_000_000;
    const events = [];
    const onLog = (e) => events.push(e);

    const oldParentId = 'old-parent-no-tracker';
    const newParentId = 'new-parent-no-tracker';
    const newChildId = 'new-child-no-tracker';
    const oldRecord = makeRecord({ id: oldParentId, updatedAt: now - 100_000, createdAt: now - 100_000 });
    const newRecord = makeRecord({
      id: newParentId,
      updatedAt: now - 6_000,
      createdAt: now - 6_000,
      targetCats: ['opus'],
    });
    const newDraft = makeDraft({
      invocationId: newChildId,
      catId: 'opus',
      updatedAt: now - 100,
      createdAt: now - 5_000,
    });
    const deps = {
      ...makeDeps({
        records: [oldRecord, newRecord],
        drafts: [newDraft],
        slots: [], // ← tracker slot MISSING (degraded state)
        trackerUserIds: {},
        turnInvocations: {
          [newChildId]: {
            parentInvocationId: newParentId,
            threadId: THREAD_ID,
            userId: USER_ID,
            catId: 'opus',
            createdAt: now - 5_000,
          },
        },
        latestTurnByCat: { [`${THREAD_ID}:opus`]: newChildId },
      }),
      onLog,
    };

    await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    const zombieEvent = events.find((e) => e.kind === 'record_zombie_detected' && e.invocationId === oldParentId);
    assert.ok(zombieEvent, 'old parent must surface as zombie event');
    assert.equal(
      zombieEvent.trackerSlotPresent,
      false,
      'tracker missing → trackerSlotPresent must be false (cloud R4 P2: not hardcoded true)',
    );
  });

  it('R4 P1 (Z2-ε): cross-parent same-cat — two running parents each with fresh child, latest=newChild → only new active, old surfaces as zombie cat-slot reused', async () => {
    // 砚砚 R4 P1 退回（spec line 207：不同 parent 但同 catId 时取 latest turn 的 parent）。
    // 反例：oldParent + newParent 都 running、各有 fresh opus child draft、registry latest 指向 newChild。
    // R3 实现只在同 parent 内 selectChildPerCat → oldParent 的 oldChild 仍输出 active，
    // queue dedup 取最早 startedAt 让 oldChild 重新赢回 slot → 旧气泡复发。
    // 修法：selectChildPerCat 跨 parent 也消费 latest pointer，oldParent 的 cat 槽位被新 parent 占用 → zombie。
    const now = 1_000_000;
    const oldParentId = 'old-parent-r4';
    const newParentId = 'new-parent-r4';
    const oldChildId = 'old-child-r4';
    const newChildId = 'new-child-r4';
    const oldChildCreatedAt = now - 50_000;
    const newChildCreatedAt = now - 10_000;
    const oldRecord = makeRecord({ id: oldParentId, updatedAt: now - 60_000, createdAt: now - 60_000 });
    const newRecord = makeRecord({ id: newParentId, updatedAt: now - 20_000, createdAt: now - 20_000 });
    const oldDraft = makeDraft({
      invocationId: oldChildId,
      catId: 'opus',
      updatedAt: now - 100,
      createdAt: oldChildCreatedAt,
    });
    const newDraft = makeDraft({
      invocationId: newChildId,
      catId: 'opus',
      updatedAt: now - 50,
      createdAt: newChildCreatedAt,
    });
    const deps = makeDeps({
      records: [oldRecord, newRecord],
      drafts: [oldDraft, newDraft],
      slots: [{ catId: 'opus', startedAt: now - 8_000 }], // tracker held by latest turn
      trackerUserIds: { opus: USER_ID },
      turnInvocations: {
        [oldChildId]: {
          parentInvocationId: oldParentId,
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'opus',
          createdAt: oldChildCreatedAt,
        },
        [newChildId]: {
          parentInvocationId: newParentId,
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'opus',
          createdAt: newChildCreatedAt,
        },
      },
      latestTurnByCat: { [`${THREAD_ID}:opus`]: newChildId }, // ← latest = new
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    assert.equal(result.active.length, 1, 'cross-parent same-cat: only latest wins (spec line 207)');
    const live = result.active[0];
    assert.equal(live.invocationId, newChildId, 'must keep latest child invocationId');
    assert.equal(live.catId, 'opus');
    assert.equal(
      live.startedAt,
      newChildCreatedAt,
      'startedAt = new child createdAt (NOT old child createdAt — was the regression hole)',
    );

    // Old parent surfaces as zombie: cat slot reused by new parent's child
    assert.equal(result.zombies.length, 1, 'old parent must surface as zombie when its cat slot is reused');
    const z = result.zombies[0];
    assert.equal(z.invocationId, oldParentId, 'zombie targets old parent record (lifecycle SoT)');
    assert.equal(z.catId, 'opus');
    assert.match(
      z.reason,
      /cat_slot_reused|namespace/,
      'zombie reason must indicate cat-slot reuse / namespace signal',
    );
  });

  it('R4 P1 (Z2-ε): no latest pointer fallback — when registry latest is absent, multiple same-cat children fall back to newest createdAt (no spurious suppression)', async () => {
    // Defensive: if registry latest pointer is missing for a cat (degenerate state),
    // selectChildPerCat must NOT suppress everything. Fall back to newest createdAt as before R3 P1-C.
    const now = 1_000_000;
    const oldParentId = 'old-parent-r4-fb';
    const newParentId = 'new-parent-r4-fb';
    const oldChildId = 'old-child-r4-fb';
    const newChildId = 'new-child-r4-fb';
    const oldChildCreatedAt = now - 50_000;
    const newChildCreatedAt = now - 10_000;
    const oldRecord = makeRecord({ id: oldParentId, updatedAt: now - 60_000, createdAt: now - 60_000 });
    const newRecord = makeRecord({ id: newParentId, updatedAt: now - 20_000, createdAt: now - 20_000 });
    const oldDraft = makeDraft({
      invocationId: oldChildId,
      catId: 'opus',
      updatedAt: now - 100,
      createdAt: oldChildCreatedAt,
    });
    const newDraft = makeDraft({
      invocationId: newChildId,
      catId: 'opus',
      updatedAt: now - 50,
      createdAt: newChildCreatedAt,
    });
    const deps = makeDeps({
      records: [oldRecord, newRecord],
      drafts: [oldDraft, newDraft],
      slots: [{ catId: 'opus', startedAt: now - 8_000 }],
      trackerUserIds: { opus: USER_ID },
      turnInvocations: {
        [oldChildId]: {
          parentInvocationId: oldParentId,
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'opus',
          createdAt: oldChildCreatedAt,
        },
        [newChildId]: {
          parentInvocationId: newParentId,
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'opus',
          createdAt: newChildCreatedAt,
        },
      },
      // ← intentionally NO latestTurnByCat (registry latest pointer absent)
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    // Without latest pointer, fall back to newest createdAt rule: newChild wins
    assert.equal(result.active.length, 1, 'no latest pointer: dedup falls back to newest createdAt');
    assert.equal(result.active[0].invocationId, newChildId, 'newer createdAt wins fallback');
    // Old parent zombie via cat-slot reuse (latest absent path)
    // Note: detectCatSlotReuseZombie requires getLatestTurnInvocationId to return a value;
    // when absent, this corner case may surface neither active nor zombie for old parent.
    // We don't assert on zombie here — the focus of this test is "fallback newest, not suppress all".
  });

  it('R5 P1: cross-parent dedup must NOT zombie a parent that still has another winning child cat (multi-cat parent partial reuse)', async () => {
    // 砚砚 R5 P1 退回：cross-parent dedup 把"单 cat slot 输"误升级成"整 parent zombie"。
    // 反例：oldParent 是 multi-cat 链 [opus, codex]，newParent 只有 opus。
    // latest(opus) = new-opus, latest(codex) = old-codex.
    // R4 实现：opus dedup → old-opus 输 → buildLoserZombie(oldParent, opus) → zombies=[oldParent].
    // 结果 reconcileZombies 把 oldParent 整条标 failed，连同 old-codex 还活着的 child。
    // 修法：dedup 输家先当 child/cat slot suppressed；按 parent 聚合，只有当 parent 没有任何
    // winning child 时才 zombie。
    const now = 1_000_000;
    const oldParentId = 'old-parent-r5';
    const newParentId = 'new-parent-r5';
    const oldOpusChildId = 'old-opus-r5';
    const oldCodexChildId = 'old-codex-r5';
    const newOpusChildId = 'new-opus-r5';
    const oldOpusCreatedAt = now - 50_000;
    const oldCodexCreatedAt = now - 45_000;
    const newOpusCreatedAt = now - 10_000;
    const oldRecord = makeRecord({
      id: oldParentId,
      updatedAt: now - 60_000,
      createdAt: now - 60_000,
      targetCats: ['opus', 'codex'],
    });
    const newRecord = makeRecord({
      id: newParentId,
      updatedAt: now - 20_000,
      createdAt: now - 20_000,
      targetCats: ['opus'],
    });
    const oldOpusDraft = makeDraft({
      invocationId: oldOpusChildId,
      catId: 'opus',
      updatedAt: now - 300,
      createdAt: oldOpusCreatedAt,
    });
    const oldCodexDraft = makeDraft({
      invocationId: oldCodexChildId,
      catId: 'codex',
      updatedAt: now - 200,
      createdAt: oldCodexCreatedAt,
    });
    const newOpusDraft = makeDraft({
      invocationId: newOpusChildId,
      catId: 'opus',
      updatedAt: now - 50,
      createdAt: newOpusCreatedAt,
    });
    const deps = makeDeps({
      records: [oldRecord, newRecord],
      drafts: [oldOpusDraft, oldCodexDraft, newOpusDraft],
      slots: [
        { catId: 'opus', startedAt: now - 8_000 },
        { catId: 'codex', startedAt: now - 40_000 },
      ],
      trackerUserIds: { opus: USER_ID, codex: USER_ID },
      turnInvocations: {
        [oldOpusChildId]: {
          parentInvocationId: oldParentId,
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'opus',
          createdAt: oldOpusCreatedAt,
        },
        [oldCodexChildId]: {
          parentInvocationId: oldParentId,
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'codex',
          createdAt: oldCodexCreatedAt,
        },
        [newOpusChildId]: {
          parentInvocationId: newParentId,
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'opus',
          createdAt: newOpusCreatedAt,
        },
      },
      latestTurnByCat: {
        [`${THREAD_ID}:opus`]: newOpusChildId,
        [`${THREAD_ID}:codex`]: oldCodexChildId,
      },
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    // active = [new-opus, old-codex] — 两条都活
    assert.equal(result.active.length, 2, 'must keep both winning live entries (new-opus + old-codex)');
    const byCatId = new Map(result.active.map((a) => [a.catId, a]));
    assert.equal(byCatId.get('opus')?.invocationId, newOpusChildId, 'opus winner = new (latest pointer)');
    assert.equal(byCatId.get('codex')?.invocationId, oldCodexChildId, 'codex winner = old (latest pointer for codex)');

    // oldParent 不能被 zombie 因为它的 codex child 仍然 active
    assert.equal(
      result.zombies.length,
      0,
      'oldParent has winning codex child → must NOT zombie just because opus slot was reused',
    );
  });

  it('R5 P1: cross-parent dedup zombies the parent only when ALL its cats lose (true cat-slot reuse, no surviving child)', async () => {
    // 配套测试：当 parent 所有 child 都跨 parent 输给别人时（真正的 cat slot reuse 全死），
    // 才 emit 一个 parent-level zombie；多个输 cat 也只 emit 一个 zombie（dedup by parent）。
    const now = 1_000_000;
    const oldParentId = 'old-parent-r5-all-lose';
    const newOpusParentId = 'new-opus-parent';
    const newCodexParentId = 'new-codex-parent';
    const oldOpusChildId = 'old-opus-all-lose';
    const oldCodexChildId = 'old-codex-all-lose';
    const newOpusChildId = 'new-opus-all-lose';
    const newCodexChildId = 'new-codex-all-lose';
    const oldOpus = now - 50_000;
    const oldCodex = now - 45_000;
    const newOpus = now - 10_000;
    const newCodex = now - 8_000;
    const oldRecord = makeRecord({
      id: oldParentId,
      updatedAt: now - 60_000,
      createdAt: now - 60_000,
      targetCats: ['opus', 'codex'],
    });
    const newOpusRecord = makeRecord({
      id: newOpusParentId,
      updatedAt: now - 20_000,
      createdAt: now - 20_000,
      targetCats: ['opus'],
    });
    const newCodexRecord = makeRecord({
      id: newCodexParentId,
      updatedAt: now - 18_000,
      createdAt: now - 18_000,
      targetCats: ['codex'],
    });
    const deps = makeDeps({
      records: [oldRecord, newOpusRecord, newCodexRecord],
      drafts: [
        makeDraft({ invocationId: oldOpusChildId, catId: 'opus', updatedAt: now - 300, createdAt: oldOpus }),
        makeDraft({ invocationId: oldCodexChildId, catId: 'codex', updatedAt: now - 200, createdAt: oldCodex }),
        makeDraft({ invocationId: newOpusChildId, catId: 'opus', updatedAt: now - 50, createdAt: newOpus }),
        makeDraft({ invocationId: newCodexChildId, catId: 'codex', updatedAt: now - 30, createdAt: newCodex }),
      ],
      slots: [
        { catId: 'opus', startedAt: now - 8_000 },
        { catId: 'codex', startedAt: now - 6_000 },
      ],
      trackerUserIds: { opus: USER_ID, codex: USER_ID },
      turnInvocations: {
        [oldOpusChildId]: {
          parentInvocationId: oldParentId,
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'opus',
          createdAt: oldOpus,
        },
        [oldCodexChildId]: {
          parentInvocationId: oldParentId,
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'codex',
          createdAt: oldCodex,
        },
        [newOpusChildId]: {
          parentInvocationId: newOpusParentId,
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'opus',
          createdAt: newOpus,
        },
        [newCodexChildId]: {
          parentInvocationId: newCodexParentId,
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'codex',
          createdAt: newCodex,
        },
      },
      latestTurnByCat: {
        [`${THREAD_ID}:opus`]: newOpusChildId,
        [`${THREAD_ID}:codex`]: newCodexChildId,
      },
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    // active = [new-opus, new-codex] — 两条都新 parent 的赢家
    assert.equal(result.active.length, 2);
    const liveIds = new Set(result.active.map((a) => a.invocationId));
    assert.ok(liveIds.has(newOpusChildId));
    assert.ok(liveIds.has(newCodexChildId));

    // oldParent 所有 cat 都输 → zombie 一次（按 parent dedup，不重复 emit per-cat）
    const oldParentZombies = result.zombies.filter((z) => z.invocationId === oldParentId);
    assert.equal(oldParentZombies.length, 1, 'parent zombie deduplicated to 1 even when multiple cats lose');
    assert.match(oldParentZombies[0].reason, /cat_slot_reused/);
  });

  it('Cloud R2 P1: historical latest pointer alone must NOT trigger zombie — legitimate gap (no fresh draft for other parent)', async () => {
    // Cloud codex R2 P1 (PR #1614 commit 02c25a177): detectCatSlotReuseZombie 只看 latest pointer
    // (historical) 不验证 cat slot 当前是否真被另一 live turn 占用。在合法间隙（current chain 还没
    // 产 fresh child draft 之前 / serial multi-cat 两 turn 之间）会误触发 → reconcileZombies 把
    // in-flight invocation 提前 flip failed。
    // 反例：parent X running, no fresh children. latestTurnByCat[opus] = old historical turn from
    // old-other-parent. 但 old-other-parent 现在没活 child draft for opus（也已 done/expired）.
    // R5+cloud P1 实现：latestTurn.parentInvocationId !== parent.id → 立刻 zombie.
    // 期望（cloud R2 修法后）：要求另一 parent 当前真有 fresh draft for this cat → 仅历史指针不够。
    const now = 1_000_000;
    const parentXId = 'parent-x-running';
    const oldHistoricalTurnId = 'old-historical-turn';
    const parentXRecord = makeRecord({
      id: parentXId,
      updatedAt: now - 30_000, // running 30s, in legitimate gap before next cat draft
      createdAt: now - 30_000,
      targetCats: ['opus'],
    });
    const deps = makeDeps({
      records: [parentXRecord],
      drafts: [], // ← parent X has no fresh children yet (gap)
      slots: [], // ← no tracker slot for opus
      trackerUserIds: {},
      turnInvocations: {
        [oldHistoricalTurnId]: {
          parentInvocationId: 'old-other-parent', // historical, not running anymore
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'opus',
          createdAt: now - 500_000, // 500s ago — historical, not currently active
        },
      },
      latestTurnByCat: { [`${THREAD_ID}:opus`]: oldHistoricalTurnId }, // ← historical pointer
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    // Parent X must NOT be zombied just because historical latest pointer differs.
    // No other parent has a fresh draft for opus → cat slot is NOT actively reused.
    // Parent X may surface as legacy zombie via age-based grace (default 60s) on next pass,
    // but namespace path must not bypass legacy grace.
    const namespaceZombies = result.zombies.filter(
      (z) => z.invocationId === parentXId && z.reason === 'cat_slot_reused_no_self_draft',
    );
    assert.equal(
      namespaceZombies.length,
      0,
      'historical latest pointer alone must NOT trigger namespace cat-slot-reuse zombie (cloud R2 P1)',
    );
  });

  it("Cloud P1: detectCatSlotReuseZombie must check ALL parent.targetCats — multi-cat parent's non-first cat slot reuse", async () => {
    // Cloud codex P1 (PR #1614): detectCatSlotReuseZombie 只查 parent.targetCats[0]，
    // multi-cat parent 第二/三只 cat 的 slot 被 reuse 漏检。
    // 反例：oldParent.targetCats=['opus','codex']，没活 children；newParent 占了 codex slot，
    // opus slot 没人占（latest opus 未定义）。R5 实现：
    //   targetCats[0]='opus' → getLatestTurnInvocationId('opus')=null → return null（漏检）
    // 结果 oldParent 既不在 active 也不在 zombies，可能 fall through legacy 然后被错处理。
    const now = 1_000_000;
    const oldParentId = 'old-multi-cat-parent';
    const newCodexChildId = 'new-codex-multi';
    const newCodexParentId = 'new-codex-parent';
    const oldRecord = makeRecord({
      id: oldParentId,
      updatedAt: now - 100_000,
      createdAt: now - 100_000,
      targetCats: ['opus', 'codex'], // ← multi-cat parent
    });
    // Cloud R2 P1: include new-codex-parent's record + fresh codex draft (not just historical latest)
    const newCodexRecord = makeRecord({
      id: newCodexParentId,
      updatedAt: now - 6_000,
      createdAt: now - 6_000,
      targetCats: ['codex'],
    });
    const newCodexDraft = makeDraft({
      invocationId: newCodexChildId,
      catId: 'codex',
      updatedAt: now - 100,
      createdAt: now - 5_000,
    });
    const deps = makeDeps({
      records: [oldRecord, newCodexRecord],
      drafts: [newCodexDraft], // ← cloud R2 P1: new-codex-parent has current fresh draft
      slots: [{ catId: 'codex', startedAt: now - 5_000 }],
      trackerUserIds: { codex: USER_ID },
      turnInvocations: {
        [newCodexChildId]: {
          parentInvocationId: newCodexParentId,
          threadId: THREAD_ID,
          userId: USER_ID,
          catId: 'codex',
          createdAt: now - 5_000,
        },
      },
      latestTurnByCat: {
        // ← only codex has latest pointer (opus slot empty)
        [`${THREAD_ID}:codex`]: newCodexChildId,
      },
    });

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    // new-codex-parent live chain surfaces; old multi-cat parent suppressed
    assert.equal(result.active.length, 1, 'new-codex-parent live chain in active');
    assert.equal(result.active[0].catId, 'codex');
    assert.equal(
      result.zombies.length,
      1,
      'multi-cat parent must be zombied when ANY of its target cats has slot reused (cloud P1)',
    );
    const z = result.zombies[0];
    assert.equal(z.invocationId, oldParentId);
    // catId 字段反映触发 zombie 的 cat（任意被 reuse 的 cat 即可，不强制要求 codex）
    assert.match(z.reason, /cat_slot_reused/);
  });

  it('Phase A/B backward compat: helper still works when new namespace deps are absent (legacy callers)', async () => {
    // Phase A/B existing tests don't pass getTurnInvocation/getLatestTurnInvocationId.
    // Helper must keep working — fall back to existing record/draft/tracker matching by invocationId.
    const now = 1_000_000;
    const record = makeRecord({ id: 'inv-legacy', updatedAt: now - 60_000 });
    const draft = makeDraft({
      invocationId: 'inv-legacy',
      catId: 'opus',
      updatedAt: now - 100,
      createdAt: now - 50_000,
    });
    const deps = {
      listRunningRecords: () => [record],
      getDrafts: () => [draft],
      getActiveSlots: () => [],
      getTrackerUserId: () => null,
      // intentionally NO getTurnInvocation / getLatestTurnInvocationId
    };

    const result = await getThreadLiveInvocations(THREAD_ID, USER_ID, deps, { now });

    // Same record.id and draft.invocationId — legacy single-namespace path; helper should still classify as record+draft active
    assert.equal(result.active.length, 1);
    assert.equal(result.active[0].invocationId, 'inv-legacy');
    assert.equal(result.active[0].source, 'record+draft');
  });
});
