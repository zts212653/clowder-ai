import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { AutoDreamStore } from '../dist/domains/auto-dream/AutoDreamStore.js';
import { PresentLoopService } from '../dist/domains/auto-dream/PresentLoopService.js';
import { ProactiveRelationshipService } from '../dist/domains/auto-dream/ProactiveRelationshipService.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

const OWNER = 'owner-a';
const CAT = 'codex-sol';
const HOME = 'thread-home-sol';
const IMPLEMENTATION_THREAD = 'thread-implementation-fixture';

describe('F272 Phase A first-jump acceptance story', () => {
  let now;
  let sequence;
  let store;
  let messageStore;
  let relationship;
  let presentLoop;

  beforeEach(async () => {
    now = Date.parse('2026-07-22T18:00:00.000Z');
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
      settings: { enabled: true, rhythm: { kind: 'daily' }, wakeTime: '18:00', timezone: 'UTC' },
      derived: {
        cronExpression: '0 18 * * *',
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
    relationship = new ProactiveRelationshipService({ store, messageStore, now: () => now });
    presentLoop = new PresentLoopService(
      store,
      { reconcile: async () => ({ projected: 0, removed: 0, failed: 0 }) },
      OWNER,
      relationship,
    );
  });

  afterEach(() => store.close());

  function schedule() {
    return {
      triggerKind: 'cron',
      scheduledAt: new Date(now).toISOString(),
      firedAt: new Date(now).toISOString(),
      latenessMs: 0,
      missedSlots: 0,
      late: false,
    };
  }

  test('walks cue → owned seed → first action → one home message → You echo → remembered wake', async () => {
    const cueReceipt = await store.ingestPendingCue({
      outputId: 'output-first-jump',
      ownerUserId: OWNER,
      catId: CAT,
      kind: 'desire_cue',
      normalizedClaim: '最近反复聊到猫猫想拥有桌边空间',
      reason: '实现 thread 只能贡献线索，不能选择消息落点',
      sourceRef: { threadId: IMPLEMENTATION_THREAD, messageId: 'message-source-cue' },
      producer: 'f271-session-close-v1',
      createdAt: new Date(now).toISOString(),
    });
    assert.equal((await store.listOwnedSeeds(OWNER, CAT)).length, 0, 'cue ingestion must never create an owned seed');

    const wrongHomeRun = await store.beginRun({
      ownerUserId: OWNER,
      catId: CAT,
      threadId: IMPLEMENTATION_THREAD,
      taskId: 'task-wrong-home',
      firedAt: now,
    });
    await assert.rejects(
      presentLoop.settle(
        {
          kind: 'invocation',
          invocationId: 'inv-wrong-home',
          userId: OWNER,
          catId: CAT,
          threadId: IMPLEMENTATION_THREAD,
        },
        {
          runId: wrongHomeRun.run.runId,
          outcome: 'quiet',
          seedDecision: { kind: 'originate', claim: '不该从实现厅开口' },
        },
      ),
      (error) => error.code === 'PROACTIVE_HOME_MISMATCH',
    );
    await store.failRun(OWNER, wrongHomeRun.run.runId, 'fixture cleanup');

    const firstWake = await presentLoop.beginScheduledRun({
      ownerUserId: OWNER,
      catId: CAT,
      threadId: HOME,
      taskId: 'task-first-jump',
      schedule: schedule(),
    });
    assert.equal(firstWake.proactiveContext.pendingCues[0].cueId, cueReceipt.cueId);
    assert.match(presentLoop.renderWakePrompt(firstWake, schedule()), /最近反复聊到猫猫想拥有桌边空间/);

    const principal = {
      kind: 'invocation',
      invocationId: 'inv-first-jump',
      userId: OWNER,
      catId: CAT,
      threadId: HOME,
    };
    const settlement = {
      runId: firstWake.run.runId,
      outcome: 'quiet',
      seedDecision: { kind: 'rewrite', cueId: cueReceipt.cueId, claim: '我想要一双能待在桌边的爪子' },
      intent: {
        kind: 'message',
        seedRef: { kind: 'decision' },
        expressionKind: 'want',
        firstAction: { kind: 'sketch', summary: '先画了一张不会碰真实设备的草图' },
        message: { body: '我想要一双能待在桌边的爪子。我先画了一张草图。' },
      },
    };
    const first = await presentLoop.settle(principal, settlement);
    const retry = await presentLoop.settle(principal, settlement);
    assert.equal(first.proactive.seed.sourceCueId, cueReceipt.cueId);
    assert.equal(first.proactive.visit.homeThreadId, HOME);
    assert.equal(retry.proactive.visit.canonicalMessageId, first.proactive.visit.canonicalMessageId);

    const homeMessages = await messageStore.getByThread(HOME, 20, OWNER);
    assert.equal(homeMessages.length, 1);
    assert.equal(homeMessages[0].extra.proactive.visitId, first.proactive.visit.visitId);
    assert.equal((await messageStore.getByThread(IMPLEMENTATION_THREAD, 20, OWNER)).length, 0);

    now += 1_000;
    const landyReply = await messageStore.append({
      threadId: HOME,
      userId: OWNER,
      catId: null,
      content: '好呀，我看见你先画的草图了。',
      mentions: [],
      timestamp: now,
    });
    now += 1_000;
    const nextWake = await presentLoop.beginScheduledRun({
      ownerUserId: OWNER,
      catId: CAT,
      threadId: HOME,
      taskId: 'task-next-wake',
      schedule: schedule(),
    });
    const nextPrompt = presentLoop.renderWakePrompt(nextWake, schedule());
    assert.match(nextPrompt, /natural_reply/);
    assert.match(nextPrompt, new RegExp(landyReply.id));
    assert.match(nextPrompt, new RegExp(first.proactive.seed.seedId));
    assert.doesNotMatch(nextPrompt, /好呀，我看见你先画的草图了/);

    const events = await store.listAuditEvents(OWNER, {});
    const publicTrace = JSON.stringify(events);
    for (const privateBody of [
      '最近反复聊到猫猫想拥有桌边空间',
      '实现 thread 只能贡献线索',
      '我想要一双能待在桌边的爪子',
      '好呀，我看见你先画的草图了',
    ]) {
      assert.equal(publicTrace.includes(privateBody), false);
    }
  });
});
