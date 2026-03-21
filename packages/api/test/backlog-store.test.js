import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('BacklogStore', () => {
  /** @type {import('../dist/domains/cats/services/stores/ports/BacklogStore.js').BacklogStore} */
  let store;
  let originalDateNow;
  let now;

  beforeEach(async () => {
    const { BacklogStore } = await import('../dist/domains/cats/services/stores/ports/BacklogStore.js');
    store = new BacklogStore();
    originalDateNow = Date.now;
    now = 1_700_000_000_000;
    Date.now = () => {
      now += 1;
      return now;
    };
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  test('create + listByUser returns newest first', () => {
    const first = store.create({
      userId: 'default-user',
      title: 'First',
      summary: 'first summary',
      priority: 'p2',
      tags: ['a'],
      createdBy: 'user',
    });
    const second = store.create({
      userId: 'default-user',
      title: 'Second',
      summary: 'second summary',
      priority: 'p1',
      tags: ['b'],
      createdBy: 'user',
    });

    const items = store.listByUser('default-user');
    assert.equal(items.length, 2);
    assert.equal(items[0].id, second.id);
    assert.equal(items[1].id, first.id);
  });

  test('refreshMetadata updates docs-derived fields and appends audit entry', () => {
    const created = store.create({
      userId: 'default-user',
      title: '[F049] Mission Hub',
      summary: '来源 docs/ROADMAP.md | 状态：spec',
      priority: 'p2',
      tags: ['source:docs-backlog', 'feature:f049', 'status:spec'],
      createdBy: 'user',
    });

    const refreshed = store.refreshMetadata(created.id, {
      title: '[F049] Mission Hub (updated)',
      summary: '来源 docs/ROADMAP.md | 状态：in-progress',
      priority: 'p1',
      tags: ['source:docs-backlog', 'feature:f049', 'status:in-progress'],
      refreshedBy: 'default-user',
    });

    assert.equal(refreshed?.title, '[F049] Mission Hub (updated)');
    assert.equal(refreshed?.priority, 'p1');
    assert.equal(refreshed?.tags.includes('status:in-progress'), true);
    assert.equal(refreshed?.audit.at(-1)?.action, 'refreshed');
    assert.equal(refreshed?.audit.at(-1)?.actor.kind, 'user');
    assert.equal(refreshed?.audit.at(-1)?.actor.id, 'default-user');
  });

  test('refreshMetadata is a no-op when metadata is unchanged', () => {
    const created = store.create({
      userId: 'default-user',
      title: '[F010] Mobile',
      summary: '来源 docs/ROADMAP.md | 状态：spec',
      priority: 'p2',
      tags: ['source:docs-backlog', 'feature:f010', 'status:spec'],
      createdBy: 'user',
    });

    const beforeAuditLength = created.audit.length;
    const beforeUpdatedAt = created.updatedAt;
    const refreshed = store.refreshMetadata(created.id, {
      title: '[F010] Mobile',
      summary: '来源 docs/ROADMAP.md | 状态：spec',
      priority: 'p2',
      tags: ['source:docs-backlog', 'feature:f010', 'status:spec'],
      refreshedBy: 'default-user',
    });

    assert.equal(refreshed?.audit.length, beforeAuditLength);
    assert.equal(refreshed?.updatedAt, beforeUpdatedAt);
  });

  test('suggestClaim transitions open -> suggested', () => {
    const created = store.create({
      userId: 'default-user',
      title: 'Refactor queue',
      summary: 'clear pause race',
      priority: 'p1',
      tags: ['queue'],
      createdBy: 'user',
    });

    const suggested = store.suggestClaim(created.id, {
      catId: 'codex',
      why: 'I already touched queue code path',
      plan: 'add guard + tests',
      requestedPhase: 'coding',
    });

    assert.equal(suggested?.status, 'suggested');
    assert.equal(suggested?.suggestion?.catId, 'codex');
    assert.equal(suggested?.suggestion?.requestedPhase, 'coding');
    assert.equal(suggested?.suggestion?.status, 'pending');
  });

  test('approve + markDispatched writes thread linkage', () => {
    const created = store.create({
      userId: 'default-user',
      title: 'Build mission control',
      summary: 'global dispatch center',
      priority: 'p0',
      tags: ['f049'],
      createdBy: 'user',
    });

    store.suggestClaim(created.id, {
      catId: 'opus',
      why: 'Can own architecture',
      plan: 'route + store + UI',
      requestedPhase: 'coding',
    });

    const approved = store.decideClaim(created.id, {
      decision: 'approve',
      decidedBy: 'default-user',
      note: 'go',
    });

    assert.equal(approved?.status, 'approved');
    assert.equal(approved?.suggestion?.status, 'approved');

    const dispatched = store.markDispatched(created.id, {
      threadId: 'thread-123',
      threadPhase: 'coding',
      dispatchedBy: 'default-user',
    });

    assert.equal(dispatched?.status, 'dispatched');
    assert.equal(dispatched?.dispatchedThreadId, 'thread-123');
    assert.equal(dispatched?.dispatchedThreadPhase, 'coding');
  });

  test('reject returns item to open state', () => {
    const created = store.create({
      userId: 'default-user',
      title: 'Research lock semantics',
      summary: 'compare lease patterns',
      priority: 'p2',
      tags: ['research'],
      createdBy: 'user',
    });

    store.suggestClaim(created.id, {
      catId: 'codex',
      why: 'Need to audit race windows',
      plan: 'collect docs',
      requestedPhase: 'research',
    });

    const rejected = store.decideClaim(created.id, {
      decision: 'reject',
      decidedBy: 'default-user',
      note: 'later',
    });

    assert.equal(rejected?.status, 'open');
    assert.equal(rejected?.suggestion?.status, 'rejected');
  });

  test('invalid transition throws deterministic error', () => {
    const created = store.create({
      userId: 'default-user',
      title: 'No suggestion yet',
      summary: 'cannot approve directly',
      priority: 'p3',
      tags: [],
      createdBy: 'user',
    });

    assert.throws(() => {
      store.decideClaim(created.id, {
        decision: 'approve',
        decidedBy: 'default-user',
      });
    }, /invalid backlog transition/i);
  });

  test('markDispatched is idempotent for same dispatched target', () => {
    const created = store.create({
      userId: 'default-user',
      title: 'Idempotent dispatch',
      summary: 'retry should not break state',
      priority: 'p1',
      tags: ['dispatch'],
      createdBy: 'user',
    });

    store.suggestClaim(created.id, {
      catId: 'codex',
      why: 'owns this stack',
      plan: 'dispatch safely',
      requestedPhase: 'coding',
    });
    store.decideClaim(created.id, {
      decision: 'approve',
      decidedBy: 'default-user',
    });

    const first = store.markDispatched(created.id, {
      threadId: 'thread-retry',
      threadPhase: 'coding',
      dispatchedBy: 'default-user',
    });
    assert.equal(first?.status, 'dispatched');

    const second = store.markDispatched(created.id, {
      threadId: 'thread-retry',
      threadPhase: 'coding',
      dispatchedBy: 'default-user',
    });
    assert.equal(second?.status, 'dispatched');
    assert.equal(second?.dispatchedThreadId, 'thread-retry');
    assert.equal(second?.audit.length, first?.audit.length);
  });

  test('updateDispatchProgress stores dispatch metadata on approved item', () => {
    const created = store.create({
      userId: 'default-user',
      title: 'Dispatch metadata',
      summary: 'stores attempt and pending thread id',
      priority: 'p1',
      tags: ['dispatch'],
      createdBy: 'user',
    });

    store.suggestClaim(created.id, {
      catId: 'codex',
      why: 'owns stack',
      plan: 'dispatch with recovery',
      requestedPhase: 'coding',
    });
    store.decideClaim(created.id, {
      decision: 'approve',
      decidedBy: 'default-user',
    });

    const updated = store.updateDispatchProgress(created.id, {
      updatedBy: 'default-user',
      dispatchAttemptId: 'attempt-1',
      pendingThreadId: 'thread-pending-1',
    });

    assert.equal(updated?.status, 'approved');
    assert.equal(updated?.dispatchAttemptId, 'attempt-1');
    assert.equal(updated?.pendingThreadId, 'thread-pending-1');
    assert.equal(updated?.kickoffMessageId, undefined);
  });

  test('markDispatched requires kickoffMessageId and respects pendingThreadId', () => {
    const created = store.create({
      userId: 'default-user',
      title: 'Dispatch guardrails',
      summary: 'requires kickoff and stable thread id',
      priority: 'p1',
      tags: ['dispatch'],
      createdBy: 'user',
    });

    store.suggestClaim(created.id, {
      catId: 'codex',
      why: 'owns stack',
      plan: 'dispatch safely',
      requestedPhase: 'coding',
    });
    store.decideClaim(created.id, {
      decision: 'approve',
      decidedBy: 'default-user',
    });

    store.updateDispatchProgress(created.id, {
      updatedBy: 'default-user',
      dispatchAttemptId: 'attempt-2',
      pendingThreadId: 'thread-pending-2',
    });

    assert.throws(() => {
      store.markDispatched(created.id, {
        threadId: 'thread-pending-2',
        threadPhase: 'coding',
        dispatchedBy: 'default-user',
      });
    }, /kickoff message/i);

    store.updateDispatchProgress(created.id, {
      updatedBy: 'default-user',
      kickoffMessageId: 'msg-kickoff-2',
    });

    assert.throws(() => {
      store.markDispatched(created.id, {
        threadId: 'thread-other',
        threadPhase: 'coding',
        dispatchedBy: 'default-user',
      });
    }, /pending dispatch thread/i);

    const dispatched = store.markDispatched(created.id, {
      threadId: 'thread-pending-2',
      threadPhase: 'coding',
      dispatchedBy: 'default-user',
    });
    assert.equal(dispatched?.status, 'dispatched');
    assert.equal(dispatched?.dispatchAttemptId, 'attempt-2');
    assert.equal(dispatched?.pendingThreadId, 'thread-pending-2');
    assert.equal(dispatched?.kickoffMessageId, 'msg-kickoff-2');
  });

  test('updateDispatchProgress blocks stale writes after item is dispatched', () => {
    const created = store.create({
      userId: 'default-user',
      title: 'Dispatch stale write guard',
      summary: 'blocks stale progress writes once dispatched',
      priority: 'p1',
      tags: ['dispatch'],
      createdBy: 'user',
    });

    store.suggestClaim(created.id, {
      catId: 'codex',
      why: 'owns stack',
      plan: 'dispatch safely',
      requestedPhase: 'coding',
    });
    store.decideClaim(created.id, {
      decision: 'approve',
      decidedBy: 'default-user',
    });

    store.updateDispatchProgress(created.id, {
      updatedBy: 'default-user',
      dispatchAttemptId: 'attempt-stale',
      pendingThreadId: 'thread-a',
      kickoffMessageId: 'msg-a',
    });

    const dispatched = store.markDispatched(created.id, {
      threadId: 'thread-a',
      threadPhase: 'coding',
      dispatchedBy: 'default-user',
    });
    assert.equal(dispatched?.status, 'dispatched');
    assert.equal(dispatched?.pendingThreadId, 'thread-a');

    assert.throws(() => {
      store.updateDispatchProgress(created.id, {
        updatedBy: 'default-user',
        pendingThreadId: 'thread-b',
      });
    }, /dispatch progress requires approved item/i);

    const after = store.get(created.id);
    assert.equal(after?.status, 'dispatched');
    assert.equal(after?.dispatchedThreadId, 'thread-a');
    assert.equal(after?.pendingThreadId, 'thread-a');
  });

  test('eviction prioritizes dispatched items first', () => {
    const BacklogStoreClass = store.constructor;
    const smallStore = new BacklogStoreClass({ maxItems: 2 });

    const dispatchedCandidate = smallStore.create({
      userId: 'default-user',
      title: 'old dispatched',
      summary: 'should be evicted first',
      priority: 'p2',
      tags: [],
      createdBy: 'user',
    });
    smallStore.suggestClaim(dispatchedCandidate.id, {
      catId: 'codex',
      why: 'done',
      plan: 'already shipped',
      requestedPhase: 'coding',
    });
    smallStore.decideClaim(dispatchedCandidate.id, {
      decision: 'approve',
      decidedBy: 'default-user',
    });
    smallStore.markDispatched(dispatchedCandidate.id, {
      threadId: 'thread-old',
      threadPhase: 'coding',
      dispatchedBy: 'default-user',
    });

    const openCandidate = smallStore.create({
      userId: 'default-user',
      title: 'open should stay',
      summary: 'newer active task',
      priority: 'p1',
      tags: [],
      createdBy: 'user',
    });

    const third = smallStore.create({
      userId: 'default-user',
      title: 'new item',
      summary: 'triggers eviction',
      priority: 'p3',
      tags: [],
      createdBy: 'user',
    });

    const remaining = smallStore.listByUser('default-user').map((item) => item.id);
    assert.equal(remaining.includes(dispatchedCandidate.id), false);
    assert.equal(remaining.includes(openCandidate.id), true);
    assert.equal(remaining.includes(third.id), true);
  });

  test('lease lifecycle acquire -> heartbeat -> release', () => {
    const created = store.create({
      userId: 'default-user',
      title: 'Lease lifecycle',
      summary: 'ensure lease transitions are valid',
      priority: 'p1',
      tags: ['lease'],
      createdBy: 'user',
    });

    store.suggestClaim(created.id, {
      catId: 'codex',
      why: 'ready',
      plan: 'dispatch then lease',
      requestedPhase: 'coding',
    });
    store.decideClaim(created.id, {
      decision: 'approve',
      decidedBy: 'default-user',
    });
    store.markDispatched(created.id, {
      threadId: 'thread-lease',
      threadPhase: 'coding',
      dispatchedBy: 'default-user',
    });

    const acquired = store.acquireLease(created.id, {
      catId: 'codex',
      ttlMs: 60_000,
      actorId: 'default-user',
    });
    assert.equal(acquired?.lease?.ownerCatId, 'codex');
    assert.equal(acquired?.lease?.state, 'active');

    const previousExpiresAt = acquired?.lease?.expiresAt ?? 0;
    const heartbeated = store.heartbeatLease(created.id, {
      catId: 'codex',
      ttlMs: 120_000,
      actorId: 'default-user',
    });
    assert.ok((heartbeated?.lease?.expiresAt ?? 0) > previousExpiresAt);

    const released = store.releaseLease(created.id, {
      actorId: 'default-user',
      catId: 'codex',
    });
    assert.equal(released?.lease?.state, 'released');
  });

  test('reclaimExpiredLease reclaims expired lease only', () => {
    const created = store.create({
      userId: 'default-user',
      title: 'Lease reclaim',
      summary: 'reclaim expired lease',
      priority: 'p2',
      tags: ['lease'],
      createdBy: 'user',
    });

    store.suggestClaim(created.id, {
      catId: 'codex',
      why: 'ready',
      plan: 'dispatch then lease',
      requestedPhase: 'coding',
    });
    store.decideClaim(created.id, {
      decision: 'approve',
      decidedBy: 'default-user',
    });
    store.markDispatched(created.id, {
      threadId: 'thread-reclaim',
      threadPhase: 'coding',
      dispatchedBy: 'default-user',
    });

    store.acquireLease(created.id, {
      catId: 'codex',
      ttlMs: 1,
      actorId: 'default-user',
    });
    now += 10_000;

    const reclaimed = store.reclaimExpiredLease(created.id, {
      actorId: 'default-user',
    });
    assert.equal(reclaimed?.lease?.state, 'reclaimed');
  });
});

describe('BacklogStore markDone', () => {
  /** @type {import('../dist/domains/cats/services/stores/ports/BacklogStore.js').BacklogStore} */
  let store;
  let originalDateNow;
  let now;

  beforeEach(async () => {
    const { BacklogStore } = await import('../dist/domains/cats/services/stores/ports/BacklogStore.js');
    store = new BacklogStore();
    originalDateNow = Date.now;
    now = 1_700_000_000_000;
    Date.now = () => now;
  });

  afterEach(() => {
    Date.now = originalDateNow;
  });

  function createAndDispatch() {
    const item = store.create({
      userId: 'u1',
      title: 'T',
      summary: 'S',
      priority: 'p2',
      tags: [],
      createdBy: 'user',
    });
    store.suggestClaim(item.id, { catId: 'claude-opus', why: 'w', plan: 'p', requestedPhase: 'coding' });
    store.decideClaim(item.id, { decision: 'approve', decidedBy: 'u1', note: 'ok' });
    now += 1000;
    store.updateDispatchProgress(item.id, { updatedBy: 'u1', dispatchAttemptId: 'att1' });
    store.updateDispatchProgress(item.id, { updatedBy: 'u1', pendingThreadId: 'th1' });
    store.updateDispatchProgress(item.id, { updatedBy: 'u1', kickoffMessageId: 'msg1' });
    store.markDispatched(item.id, { threadId: 'th1', threadPhase: 'coding', dispatchedBy: 'u1' });
    return item;
  }

  test('transitions dispatched → done', () => {
    const item = createAndDispatch();
    now += 5000;
    const done = store.markDone(item.id, { doneBy: 'u1' });
    assert.strictEqual(done.status, 'done');
    assert.ok(done.doneAt > 0);
    assert.strictEqual(done.audit.at(-1).action, 'done');
    assert.deepStrictEqual(done.audit.at(-1).actor, { kind: 'user', id: 'u1' });
  });

  test('idempotent on already-done item', () => {
    const item = createAndDispatch();
    now += 5000;
    store.markDone(item.id, { doneBy: 'u1' });
    const again = store.markDone(item.id, { doneBy: 'u1' });
    assert.strictEqual(again.status, 'done');
  });

  test('transitions open → done (disappeared feature)', () => {
    const item = store.create({
      userId: 'u1',
      title: 'T',
      summary: 'S',
      priority: 'p2',
      tags: [],
      createdBy: 'user',
    });
    now += 5000;
    const done = store.markDone(item.id, { doneBy: 'u1' });
    assert.strictEqual(done.status, 'done');
    assert.ok(done.doneAt > 0);
    assert.strictEqual(done.audit.at(-1).action, 'done');
  });

  test('transitions suggested → done (disappeared feature)', () => {
    const item = store.create({
      userId: 'u1',
      title: 'T',
      summary: 'S',
      priority: 'p2',
      tags: [],
      createdBy: 'user',
    });
    store.suggestClaim(item.id, { catId: 'claude-opus', why: 'w', plan: 'p', requestedPhase: 'coding' });
    now += 5000;
    const done = store.markDone(item.id, { doneBy: 'u1' });
    assert.strictEqual(done.status, 'done');
    assert.ok(done.doneAt > 0);
  });

  test('transitions approved → done (disappeared feature)', () => {
    const item = store.create({
      userId: 'u1',
      title: 'T',
      summary: 'S',
      priority: 'p2',
      tags: [],
      createdBy: 'user',
    });
    store.suggestClaim(item.id, { catId: 'claude-opus', why: 'w', plan: 'p', requestedPhase: 'coding' });
    store.decideClaim(item.id, { decision: 'approve', decidedBy: 'u1', note: 'ok' });
    now += 5000;
    const done = store.markDone(item.id, { doneBy: 'u1' });
    assert.strictEqual(done.status, 'done');
    assert.ok(done.doneAt > 0);
  });

  test('returns null for missing item', () => {
    assert.strictEqual(store.markDone('nonexistent', { doneBy: 'u1' }), null);
  });

  test('create with dependencies preserves them', () => {
    const item = store.create({
      userId: 'u1',
      title: 'T',
      summary: 'S',
      priority: 'p2',
      tags: [],
      createdBy: 'user',
      dependencies: { evolvedFrom: ['f049'], related: ['f037'] },
    });
    assert.deepStrictEqual(item.dependencies, { evolvedFrom: ['f049'], related: ['f037'] });
  });

  test('refreshMetadata with dependencies updates them', () => {
    const item = store.create({
      userId: 'u1',
      title: 'T',
      summary: 'S',
      priority: 'p2',
      tags: [],
      createdBy: 'user',
    });
    const refreshed = store.refreshMetadata(item.id, {
      title: 'T2',
      summary: 'S',
      priority: 'p2',
      tags: [],
      refreshedBy: 'u1',
      dependencies: { blockedBy: ['f052'] },
    });
    assert.deepStrictEqual(refreshed.dependencies, { blockedBy: ['f052'] });
  });

  test('refreshMetadata triggers refresh when only dependencies change', () => {
    const item = store.create({
      userId: 'u1',
      title: 'Same',
      summary: 'Same',
      priority: 'p2',
      tags: ['a'],
      createdBy: 'user',
      dependencies: { blockedBy: ['f001'] },
    });
    const beforeAuditLength = item.audit.length;
    const refreshed = store.refreshMetadata(item.id, {
      title: 'Same',
      summary: 'Same',
      priority: 'p2',
      tags: ['a'],
      refreshedBy: 'u1',
      dependencies: { blockedBy: ['f001', 'f002'] },
    });
    assert.notEqual(refreshed.audit.length, beforeAuditLength, 'should append audit entry');
    assert.deepStrictEqual(refreshed.dependencies, { blockedBy: ['f001', 'f002'] });
  });

  test('refreshMetadata is no-op when dependencies are identical', () => {
    const item = store.create({
      userId: 'u1',
      title: 'Same',
      summary: 'Same',
      priority: 'p2',
      tags: [],
      createdBy: 'user',
      dependencies: { related: ['f010'] },
    });
    const beforeAuditLength = item.audit.length;
    const beforeUpdatedAt = item.updatedAt;
    const refreshed = store.refreshMetadata(item.id, {
      title: 'Same',
      summary: 'Same',
      priority: 'p2',
      tags: [],
      refreshedBy: 'u1',
      dependencies: { related: ['f010'] },
    });
    assert.equal(refreshed.audit.length, beforeAuditLength, 'should not append audit entry');
    assert.equal(refreshed.updatedAt, beforeUpdatedAt, 'should not update timestamp');
  });
});

describe('BacklogStore create with initialStatus=done', () => {
  /** @type {import('../dist/domains/cats/services/stores/ports/BacklogStore.js').BacklogStore} */
  let store;

  beforeEach(async () => {
    const { BacklogStore } = await import('../dist/domains/cats/services/stores/ports/BacklogStore.js');
    store = new BacklogStore();
  });

  test('sets doneAt and done audit entry when initialStatus is done', () => {
    const item = store.create({
      userId: 'u1',
      title: 'Historical done',
      summary: 'S',
      priority: 'p2',
      tags: ['feature:f010'],
      createdBy: 'user',
      initialStatus: 'done',
    });
    assert.equal(item.status, 'done');
    assert.ok(item.doneAt, 'doneAt should be set');
    assert.equal(typeof item.doneAt, 'number');
    // Should have both 'created' and 'done' audit entries
    const actions = item.audit.map((a) => a.action);
    assert.ok(actions.includes('created'), 'should have created audit');
    assert.ok(actions.includes('done'), 'should have done audit');
  });

  test('does not set doneAt when initialStatus is not done', () => {
    const item = store.create({
      userId: 'u1',
      title: 'Active item',
      summary: 'S',
      priority: 'p2',
      tags: [],
      createdBy: 'user',
      initialStatus: 'dispatched',
    });
    assert.equal(item.status, 'dispatched');
    assert.equal(item.doneAt, undefined);
  });
});

describe('BacklogStore atomicDispatch', () => {
  let BacklogStore;

  beforeEach(async () => {
    ({ BacklogStore } = await import('../dist/domains/cats/services/stores/ports/BacklogStore.js'));
  });

  function makeApproved(store) {
    const item = store.create({
      userId: 'u1',
      title: 'T',
      summary: 'S',
      priority: 'p2',
      tags: [],
      createdBy: 'user',
    });
    store.suggestClaim(item.id, { catId: 'claude-opus', why: 'w', plan: 'p', requestedPhase: 'coding' });
    store.decideClaim(item.id, { decision: 'approve', decidedBy: 'u1' });
    return store.get(item.id);
  }

  test('atomicDispatch transitions approved → dispatched in one call', () => {
    const store = new BacklogStore();
    const item = makeApproved(store);
    const result = store.atomicDispatch(item.id, {
      dispatchAttemptId: 'attempt-1',
      pendingThreadId: 'thread-1',
      kickoffMessageId: 'msg-1',
      threadId: 'thread-1',
      threadPhase: 'coding',
      dispatchedBy: 'u1',
    });
    assert.ok(result);
    assert.equal(result.status, 'dispatched');
    assert.equal(result.dispatchAttemptId, 'attempt-1');
    assert.equal(result.pendingThreadId, 'thread-1');
    assert.equal(result.kickoffMessageId, 'msg-1');
    assert.equal(result.dispatchedThreadId, 'thread-1');
    assert.equal(result.dispatchedThreadPhase, 'coding');
    assert.ok(result.dispatchedAt > 0);
    assert.equal(result.audit.at(-1).action, 'dispatched');
  });

  test('atomicDispatch rejects non-approved item', () => {
    const store = new BacklogStore();
    const item = store.create({
      userId: 'u1',
      title: 'T',
      summary: 'S',
      priority: 'p2',
      tags: [],
      createdBy: 'user',
    });
    assert.throws(
      () =>
        store.atomicDispatch(item.id, {
          dispatchAttemptId: 'a1',
          pendingThreadId: 't1',
          kickoffMessageId: 'm1',
          threadId: 't1',
          threadPhase: 'coding',
          dispatchedBy: 'u1',
        }),
      /Invalid backlog transition/,
    );
  });

  test('atomicDispatch is idempotent for same thread', () => {
    const store = new BacklogStore();
    const item = makeApproved(store);
    const input = {
      dispatchAttemptId: 'a1',
      pendingThreadId: 't1',
      kickoffMessageId: 'm1',
      threadId: 't1',
      threadPhase: 'coding',
      dispatchedBy: 'u1',
    };
    const first = store.atomicDispatch(item.id, input);
    const second = store.atomicDispatch(item.id, input);
    assert.equal(first.id, second.id);
    assert.equal(second.status, 'dispatched');
  });

  test('atomicDispatch rejects dispatch to different thread', () => {
    const store = new BacklogStore();
    const item = makeApproved(store);
    store.atomicDispatch(item.id, {
      dispatchAttemptId: 'a1',
      pendingThreadId: 't1',
      kickoffMessageId: 'm1',
      threadId: 't1',
      threadPhase: 'coding',
      dispatchedBy: 'u1',
    });
    assert.throws(
      () =>
        store.atomicDispatch(item.id, {
          dispatchAttemptId: 'a2',
          pendingThreadId: 't2',
          kickoffMessageId: 'm2',
          threadId: 't2',
          threadPhase: 'coding',
          dispatchedBy: 'u1',
        }),
      /already dispatched to another thread/,
    );
  });

  test('atomicDispatch returns null for missing item', () => {
    const store = new BacklogStore();
    const result = store.atomicDispatch('nonexistent', {
      dispatchAttemptId: 'a1',
      pendingThreadId: 't1',
      kickoffMessageId: 'm1',
      threadId: 't1',
      threadPhase: 'coding',
      dispatchedBy: 'u1',
    });
    assert.equal(result, null);
  });
});
