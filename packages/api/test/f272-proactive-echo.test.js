import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { AutoDreamStore } from '../dist/domains/auto-dream/AutoDreamStore.js';
import { PresentLoopService } from '../dist/domains/auto-dream/PresentLoopService.js';
import { ProactiveRelationshipService } from '../dist/domains/auto-dream/ProactiveRelationshipService.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

const OWNER = 'owner-a';
const CAT = 'codex-sol';
const HOME = 'thread-home-sol';

describe('F272 natural echo and next-wake memory', () => {
  let now;
  let sequence;
  let store;
  let messageStore;
  let service;

  beforeEach(async () => {
    now = Date.parse('2026-07-22T16:00:00.000Z');
    sequence = 0;
    store = new AutoDreamStore(':memory:', {
      now: () => now,
      idFactory: (prefix) => `${prefix}${String(++sequence).padStart(4, '0')}`,
    });
    messageStore = new MessageStore();
    await store.initialize();
    const preview = await store.createCatLifePreview({
      ownerUserId: OWNER,
      catId: CAT,
      settings: { enabled: true, rhythm: { kind: 'daily' }, wakeTime: '16:00', timezone: 'UTC' },
      derived: {
        cronExpression: '0 16 * * *',
        nextWakeAt: now + 86_400_000,
        weeklyWakeCount: 7,
        costBand: 'low',
        costNotice: 'fixture',
      },
      bedroomThreadId: HOME,
      projectionTaskId: 'task-life-sol',
      expiresAt: now + 60_000,
    });
    await store.decideCatLifePreview(OWNER, preview.previewId, 'confirm');
    service = new ProactiveRelationshipService({ store, messageStore, now: () => now });
  });

  afterEach(() => store.close());

  function principal(invocationId) {
    return { kind: 'invocation', invocationId, threadId: HOME, userId: OWNER, catId: CAT };
  }

  async function createVisit(label, expressionKind, body) {
    const run = await store.beginRun({
      ownerUserId: OWNER,
      catId: CAT,
      threadId: HOME,
      taskId: `task-${label}`,
      firedAt: now,
    });
    const settled = await store.settleRun(principal(`inv-${label}`), {
      runId: run.run.runId,
      outcome: 'quiet',
      seedDecision: { kind: 'originate', claim: `私有念头-${label}` },
      intent: {
        kind: 'message',
        seedRef: { kind: 'decision' },
        expressionKind,
        firstAction: { kind: 'attentive_pause', summary: `可逆第一步-${label}` },
        message: { body },
      },
    });
    const delivered = await service.reconcileVisit(OWNER, CAT, settled.proactive.visit.visitId);
    now += 1_000;
    return delivered;
  }

  async function appendUserReply(content, replyTo) {
    const message = await messageStore.append({
      threadId: HOME,
      userId: OWNER,
      catId: null,
      content,
      mentions: [],
      timestamp: now,
      ...(replyTo ? { replyTo } : {}),
    });
    now += 1_000;
    return message;
  }

  test('explicit replyTo wins; otherwise one user message echoes only the latest un-echoed visit', async () => {
    const first = await createVisit('first', 'want', '我想要在桌边留一个小垫子。');
    const second = await createVisit('second', 'discover', '我发现午后的桌面很暖。');
    const fallbackReply = await appendUserReply('嗯，我看见你啦。');

    assert.deepEqual(await service.reconcileNaturalEchoes(OWNER, CAT), { reconciled: 1 });
    let echoes = await store.proactive.listEchoes(OWNER, CAT);
    assert.equal(echoes.length, 1);
    assert.equal(echoes[0].visitId, second.visit.visitId);
    assert.equal(echoes[0].sourceMessageId, fallbackReply.id);
    assert.equal((await store.proactive.getVisit(OWNER, CAT, first.visit.visitId)).status, 'projected');

    const explicitReply = await appendUserReply('这个也可以一起想想。', first.message.id);
    assert.deepEqual(await service.reconcileNaturalEchoes(OWNER, CAT), { reconciled: 1 });
    echoes = await store.proactive.listEchoes(OWNER, CAT);
    assert.equal(echoes.length, 2);
    assert.equal(echoes[1].visitId, first.visit.visitId);
    assert.equal(echoes[1].sourceMessageId, explicitReply.id);
    assert.deepEqual(await service.reconcileNaturalEchoes(OWNER, CAT), { reconciled: 0 });
    assert.equal(
      JSON.stringify(echoes).includes('这个也可以一起想想'),
      false,
      'echo ledger must not copy reply bodies',
    );
  });

  test('returns bounded private cues, owned seeds and body-free echo refs for the next wake', async () => {
    const delivered = await createVisit('memory', 'care', '我惦记你今天有没有歇一会儿。');
    const reply = await appendUserReply('有的，谢谢你惦记。', delivered.message.id);
    const cue = await store.ingestPendingCue({
      outputId: 'output-next-wake',
      ownerUserId: OWNER,
      catId: CAT,
      kind: 'desire_cue',
      normalizedClaim: '最近总在聊猫猫的桌边空间',
      reason: '这是给私人时间判断的线索',
      sourceRef: { threadId: 'thread-implementation-fixture', messageId: 'message-cue' },
      producer: 'f271-session-close-v1',
      createdAt: new Date(now).toISOString(),
    });

    const presentLoop = new PresentLoopService(
      store,
      { reconcile: async () => ({ projected: 0, removed: 0, failed: 0 }) },
      OWNER,
      service,
    );
    const schedule = {
      triggerKind: 'cron',
      scheduledAt: new Date(now).toISOString(),
      firedAt: new Date(now).toISOString(),
      latenessMs: 0,
      missedSlots: 0,
      late: false,
    };
    const started = await presentLoop.beginScheduledRun({
      ownerUserId: OWNER,
      catId: CAT,
      threadId: HOME,
      taskId: 'task-next-wake',
      schedule,
    });
    const context = started.proactiveContext;
    assert.equal(context.pendingCues[0].cueId, cue.cueId);
    assert.equal(context.pendingCues[0].normalizedClaim, '最近总在聊猫猫的桌边空间');
    assert.equal(context.ownedSeeds[0].seedId, delivered.visit.seedId);
    assert.equal(context.recentEchoes[0].kind, 'natural_reply');
    assert.equal(context.recentEchoes[0].sourceMessageId, reply.id);
    assert.equal(JSON.stringify(context).includes('有的，谢谢你惦记'), false);
    const prompt = presentLoop.renderWakePrompt(started, schedule);
    assert.match(prompt, new RegExp(delivered.visit.seedId));
    assert.match(prompt, /natural_reply/);
    assert.match(prompt, new RegExp(reply.id));
    assert.doesNotMatch(prompt, /有的，谢谢你惦记/);
  });
});
