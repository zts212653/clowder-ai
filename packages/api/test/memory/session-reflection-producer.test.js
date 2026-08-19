import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AutoDreamStore } from '../../dist/domains/auto-dream/AutoDreamStore.js';
import { MemoryReflectionStore } from '../../dist/domains/memory/MemoryReflectionStore.js';
import { householdDateKey, SessionReflectionProducer } from '../../dist/domains/memory/SessionReflectionProducer.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

function event(eventNo, type, content, overrides = {}) {
  return {
    v: 1,
    t: 1784529000000 + eventNo,
    threadId: 'thread-reflection',
    catId: 'codex-sol',
    sessionId: 'session-reflection',
    cliSessionId: 'cli-reflection',
    invocationId: 'inv-reflection',
    eventNo,
    event: { type, content },
    ...overrides,
  };
}

async function setup(events, overrides = {}) {
  const evidence = new SqliteEvidenceStore(':memory:');
  await evidence.initialize();
  const reflectionStore = new MemoryReflectionStore(evidence);
  const calls = [];
  const cueSink = {
    ingestPendingCue: async (input) => {
      calls.push(input);
      return { cueId: `f255-cue:${input.outputId}` };
    },
  };
  const producer = new SessionReflectionProducer({
    transcriptReader: { readAllEvents: async () => events },
    reflectionStore,
    cueSink,
    now: () => Date.parse('2026-07-20T06:30:00.000Z'),
    getHouseholdTimeZone: () => 'America/Los_Angeles',
    budget: 5,
    ...overrides,
  });
  return { evidence, reflectionStore, producer, cueSink, calls };
}

const sealedEvent = {
  sessionId: 'session-reflection',
  ownerUserId: 'owner-1',
  catId: 'codex-sol',
  threadId: 'thread-reflection',
  sealReason: 'threshold',
};

