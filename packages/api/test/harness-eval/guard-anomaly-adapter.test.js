/**
 * F257 V2/Phase B — guard-anomaly friction adapter (5th channel) + stats.
 *
 * Contract under test:
 * - manual_observation notes referencing a registered pot ledgerId produce
 *   deterministic FrictionSignals (idempotent id: guard-anomaly:<eventId>#<ledgerId>)
 * - condition_hit events and non-referencing notes are excluded
 * - pagination followed to exhaustion (never silently truncated)
 * - pull is READ-ONLY (F245 KD-4) — no stats mutation from the adapter
 * - GuardLedgerStats: SADD idempotency (dedup replay never double-counts)
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { GuardAnomalyAdapter } from '../../dist/infrastructure/harness-eval/friction/guard-anomaly-adapter.js';
import { extractLedgerRefs, GuardLedgerStats } from '../../dist/infrastructure/harness-eval/guard-ledger-registry.js';

const T = 1700000000000;

function manualEvent(over = {}) {
  return {
    kind: 'manual_observation',
    eventId: `dev-${over.seq ?? 1}`,
    timestamp: T,
    registryVersion: 'none',
    incidentKey: `ik-${over.seq ?? 1}`,
    ownerUserId: 'default-user',
    attributions: [{ objectiveId: 'obj-x', unitRefs: [{ unitType: 'segment', unitId: 'S1' }], weight: 1 }],
    anchors: { threadId: 'thread_a' },
    subjectCatId: 'codex',
    source: 'self',
    note: 'hit a 429; rejection said [ledger: mcp/hold-ball-rate-limit]',
    sourceAnchor: { kind: 'thread_message', messageId: 'm1' },
    recordedBy: 'codex',
    ...over,
  };
}

function fakeLog(pages) {
  const calls = [];
  return {
    calls,
    async query(input) {
      calls.push(input);
      return pages[calls.length - 1] ?? { events: [], nextCursor: null };
    },
  };
}

describe('GuardAnomalyAdapter — 5th friction channel', () => {
  test('extracts one signal per referenced pot with deterministic idempotent id', async () => {
    const log = fakeLog([
      {
        events: [
          manualEvent({ seq: 1 }),
          manualEvent({
            seq: 2,
            note: 'both mcp/hold-ball-rate-limit and mcp/cross-post-routing-credentials rejected me',
          }),
          manualEvent({ seq: 3, note: 'no pot reference here' }),
          {
            ...manualEvent({ seq: 4 }),
            kind: 'condition_hit',
            conditionId: 'c1',
            sourceFactRef: 'f1',
            recordedBy: 'system',
          },
        ],
        nextCursor: null,
      },
    ]);
    const adapter = new GuardAnomalyAdapter({ deviationLog: log, ownerUserId: 'default-user' });

    const signals = await adapter.pull(T - 1000, T + 1000);

    assert.equal(signals.length, 3, 'ev1 (1 ref) + ev2 (2 refs); non-referencing + condition_hit excluded');
    assert.equal(signals[0].id, 'guard-anomaly:dev-1#mcp/hold-ball-rate-limit');
    assert.equal(signals[0].channel, 'guard-anomaly');
    assert.equal(signals[0].catId, 'codex');
    assert.equal(signals[0].threadId, 'thread_a');
    assert.ok(signals[0].symptom.includes('mcp/hold-ball-rate-limit'));
    const ev2Ids = signals.filter((s) => s.rawRef.startsWith('dev-2#')).map((s) => s.id);
    assert.deepEqual(
      new Set(ev2Ids),
      new Set([
        'guard-anomaly:dev-2#mcp/hold-ball-rate-limit',
        'guard-anomaly:dev-2#mcp/cross-post-routing-credentials',
      ]),
    );

    // Same window pulled again → identical ids (idempotency contract).
    const log2 = fakeLog([{ events: [manualEvent({ seq: 1 })], nextCursor: null }]);
    const adapter2 = new GuardAnomalyAdapter({ deviationLog: log2, ownerUserId: 'default-user' });
    const again = await adapter2.pull(T - 1000, T + 1000);
    assert.equal(again[0].id, signals[0].id);
  });

  test('follows pagination to exhaustion and windows the query correctly', async () => {
    const log = fakeLog([
      { events: [manualEvent({ seq: 1 })], nextCursor: 'page2' },
      { events: [manualEvent({ seq: 2 })], nextCursor: null },
    ]);
    const adapter = new GuardAnomalyAdapter({ deviationLog: log, ownerUserId: 'default-user' });

    const signals = await adapter.pull(T, T + 5000);

    assert.equal(signals.length, 2, 'both pages consumed');
    assert.equal(log.calls.length, 2);
    assert.equal(log.calls[0].ownerUserId, 'default-user');
    assert.equal(log.calls[0].fromMs, T);
    assert.equal(log.calls[0].toMs, T + 4999, 'adapter [since, until) → inclusive toMs = until-1');
    assert.equal(log.calls[1].cursor, 'page2');
  });
});

describe('extractLedgerRefs — token-boundary matching (sol P2-2)', () => {
  test('matches only registered coordinates, no false positives', () => {
    assert.deepEqual(extractLedgerRefs('nothing here'), []);
    assert.deepEqual(extractLedgerRefs('saw mcp/hold-ball-rate-limit today'), ['mcp/hold-ball-rate-limit']);
    assert.deepEqual(
      extractLedgerRefs('unregistered mcp/made-up-pot ref'),
      [],
      'unregistered pots have no stats identity',
    );
  });

  test('suffix/prefix extensions do NOT attribute to the legitimate pot', () => {
    assert.deepEqual(
      extractLedgerRefs('saw mcp/hold-ball-rate-limit-evil today'),
      [],
      'suffix extension must not match (bare substring bug)',
    );
    assert.deepEqual(extractLedgerRefs('xmcp/hold-ball-rate-limit'), [], 'prefix extension must not match');
    assert.deepEqual(
      extractLedgerRefs('mcp/hold-ball-rate-limit/extra'),
      [],
      'deeper path must not match the shorter pot',
    );
  });

  test('boundary punctuation and edges still match', () => {
    assert.deepEqual(extractLedgerRefs('mcp/hold-ball-rate-limit'), ['mcp/hold-ball-rate-limit'], 'exact string');
    assert.deepEqual(
      extractLedgerRefs('[ledger: mcp/hold-ball-rate-limit]'),
      ['mcp/hold-ball-rate-limit'],
      'bracketed rejection-response format',
    );
    assert.deepEqual(
      extractLedgerRefs('（撞到 mcp/hold-ball-rate-limit，已重试）'),
      ['mcp/hold-ball-rate-limit'],
      'CJK punctuation neighbors',
    );
  });
});

describe('GuardLedgerStats — idempotent AC-B2 writeback', () => {
  function fakeRedis() {
    const sets = new Map();
    return {
      sets,
      async sadd(key, member) {
        const s = sets.get(key) ?? new Set();
        const before = s.size;
        s.add(member);
        sets.set(key, s);
        return s.size - before;
      },
      async scard(key) {
        return sets.get(key)?.size ?? 0;
      },
    };
  }

  test('SADD of the same (pot, eventId) never double-counts; distinct events accumulate', async () => {
    const redis = fakeRedis();
    const stats = new GuardLedgerStats(redis);

    await stats.recordAnomalyReference('default-user', 'mcp/hold-ball-rate-limit', 'dev-1');
    await stats.recordAnomalyReference('default-user', 'mcp/hold-ball-rate-limit', 'dev-1'); // dedup replay
    await stats.recordAnomalyReference('default-user', 'mcp/hold-ball-rate-limit', 'dev-2');

    assert.equal(await stats.anomalyReferenceCount('default-user', 'mcp/hold-ball-rate-limit'), 2);
    assert.equal(await stats.anomalyReferenceCount('default-user', 'mcp/never-referenced'), 0);
  });

  test('write-side fail-open: redis sadd errors do not reject', async () => {
    const stats = new GuardLedgerStats({
      async sadd() {
        throw new Error('down');
      },
      async scard() {
        throw new Error('down');
      },
    });
    await assert.doesNotReject(() => stats.recordAnomalyReference('default-user', 'mcp/hold-ball-rate-limit', 'dev-1'));
  });

  test('read-side fail-closed: redis scard errors propagate (sol P2-3)', async () => {
    const stats = new GuardLedgerStats({
      async sadd() {
        return 1;
      },
      async scard() {
        throw new Error('READONLY: Redis failover');
      },
    });
    await assert.rejects(() => stats.anomalyReferenceCount('default-user', 'mcp/hold-ball-rate-limit'), {
      message: 'READONLY: Redis failover',
    });
  });
});
