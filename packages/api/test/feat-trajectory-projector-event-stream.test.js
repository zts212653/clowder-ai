/**
 * F233 Phase C C2a step 3 — FeatTrajectoryProjector.applyBallCustodyEvent 测试
 *
 * 砚砚 KD-C6 step 2 review advisory #1 + #2 钉死：
 *   #1 conservative mapping — unmappable ball-custody kinds skip, no entry created
 *   #2 single-feat contract — same sourceEventId only invests in one feat;
 *      upsert idempotent within same featId
 *
 * node:test，import dist。
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  FeatTrajectoryProjector,
  mapBallCustodyEventToTrajectory,
} from '../dist/domains/feat-trajectory/FeatTrajectoryProjector.js';
import { InMemoryFeatTrajectoryStore } from '../dist/domains/feat-trajectory/FeatTrajectoryStore.js';

function makeEvent({ kind, payload = {}, at = 1_700_000_000_000, sourceEventId = `src:${kind}:${at}` } = {}) {
  return {
    sourceEventId,
    subjectKey: 'ball:thread:thr-1',
    kind,
    classification: 'state-changing',
    payload,
    at,
  };
}

describe('FeatTrajectoryProjector — applyBallCustodyEvent (event-stream source)', () => {
  let store;
  let projector;

  beforeEach(() => {
    store = new InMemoryFeatTrajectoryStore();
    projector = new FeatTrajectoryProjector(store);
  });

  describe('Conservative mapping (砚砚 step 3 advisory #1)', () => {
    it('mapper: ball.handed_cvo intent=done_notify → "closed"', () => {
      const event = makeEvent({ kind: 'ball.handed_cvo', payload: { intent: 'done_notify' } });
      assert.strictEqual(mapBallCustodyEventToTrajectory(event), 'closed');
    });

    it('mapper: ball.handed_cvo intent=handoff → null (skip; handoff ≠ feat close)', () => {
      const event = makeEvent({ kind: 'ball.handed_cvo', payload: { intent: 'handoff' } });
      assert.strictEqual(mapBallCustodyEventToTrajectory(event), null);
    });

    it('mapper: ball.handed_cvo intent=fyi → null (skip)', () => {
      const event = makeEvent({ kind: 'ball.handed_cvo', payload: { intent: 'fyi' } });
      assert.strictEqual(mapBallCustodyEventToTrajectory(event), null);
    });

    it('mapper: 15 other Phase B+C ball-custody kinds → null (conservative skip)', () => {
      // Phase B 13 kinds + Phase C 3 euthanasia kinds（已扩到 16）。剔除已映射的 ball.handed_cvo。
      const unmappedKinds = [
        'ball.handed',
        'ball.void_pass',
        'ball.held',
        'ball.hold_expired',
        'invocation.started',
        'invocation.heartbeat',
        'invocation.died',
        'task.blocked',
        'task.unblocked',
        'task.idle_long',
        'task.done',
        'ball.wake_sent',
        'ball.frozen',
        'ball.degraded',
        'ball.abandoned',
      ];
      for (const kind of unmappedKinds) {
        const event = makeEvent({ kind });
        assert.strictEqual(
          mapBallCustodyEventToTrajectory(event),
          null,
          `${kind} should be unmapped (conservative skip) until explicit feat-level rule`,
        );
      }
    });

    it('apply: unmappable event → no projection created (skip path 不污染 store)', async () => {
      const event = makeEvent({ kind: 'task.done', payload: { taskId: 't1' } });
      await projector.applyBallCustodyEvent(event, 'F233');
      const proj = await store.get('F233');
      assert.strictEqual(proj, null, 'unmappable event should not create projection');
    });
  });

  describe('Upsert + single-feat contract (砚砚 step 3 advisory #2)', () => {
    it('mappable event creates trajectory entry with evt:{sourceEventId} id', async () => {
      const event = makeEvent({
        kind: 'ball.handed_cvo',
        payload: { intent: 'done_notify' },
        sourceEventId: 'route:msg-123:cvo',
      });
      await projector.applyBallCustodyEvent(event, 'F233');
      const proj = await store.get('F233');
      assert.ok(proj, 'projection should be created');
      assert.strictEqual(proj.entries.length, 1);
      assert.strictEqual(proj.entries[0].entryId, 'evt:route:msg-123:cvo');
      assert.strictEqual(proj.entries[0].kind, 'closed');
      assert.strictEqual(proj.entries[0].source, 'event-stream');
      assert.strictEqual(proj.entries[0].featId, 'F233');
      assert.strictEqual(proj.entries[0].subjectKey, 'feat:F233');
      assert.strictEqual(proj.appliedEntryCount, 1);
      assert.strictEqual(proj.countsBySource['event-stream'], 1);
      assert.strictEqual(proj.countsByKind.closed, 1);
    });

    it('upsert idempotency: same event applied twice → 1 entry, counts unchanged', async () => {
      const event = makeEvent({
        kind: 'ball.handed_cvo',
        payload: { intent: 'done_notify' },
        sourceEventId: 'route:msg-456:cvo',
      });
      await projector.applyBallCustodyEvent(event, 'F233');
      await projector.applyBallCustodyEvent(event, 'F233');
      const proj = await store.get('F233');
      assert.strictEqual(proj.entries.length, 1, 'idempotent upsert: 同 sourceEventId 不产生重复 entry');
      assert.strictEqual(proj.appliedEntryCount, 1, 'counts not double-incremented on upsert');
      assert.strictEqual(proj.countsBySource['event-stream'], 1);
    });

    it('different sourceEventId for same featId → multiple entries, sorted by at ascending', async () => {
      const event1 = makeEvent({
        kind: 'ball.handed_cvo',
        payload: { intent: 'done_notify' },
        sourceEventId: 'route:msg-A:cvo',
        at: 2_000,
      });
      const event2 = makeEvent({
        kind: 'ball.handed_cvo',
        payload: { intent: 'done_notify' },
        sourceEventId: 'route:msg-B:cvo',
        at: 1_000, // earlier
      });
      await projector.applyBallCustodyEvent(event1, 'F233');
      await projector.applyBallCustodyEvent(event2, 'F233');
      const proj = await store.get('F233');
      assert.strictEqual(proj.entries.length, 2);
      // Sorted ascending by at
      assert.strictEqual(proj.entries[0].at, 1_000);
      assert.strictEqual(proj.entries[1].at, 2_000);
    });

    it('single-feat contract: same sourceEventId across different featIds → separate per-feat projections (per-feat isolation)', async () => {
      // 砚砚 advisory #2: 同 event 投到不同 featId 的情况，contract 默认 single-feat,
      // 调用方（collector）必须保证。Projector 不做 cross-feat dedup，所以两 featId
      // 各自有独立 projection，每个含 1 entry with same entryId。这是 per-feat
      // isolation 的副作用，不是 multi-feat contract。
      const event = makeEvent({
        kind: 'ball.handed_cvo',
        payload: { intent: 'done_notify' },
        sourceEventId: 'route:msg-shared:cvo',
      });
      await projector.applyBallCustodyEvent(event, 'F233');
      await projector.applyBallCustodyEvent(event, 'F188');
      const proj233 = await store.get('F233');
      const proj188 = await store.get('F188');
      assert.strictEqual(proj233.entries.length, 1);
      assert.strictEqual(proj188.entries.length, 1);
      // Same entryId in both, but per-feat isolation means projection.featId differs
      assert.strictEqual(proj233.entries[0].entryId, proj188.entries[0].entryId);
      assert.strictEqual(proj233.entries[0].featId, 'F233');
      assert.strictEqual(proj188.entries[0].featId, 'F188');
      // Contract: collector responsible to enforce single-feat; projector trusts caller.
    });
  });

  describe('updatedAt monotonic max (砚砚 step 4 前护栏)', () => {
    it('out-of-order apply: 后到 earlier event → updatedAt 不倒退（monotonic max）', async () => {
      // Apply later event first
      const eventLate = makeEvent({
        kind: 'ball.handed_cvo',
        payload: { intent: 'done_notify' },
        sourceEventId: 'route:msg-late:cvo',
        at: 2_000,
      });
      // Then apply earlier event
      const eventEarly = makeEvent({
        kind: 'ball.handed_cvo',
        payload: { intent: 'done_notify' },
        sourceEventId: 'route:msg-early:cvo',
        at: 1_000,
      });

      await projector.applyBallCustodyEvent(eventLate, 'F233');
      const projAfterLate = await store.get('F233');
      assert.strictEqual(projAfterLate.updatedAt, 2_000);

      await projector.applyBallCustodyEvent(eventEarly, 'F233');
      const projAfterEarly = await store.get('F233');
      // updatedAt 不倒退 (monotonic max: 仍是 2000 不是 1000)
      assert.strictEqual(
        projAfterEarly.updatedAt,
        2_000,
        'updatedAt must not regress when earlier-at event arrives after later-at event (monotonic max)',
      );
      // entries 按 at sorted ascending (1000, 2000)
      assert.strictEqual(projAfterEarly.entries[0].at, 1_000);
      assert.strictEqual(projAfterEarly.entries[1].at, 2_000);
    });
  });

  describe('Rebuild safety (INV-2)', () => {
    it('replay same events → same projection (Phase B rebuild-safe pattern)', async () => {
      const events = [
        makeEvent({
          kind: 'ball.handed_cvo',
          payload: { intent: 'done_notify' },
          sourceEventId: 'route:msg-1:cvo',
          at: 1_000,
        }),
        makeEvent({
          kind: 'task.done', // unmapped, will skip
          payload: { taskId: 't1' },
          sourceEventId: 'task:t1:done',
          at: 1_500,
        }),
        makeEvent({
          kind: 'ball.handed_cvo',
          payload: { intent: 'done_notify' },
          sourceEventId: 'route:msg-2:cvo',
          at: 2_000,
        }),
      ];

      // First pass
      for (const e of events) await projector.applyBallCustodyEvent(e, 'F233');
      const projFirst = await store.get('F233');

      // Wipe and replay
      await store.delete('F233');
      for (const e of events) await projector.applyBallCustodyEvent(e, 'F233');
      const projReplay = await store.get('F233');

      // Compare structurally (excluding createdAt/updatedAt timestamps which depend
      // on first event.at — should be equal since same events)
      assert.deepStrictEqual(projReplay.entries, projFirst.entries, 'replay entries identical');
      assert.strictEqual(projReplay.appliedEntryCount, projFirst.appliedEntryCount);
      assert.deepStrictEqual(projReplay.countsBySource, projFirst.countsBySource);
      assert.deepStrictEqual(projReplay.countsByKind, projFirst.countsByKind);
    });
  });
});
