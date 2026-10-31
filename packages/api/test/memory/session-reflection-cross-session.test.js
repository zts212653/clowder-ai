import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryReflectionStore } from '../../dist/domains/memory/MemoryReflectionStore.js';
import { SessionReflectionProducer } from '../../dist/domains/memory/SessionReflectionProducer.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

function event(eventNo, content, sessionId, threadId, t) {
  return {
    v: 1,
    t,
    threadId,
    catId: 'codex-sol',
    sessionId,
    cliSessionId: `cli-${sessionId}`,
    invocationId: 'inv-reflection',
    eventNo,
    event: { type: 'user', content },
  };
}

test('F271 merges the same typed claim across sessions before spending the durable daily budget', async () => {
  const eventsBySession = new Map([
    [
      'session-a',
      [event(1, '我同意采用唯一耐久通道。', 'session-a', 'thread-a', Date.parse('2026-07-19T18:00:00.000Z'))],
    ],
    [
      'session-b',
      [
        event(2, '我同意采用唯一耐久通道。', 'session-b', 'thread-b', Date.parse('2026-07-19T19:00:00.000Z')),
        event(3, '我想要一副能走进现实世界的身体。', 'session-b', 'thread-b', Date.parse('2026-07-19T20:00:00.000Z')),
        event(4, '我同意采用不属于目标日的方案。', 'session-b', 'thread-b', Date.parse('2026-07-20T20:00:00.000Z')),
      ],
    ],
  ]);
  const evidence = new SqliteEvidenceStore(':memory:');
  await evidence.initialize();
  const reflectionStore = new MemoryReflectionStore(evidence);
  const producer = new SessionReflectionProducer({
    transcriptReader: { readAllEvents: async (sessionId) => eventsBySession.get(sessionId) ?? [] },
    reflectionStore,
    cueSink: {
      ingestPendingCue: async (input) => ({ cueId: `f255-cue:${input.outputId}` }),
    },
    now: () => Date.parse('2026-07-20T06:30:00.000Z'),
    getHouseholdTimeZone: () => 'America/Los_Angeles',
    budget: 5,
  });
  const seals = [
    {
      sessionId: 'session-a',
      ownerUserId: 'owner-1',
      catId: 'codex-sol',
      threadId: 'thread-a',
      sealReason: 'daily_context_reflection',
    },
    {
      sessionId: 'session-b',
      ownerUserId: 'owner-1',
      catId: 'codex-sol',
      threadId: 'thread-b',
      sealReason: 'daily_context_reflection',
    },
  ];

  const first = await producer.reflectSessions(seals, { sourceLocalDate: '2026-07-19' });
  assert.equal(first.extracted, 2);
  assert.equal(first.accepted, 2);
  assert.equal(first.cuesDelivered, 1);
  assert.equal(await reflectionStore.countAccepted('owner-1', '2026-07-19'), 2);
  assert.deepEqual(first.outputs.find((output) => output.kind === 'decision')?.sourceRef, {
    threadId: 'thread-a',
    sessionId: 'session-a',
    eventNo: 1,
    invocationId: 'inv-reflection',
    eventAt: Date.parse('2026-07-19T18:00:00.000Z'),
  });

  const replay = await producer.reflectSessions(seals, { sourceLocalDate: '2026-07-19' });
  assert.equal(replay.accepted, 0);
  assert.equal(replay.duplicates, 2);
  assert.equal(replay.cuesDelivered, 0);
  assert.equal(await reflectionStore.countAccepted('owner-1', '2026-07-19'), 2);
});

test('F271 repairs an already accepted later source to the earliest transcript event without charging budget again', async () => {
  const eventsBySession = new Map([
    [
      'session-late',
      [event(9, '我同意采用唯一耐久通道。', 'session-late', 'thread-late', Date.parse('2026-07-19T19:00:00.000Z'))],
    ],
    [
      'session-early',
      [event(1, '我同意采用唯一耐久通道。', 'session-early', 'thread-early', Date.parse('2026-07-19T18:00:00.000Z'))],
    ],
  ]);
  const evidence = new SqliteEvidenceStore(':memory:');
  await evidence.initialize();
  const reflectionStore = new MemoryReflectionStore(evidence);
  const producer = new SessionReflectionProducer({
    transcriptReader: { readAllEvents: async (sessionId) => eventsBySession.get(sessionId) ?? [] },
    reflectionStore,
    now: () => Date.parse('2026-07-20T06:30:00.000Z'),
    getHouseholdTimeZone: () => 'America/Los_Angeles',
    budget: 5,
  });
  const late = {
    sessionId: 'session-late',
    ownerUserId: 'owner-1',
    catId: 'codex-sol',
    threadId: 'thread-late',
    sealReason: 'threshold',
  };
  const earlyActive = {
    sessionId: 'session-early',
    ownerUserId: 'owner-1',
    catId: 'codex-sol',
    threadId: 'thread-early',
    sealReason: 'daily_context_reflection',
  };

  const phaseA = await producer.onSessionSealed(late);
  assert.equal(phaseA.accepted, 1);

  const legacySourceRef = {
    threadId: 'thread-late',
    sessionId: 'session-late',
    eventNo: 9,
    invocationId: 'inv-reflection',
  };
  evidence
    .getDb()
    .prepare('UPDATE reflection_outputs SET source_ref_json = ? WHERE output_id = ?')
    .run(JSON.stringify(legacySourceRef), phaseA.outputs[0].outputId);
  assert.deepEqual(
    JSON.parse(
      evidence
        .getDb()
        .prepare('SELECT source_ref_json FROM reflection_outputs WHERE output_id = ?')
        .get(phaseA.outputs[0].outputId).source_ref_json,
    ),
    legacySourceRef,
    'released Phase-A rows did not persist eventAt',
  );

  const daily = await producer.reflectSessions([late, earlyActive], { sourceLocalDate: '2026-07-19' });
  assert.equal(daily.accepted, 0);
  assert.equal(daily.duplicates, 1);
  assert.equal(await reflectionStore.countAccepted('owner-1', '2026-07-19'), 1);

  const ledger = evidence
    .getDb()
    .prepare('SELECT source_ref_json FROM reflection_outputs WHERE output_id = ?')
    .get(phaseA.outputs[0].outputId);
  assert.equal(JSON.parse(ledger.source_ref_json).sessionId, 'session-early');

  const projection = await evidence.getByAnchor(phaseA.outputs[0].projectionRef);
  assert.equal(projection?.drillDown?.params.sessionId, 'session-early');
  assert.equal(projection?.drillDown?.params.cursor, '1');
});