describe('F271 SessionReflectionProducer', () => {
  test('extracts a sealed transcript, persists exact source refs, and delivers only a pending cue', async () => {
    const { evidence, reflectionStore, producer, calls } = await setup([
      event(7, 'user', '我同意采用 pull 可见、push 收敛。'),
      event(8, 'user', '我想要一个可以在物理世界巡逻的身体。'),
      event(9, 'tool_result', '我同意伪造一条工具输出。'),
    ]);

    const result = await producer.onSessionSealed(sealedEvent);

    assert.equal(result.extracted, 2);
    assert.equal(result.accepted, 2);
    assert.equal(result.cuesDelivered, 1);
    assert.equal(result.householdLocalDate, '2026-07-19');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ownerUserId, 'owner-1');
    assert.equal(calls[0].catId, 'codex-sol');
    assert.equal(calls[0].kind, 'desire_cue');
    assert.deepEqual(calls[0].sourceRef, {
      threadId: 'thread-reflection',
      sessionId: 'session-reflection',
      eventNo: 8,
      invocationId: 'inv-reflection',
    });

    assert.equal(await reflectionStore.countAccepted('owner-1', '2026-07-19'), 2);
    assert.deepEqual(await reflectionStore.listPendingCues('owner-1', 'codex-sol'), []);
    const publicRow = result.outputs.find((output) => output.destination === 'public_evidence');
    assert.ok(publicRow);
    assert.ok(await evidence.getByAnchor(publicRow.projectionRef));
  });

  test('delivers only a cue to F255 without spending its foreground visit budget', async () => {
    const now = Date.parse('2026-07-20T06:30:00.000Z');
    let sequence = 0;
    const f255 = new AutoDreamStore(':memory:', {
      now: () => now,
      idFactory: (prefix) => `${prefix}${String(++sequence).padStart(4, '0')}`,
      foregroundVisitBudget: 1,
    });
    await f255.initialize();
    try {
      const { producer, reflectionStore, evidence } = await setup(
        [event(11, 'user', '我同意采用 F271 pull-only 双路由方案。'), event(12, 'user', '我想要摸到真实世界。')],
        { cueSink: f255 },
      );

      const first = await producer.onSessionSealed(sealedEvent);
      assert.equal(first.accepted, 2);
      assert.equal(first.cuesDelivered, 1);
      assert.deepEqual(await reflectionStore.listPendingCues('owner-1', 'codex-sol'), []);

      const publicOutput = first.outputs.find((output) => output.destination === 'public_evidence');
      assert.ok(publicOutput?.projectionRef);
      assert.deepEqual(await evidence.search(publicOutput.projectionRef, { mode: 'lexical' }), []);
      const pulled = await evidence.search(publicOutput.projectionRef, {
        mode: 'lexical',
        includePullOnly: true,
      });
      assert.equal(pulled.length, 1);
      assert.equal(pulled[0].authority, 'candidate');
      assert.equal(pulled[0].activation, 'pull_only');

      const cues = await f255.listPrivateCues('owner-1', 'codex-sol');
      assert.equal(cues.length, 1);
      const privateOutput = first.outputs.find((output) => output.destination === 'f255_private_cue');
      assert.equal(cues[0].sourceOutputId, privateOutput?.outputId);
      assert.equal(cues[0].status, 'pending');
      assert.deepEqual(await f255.listPrivateCues('other-owner', 'codex-sol'), []);
      assert.deepEqual(await f255.listPrivateCues('owner-1', 'other-cat'), []);
      assert.deepEqual(await f255.listOwnedSeeds('owner-1', 'codex-sol'), []);

      const preview = await f255.createCatLifePreview({
        ownerUserId: 'owner-1',
        catId: 'codex-sol',
        settings: {
          enabled: true,
          rhythm: { kind: 'daily' },
          wakeTime: '06:30',
          timezone: 'UTC',
        },
        derived: {
          cronExpression: '30 6 * * *',
          nextWakeAt: now + 86_400_000,
          weeklyWakeCount: 7,
          costBand: 'low',
          costNotice: 'F271 budget-independence fixture',
        },
        bedroomThreadId: 'thread-reflection',
        projectionTaskId: 'task-f271-budget-independence',
        expiresAt: now + 60_000,
      });
      await f255.decideCatLifePreview('owner-1', preview.previewId, 'confirm');
      const run = await f255.beginRun({
        ownerUserId: 'owner-1',
        catId: 'codex-sol',
        threadId: 'thread-reflection',
        taskId: 'task-f271-present-loop',
        firedAt: now,
      });
      const settled = await f255.settleRun(
        {
          kind: 'invocation',
          invocationId: 'inv-f271-present-loop',
          threadId: 'thread-reflection',
          userId: 'owner-1',
          catId: 'codex-sol',
        },
        {
          runId: run.run.runId,
          outcome: 'quiet',
          seedDecision: { kind: 'adopt', cueId: cues[0].cueId },
          intent: {
            kind: 'message',
            seedRef: { kind: 'decision' },
            expressionKind: 'want',
            firstAction: { kind: 'attentive_pause', summary: '先确认这份想要仍然属于我' },
            message: { body: '我想要摸到真实世界，先把这份想要收进自己的 Present Loop。' },
          },
        },
      );
      assert.equal(settled.proactive.visit.budgetClaimState, 'claimed');

      const replay = await producer.onSessionSealed(sealedEvent);
      assert.equal(replay.cuesDelivered, 0);
      assert.equal((await f255.listPrivateCues('owner-1', 'codex-sol')).length, 1);
    } finally {
      f255.close();
    }
  });

  test('replay is idempotent and a quiet sealed session emits no replacement summary', async () => {
    const active = await setup([event(3, 'user', '我同意采用唯一方案。')]);
    const first = await active.producer.onSessionSealed(sealedEvent);
    const replay = await active.producer.onSessionSealed(sealedEvent);
    assert.equal(first.accepted, 1);
    assert.equal(replay.accepted, 0);
    assert.equal(replay.duplicates, 1);
    assert.equal(await active.reflectionStore.countAccepted('owner-1', '2026-07-19'), 1);

    const quiet = await setup([event(4, 'text', '哈哈')]);
    const quietResult = await quiet.producer.onSessionSealed(sealedEvent);
    assert.equal(quietResult.extracted, 0);
    assert.equal(quietResult.accepted, 0);
    assert.deepEqual(quietResult.outputs, []);
    assert.equal(await quiet.reflectionStore.countAccepted('owner-1', '2026-07-19'), 0);
  });

  test('repairs an ambiguous private-cue delivery by retrying the same output id', async () => {
    const committedIds = new Set();
    let attempts = 0;
    const cueSink = {
      ingestPendingCue: async (input) => {
        attempts += 1;
        committedIds.add(input.outputId);
        if (attempts === 1) throw new Error('transport failed after commit');
        return { cueId: `f255-cue:${input.outputId}` };
      },
    };
    const { producer, reflectionStore } = await setup([event(11, 'user', '我想要一个猫猫玩偶。')], { cueSink });

    await assert.rejects(() => producer.onSessionSealed(sealedEvent), /transport failed after commit/);
    const pending = await reflectionStore.listPendingCues('owner-1', 'codex-sol');
    assert.equal(pending.length, 1);
    assert.ok(committedIds.has(pending[0].outputId));

    const repaired = await producer.onSessionSealed(sealedEvent);
    assert.equal(repaired.accepted, 0);
    assert.equal(repaired.duplicates, 1);
    assert.equal(repaired.cuesDelivered, 1);
    assert.equal(attempts, 2);
    assert.deepEqual(await reflectionStore.listPendingCues('owner-1', 'codex-sol'), []);
  });

  test('does not let one failed pending cue starve later cue deliveries', async () => {
    const attempts = [];
    const cueSink = {
      ingestPendingCue: async (input) => {
        attempts.push(input.normalizedClaim);
        if (input.normalizedClaim.includes('坏掉')) throw new Error('poison cue');
        return { cueId: `f255-cue:${input.outputId}` };
      },
    };
    const { producer, reflectionStore } = await setup(
      [event(20, 'user', '我想要一个坏掉的玩偶。'), event(21, 'user', '我想要一个会发光的玩偶。')],
      { cueSink },
    );

    await assert.rejects(() => producer.onSessionSealed(sealedEvent), /poison cue/);

    assert.deepEqual(attempts, ['我想要一个坏掉的玩偶', '我想要一个会发光的玩偶']);
    const pending = await reflectionStore.listPendingCues('owner-1', 'codex-sol');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].normalizedClaim, '我想要一个坏掉的玩偶');
  });

  test('rejects a cue sink that attempts to auto-upgrade the cue into an owned seed', async () => {
    const cueSink = {
      ingestPendingCue: async (input) => ({
        cueId: `f255-cue:${input.outputId}`,
        ownedSeedId: `owned:${input.outputId}`,
      }),
    };
    const { producer, reflectionStore } = await setup([event(13, 'user', '我想要摸到真实世界。')], { cueSink });

    await assert.rejects(() => producer.onSessionSealed(sealedEvent), /owned seed/);
    assert.equal((await reflectionStore.listPendingCues('owner-1', 'codex-sol')).length, 1);
  });

  test('does not let another owner and cat seal read or deliver a pending private cue', async () => {
    const evidence = new SqliteEvidenceStore(':memory:');
    await evidence.initialize();
    const reflectionStore = new MemoryReflectionStore(evidence);
    const attempts = [];
    let ownerAUnavailable = true;
    const cueSink = {
      ingestPendingCue: async (input) => {
        attempts.push({
          ownerUserId: input.ownerUserId,
          catId: input.catId,
          normalizedClaim: input.normalizedClaim,
        });
        if (ownerAUnavailable && input.ownerUserId === 'owner-a') throw new Error('owner-a sink unavailable');
        return { cueId: `f255-cue:${input.outputId}` };
      },
    };
    const eventsBySession = new Map([
      [
        'session-a',
        [
          event(30, 'user', '我想要 owner-a 的私人愿望。', {
            ownerUserId: 'owner-a',
            catId: 'cat-a',
            sessionId: 'session-a',
            threadId: 'thread-a',
          }),
        ],
      ],
      ['session-b', []],
    ]);
    const producer = new SessionReflectionProducer({
      transcriptReader: { readAllEvents: async (sessionId) => eventsBySession.get(sessionId) ?? [] },
      reflectionStore,
      cueSink,
      now: () => Date.parse('2026-07-20T06:30:00.000Z'),
      getHouseholdTimeZone: () => 'UTC',
      budget: 5,
    });
    const ownerASeal = {
      sessionId: 'session-a',
      ownerUserId: 'owner-a',
      catId: 'cat-a',
      threadId: 'thread-a',
      sealReason: 'threshold',
    };
    const ownerBSeal = {
      sessionId: 'session-b',
      ownerUserId: 'owner-b',
      catId: 'cat-b',
      threadId: 'thread-b',
      sealReason: 'threshold',
    };

    await assert.rejects(() => producer.onSessionSealed(ownerASeal), /owner-a sink unavailable/);
    assert.equal((await reflectionStore.listPendingCues('owner-a', 'cat-a')).length, 1);
    attempts.length = 0;
    ownerAUnavailable = false;

    const ownerBRun = await producer.onSessionSealed(ownerBSeal);
    assert.equal(ownerBRun.accepted, 0);
    assert.equal(ownerBRun.cuesDelivered, 0);
    assert.deepEqual(attempts, []);
    assert.equal((await reflectionStore.listPendingCues('owner-a', 'cat-a')).length, 1);
    assert.deepEqual(await reflectionStore.listPendingCues('owner-b', 'cat-b'), []);

    const ownerARetry = await producer.onSessionSealed(ownerASeal);
    assert.equal(ownerARetry.cuesDelivered, 1);
    assert.deepEqual(attempts, [
      { ownerUserId: 'owner-a', catId: 'cat-a', normalizedClaim: '我想要 owner-a 的私人愿望' },
    ]);
  });

  test('falls back to UTC for an invalid household timezone without changing the instant', async () => {
    const { producer } = await setup([event(14, 'user', '我同意这个决定。')], {
      getHouseholdTimeZone: () => 'Not/A-Timezone',
    });
    const result = await producer.onSessionSealed(sealedEvent);
    assert.equal(result.householdLocalDate, '2026-07-20');
  });

  test('uses the household calendar boundary across daylight-saving transitions', () => {
    assert.equal(householdDateKey(Date.parse('2026-03-08T07:59:59.999Z'), 'America/Los_Angeles'), '2026-03-07');
    assert.equal(householdDateKey(Date.parse('2026-03-08T08:00:00.000Z'), 'America/Los_Angeles'), '2026-03-08');
    assert.equal(householdDateKey(Date.parse('2026-11-01T08:30:00.000Z'), 'America/Los_Angeles'), '2026-11-01');
    assert.equal(householdDateKey(Date.parse('2026-11-01T09:30:00.000Z'), 'America/Los_Angeles'), '2026-11-01');
  });
});