test('F271 backfills a legacy earliest source without replacing it with a later transcript event', async () => {
  const earlyAt = Date.parse('2026-07-19T18:00:00.000Z');
  const eventsBySession = new Map([
    ['session-early', [event(1, '我同意采用唯一耐久通道。', 'session-early', 'thread-early', earlyAt)]],
    [
      'session-late',
      [event(9, '我同意采用唯一耐久通道。', 'session-late', 'thread-late', Date.parse('2026-07-19T19:00:00.000Z'))],
    ],
  ]);
  const evidence = new SqliteEvidenceStore(':memory:');
  await evidence.initialize();
  const reflectionStore = new MemoryReflectionStore(evidence);
  const producer = new SessionReflectionProducer({
    transcriptReader: { readAllEvents: async (sessionId) => eventsBySession.get(sessionId) ?? [] },
    reflectionStore,
    now: () => Date.parse('2026-07-20T06:30:00.000Z'),
    getHouseholdTimeZone: () => 'America/Los_Angeles',
    budget: 5,
  });
  const early = {
    sessionId: 'session-early',
    ownerUserId: 'owner-1',
    catId: 'codex-sol',
    threadId: 'thread-early',
    sealReason: 'threshold',
  };
  const lateActive = {
    sessionId: 'session-late',
    ownerUserId: 'owner-1',
    catId: 'codex-sol',
    threadId: 'thread-late',
    sealReason: 'daily_context_reflection',
  };

  const phaseA = await producer.onSessionSealed(early);
  const legacySourceRef = {
    threadId: 'thread-early',
    sessionId: 'session-early',
    eventNo: 1,
    invocationId: 'inv-reflection',
  };
  evidence
    .getDb()
    .prepare('UPDATE reflection_outputs SET source_ref_json = ? WHERE output_id = ?')
    .run(JSON.stringify(legacySourceRef), phaseA.outputs[0].outputId);

  const daily = await producer.reflectSessions([early, lateActive], { sourceLocalDate: '2026-07-19' });
  assert.equal(daily.accepted, 0);
  assert.equal(daily.duplicates, 1);
  assert.equal(await reflectionStore.countAccepted('owner-1', '2026-07-19'), 1);

  const ledger = evidence
    .getDb()
    .prepare('SELECT source_ref_json FROM reflection_outputs WHERE output_id = ?')
    .get(phaseA.outputs[0].outputId);
  assert.deepEqual(JSON.parse(ledger.source_ref_json), { ...legacySourceRef, eventAt: earlyAt });

  const projection = await evidence.getByAnchor(phaseA.outputs[0].projectionRef);
  assert.equal(projection?.drillDown?.params.sessionId, 'session-early');
  assert.equal(projection?.drillDown?.params.cursor, '1');
});

test('F271 stops transcript work and does not start the next session after cancellation', async () => {
  const evidence = new SqliteEvidenceStore(':memory:');
  await evidence.initialize();
  const reflectionStore = new MemoryReflectionStore(evidence);
  const active = new Set();
  const started = [];
  const producer = new SessionReflectionProducer({
    transcriptReader: {
      readAllEvents(sessionId, _threadId, _catId, signal) {
        started.push(sessionId);
        active.add(sessionId);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            active.delete(sessionId);
            resolve([]);
          }, 100);
          signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              active.delete(sessionId);
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
    },
    reflectionStore,
    now: () => Date.parse('2026-07-20T06:30:00.000Z'),
  });
  const controller = new AbortController();
  const pending = producer.reflectSessions(
    [
      {
        sessionId: 'session-a',
        ownerUserId: 'owner-1',
        catId: 'codex-sol',
        threadId: 'thread-a',
        sealReason: 'daily_context_reflection',
      },
      {
        sessionId: 'session-b',
        ownerUserId: 'owner-1',
        catId: 'codex-sol',
        threadId: 'thread-b',
        sealReason: 'daily_context_reflection',
      },
    ],
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(new Error('transcript deadline exceeded')), 20);

  await assert.rejects(pending, /transcript deadline exceeded/);
  assert.equal(active.size, 0);
  assert.deepEqual(started, ['session-a']);
  assert.equal(await reflectionStore.countAccepted('owner-1', '2026-07-20'), 0);
});
