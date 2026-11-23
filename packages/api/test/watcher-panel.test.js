import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InMemoryQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import {
  getMessageDisplayName,
  getMessageSpeakerName,
} from '../dist/domains/cats/services/context/ContextAssembler.js';
import { isDisplayOnlySystemMessage } from '../dist/domains/cats/services/stores/host-message-policy.js';
import { MemoryConciergeConfigStore } from '../dist/domains/concierge/ConciergeConfigStore.js';
import { isWatcherPanelDelivery } from '../dist/domains/concierge/watcher/panel/watcher-panel-delivery.js';
import {
  InMemoryWatcherPanelLedger,
  watcherPanelRoundId,
} from '../dist/domains/concierge/watcher/panel/watcher-panel-ledger.js';
import { WatcherPanelRunner } from '../dist/domains/concierge/watcher/panel/watcher-panel-runner.js';
import { watcherWorld } from './helpers/watcher-world.js';

const MEMBERS = ['gpt52', 'spark', 'codex-sol'];
const OWNER = 'watcher-owner';

async function panelWorld({ maxConcurrentRuns = 6, enabled = true, runMember, loadGuidance } = {}) {
  const w = await watcherWorld();
  const configs = new MemoryConciergeConfigStore();
  await configs.updateWatcherConfig(OWNER, 0, {
    enabled: true,
    scope: 'all',
    panel: { enabled, members: MEMBERS.map((catId) => ({ catId })), maxConcurrentRuns },
  });
  const ledger = new InMemoryWatcherPanelLedger();
  const queue = new InvocationQueue(new InMemoryQueueLedgerStore(), { resolveTargets: async (targets) => targets });
  const published = [];
  const reports = [];
  const calls = [];
  const logs = [];
  const runner = new WatcherPanelRunner({
    ...w,
    userId: OWNER,
    configs,
    labels: { list: async () => [] },
    ledger,
    queue,
    transcript: { appendDurableEvent: async () => {} },
    apiUrl: 'http://127.0.0.1:3102',
    service: () => undefined,
    publish: (message) => published.push(message),
    report: (error) => reports.push(error),
    log: Object.fromEntries(
      ['info', 'warn', 'error'].map((level) => [level, (fields, message) => logs.push({ level, fields, message })]),
    ),
    random: () => 0.42,
    loadGuidance: loadGuidance ?? (() => ({ text: '判断说明', digest: 'sha256:test' })),
    runMember: async (_owners, input) => {
      calls.push(input);
      const invocationId = `inv-${input.source.invocationId}-${input.catId}`;
      input.onAdmitted?.(invocationId);
      const said = runMember ? await runMember(input) : undefined;
      if (said?.sentence)
        said.receipt = await runner.acceptNudge({
          invocationId,
          userId: OWNER,
          threadId: input.round.threadId,
          sentence: said.sentence,
          sourceMessageId: said.sourceMessageId ?? input.cutoff.id,
        });
      return {
        invocationId,
        status: said?.status ?? 'quiet',
        ...(said?.executionStatus ? { executionStatus: said.executionStatus } : {}),
        sessionId: `s-${input.catId}`,
        ...(said?.failure ? { failure: said.failure } : {}),
      };
    },
  });
  return { ...w, configs, ledger, queue, published, reports, calls, logs, runner };
}

test('panel lifecycle logs correlate a completed round without copying its sentences or accounts', async () => {
  const sentence = '不应复制到日志的提醒正文';
  const f = await panelWorld({ runMember: () => ({ sentence }) });
  const privateAccount = 'private-account-reference';
  await f.configs.updateWatcherConfig(OWNER, 1, {
    panel: {
      enabled: true,
      members: MEMBERS.map((catId) => ({ catId, accountRef: privateAccount })),
      maxConcurrentRuns: 6,
    },
  });
  const [source] = await f.work('工作已结束');
  f.runner.offer(source, 0);
  await f.runner.idle();
  const start = f.logs.find((row) => row.message === 'Watcher panel round started');
  const end = f.logs.find((row) => row.message === 'Watcher panel round finished');
  assert.ok(start, 'a real admitted round has a start log');
  assert.ok(end, 'a fully settled round has a terminal log');
  for (const row of [start, end]) {
    assert.equal(row.fields.roundId, watcherPanelRoundId(source.invocationId));
    assert.equal(row.fields.threadId, source.threadId);
    assert.equal(row.fields.sourceInvocationId, source.invocationId);
  }
  assert.equal(end.fields.status, 'completed');
  assert.equal(end.fields.members.length, 3);
  assert.ok(end.fields.members.every((member) => member.status === 'spoke'));
  assert.ok(end.fields.durationMs >= 0);
  assert.equal(JSON.stringify(f.logs).includes(sentence), false);
  assert.equal(JSON.stringify(f.logs).includes(privateAccount), false);
  f.runner.offer(source, 0);
  await f.runner.idle();
  assert.equal(f.logs.length, 2, 'duplicate source does not log a new round');
});

test('two canceled members remain interrupted while the third sentence is delivered once', async () => {
  const f = await panelWorld({
    runMember: (input) =>
      input.catId === 'codex-sol'
        ? { sentence: '保留已递的一句', executionStatus: 'succeeded' }
        : { status: 'interrupted', executionStatus: 'canceled', failure: 'user_cancel' },
  });
  const [source] = await f.work('一轮结束');
  f.runner.offer(source, 0);
  await f.runner.idle();
  const round = await f.ledger.get(watcherPanelRoundId(source.invocationId));
  assert.equal(round.members.length, 3);
  assert.equal(round.members.filter((entry) => entry.status === 'interrupted').length, 2);
  assert.equal(round.members.find((entry) => entry.catId === 'codex-sol').status, 'spoke');
  assert.ok(round.delivery.messageId);
  assert.equal(f.published.length, 1);
  const end = f.logs.find((row) => row.message === 'Watcher panel round finished');
  assert.equal(end.fields.members.filter((entry) => entry.executionStatus === 'canceled' && entry.failed).length, 2);
});

test('a thrown member error is logged without hiding the other members completing', async () => {
  const f = await panelWorld({
    runMember: (input) => {
      if (input.catId === 'spark') throw new Error('provider_threw');
    },
  });
  const [source] = await f.work('工作已结束');
  f.runner.offer(source, 0);
  await f.runner.idle();
  const failure = f.logs.find((row) => row.message === 'Watcher panel member failed');
  assert.ok(failure);
  assert.equal(failure.fields.catId, 'spark');
  assert.equal(failure.fields.failure, 'provider_threw');
  const end = f.logs.find((row) => row.message === 'Watcher panel round finished');
  assert.deepEqual(end.fields.members.map((member) => member.status).sort(), ['failed', 'quiet', 'quiet']);
});

test('a returned member failure is logged even when its earlier sentence still stands', async () => {
  const f = await panelWorld({
    runMember: (input) =>
      input.catId === 'spark'
        ? { sentence: '这句已递交', status: 'failed', failure: 'provider_unavailable' }
        : undefined,
  });
  const [source] = await f.work('工作已结束');
  f.runner.offer(source, 0);
  await f.runner.idle();
  const failure = f.logs.find((row) => row.message === 'Watcher panel member failed');
  assert.ok(failure, 'a failed provider must not disappear behind the spoke status');
  assert.equal(failure.level, 'warn');
  assert.equal(failure.fields.catId, 'spark');
  assert.equal(failure.fields.failure, 'provider_unavailable');
  const end = f.logs.find((row) => row.message === 'Watcher panel round finished');
  assert.equal(end.fields.members.find((member) => member.catId === 'spark').failed, true);
});

test('round preparation errors are logged and still reach the existing error reporter', async () => {
  const f = await panelWorld({
    loadGuidance: () => {
      throw new Error('guidance_missing');
    },
  });
  const [source] = await f.work('工作已结束');
  f.runner.offer(source, 0);
  await f.runner.idle();
  const failure = f.logs.find((row) => row.message === 'Watcher panel round failed');
  assert.ok(failure, 'failures before the ledger is created remain observable');
  assert.equal(failure.fields.roundId, watcherPanelRoundId(source.invocationId));
  assert.equal(failure.fields.threadId, source.threadId);
  assert.equal(failure.fields.err.message, 'guidance_missing');
  assert.equal(f.reports[0].message, 'guidance_missing');
});

test('every member judges the same cutoff and the spoken sentences arrive once, anonymously', async () => {
  const f = await panelWorld({
    runMember: (input) =>
      input.catId === 'gpt52' ? undefined : { sentence: `${input.catId === 'spark' ? '第一句' : '第二句'}` },
  });
  const [source] = await f.work('改完了');
  f.runner.offer(source, 0);
  await f.runner.idle();

  assert.equal(new Set(f.calls.map((call) => call.cutoff.id)).size, 1, 'one shared cutoff');
  assert.deepEqual(f.calls.map((call) => call.catId).sort(), [...MEMBERS].sort());
  const round = await f.ledger.get(watcherPanelRoundId(source.invocationId));
  assert.equal(round.status, 'completed');
  assert.equal(round.workerCatId, source.catId);
  assert.deepEqual(round.members.map((member) => member.status).sort(), ['quiet', 'spoke', 'spoke']);
  assert.equal(new Set(round.members.map((member) => member.label)).size, 3);
  assert.ok('messageId' in round.delivery);

  const delivered = await f.messages.getById(round.delivery.messageId);
  assert.ok(isWatcherPanelDelivery(delivered));
  assert.deepEqual(delivered.from, { kind: 'system', service: 'watcher-panel' });
  assert.equal(delivered.catId, null);
  for (const catId of MEMBERS) assert.equal(delivered.content.includes(catId), false, `${catId} stays unnamed`);
  for (const catId of MEMBERS) assert.equal(JSON.stringify(delivered.source).includes(catId), false);
  assert.match(delivered.content, /第一句/);
  assert.match(delivered.content, /第二句/);
  assert.equal(getMessageDisplayName(delivered), '守望猫');
  assert.equal(getMessageSpeakerName(delivered), '守望猫', 'the history read tool names no member either');
  assert.equal(isDisplayOnlySystemMessage(delivered), false, 'the worker reads it as ordinary history');
  const spokeLabels = round.members.filter((member) => member.status === 'spoke').map((member) => member.label);
  for (const label of spokeLabels) assert.match(delivered.content, new RegExp(`\\*\\*${label}\\*\\*`));

  const entries = f.queue.list(f.thread.id, OWNER);
  assert.equal(entries.length, 1, 'one wake for all sentences');
  assert.deepEqual(entries[0].targetCats ?? entries[0].targets, [source.catId]);
  assert.equal(f.published.length, 1);

  f.runner.offer(source, 0);
  await f.runner.idle();
  assert.equal(f.calls.length, 3, 'the same settled turn never opens a second round');
});

test('a turn woken by the panel is looked at but never answered with another delivery', async () => {
  const f = await panelWorld({
    runMember: () => ({ sentence: '再说一句' }),
  });
  const [first] = await f.work('第一轮');
  f.runner.offer(first, 0);
  await f.runner.idle();
  const delivery = (await f.ledger.get(watcherPanelRoundId(first.invocationId))).delivery;
  const [woken] = await f.work('收到，改了');
  const wokenSource = { ...woken, causal: { ...woken.causal, triggerMessageId: delivery.messageId } };
  f.runner.offer(wokenSource, 0);
  await f.runner.idle();
  const round = await f.ledger.get(watcherPanelRoundId(woken.invocationId));
  assert.equal(round.quiet, 'woken_by_watcher');
  assert.equal(f.calls.filter((call) => call.round.quiet === 'woken_by_watcher').length, 3, 'all three still look');
  assert.equal(round.members.filter((member) => member.status === 'spoke').length, 3, 'what they would say is kept');
  assert.deepEqual(round.delivery, { skipped: 'quiet' });
  assert.equal(f.queue.list(f.thread.id, OWNER).length, 1, 'no second wake');
});

test('member runs share one bounded set of slots across the panel', async () => {
  let running = 0;
  let peak = 0;
  const f = await panelWorld({
    maxConcurrentRuns: 2,
    runMember: async (input) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running--;
      return undefined;
    },
  });
  const [source] = await f.work('并发');
  f.runner.offer(source, 0);
  await f.runner.idle();
  assert.equal(peak, 2);
  assert.equal(f.calls.length, 3);
});

test('turns that settle during a round collapse into the newest one', async () => {
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const f = await panelWorld({
    runMember: async (input) => {
      if (input.source.invocationId === firstId) await gate;
      return undefined;
    },
  });
  const [first] = await f.work('一');
  const firstId = first.invocationId;
  f.runner.offer(first, 0);
  const [second] = await f.work('二');
  const [third] = await f.work('三');
  f.runner.offer(second, 0);
  f.runner.offer(third, 0);
  open();
  await f.runner.idle();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const coalesced = await f.ledger.get(watcherPanelRoundId(second.invocationId));
  assert.equal(coalesced.status, 'coalesced');
  assert.equal(coalesced.coalescedInto, watcherPanelRoundId(third.invocationId));
  assert.equal((await f.ledger.get(watcherPanelRoundId(third.invocationId))).status, 'completed');
  assert.equal(f.calls.filter((call) => call.source.invocationId === second.invocationId).length, 0);
});

test('a member resumes from its own last cutoff only through the ledger', async () => {
  const f = await panelWorld();
  const [first] = await f.work('一');
  f.runner.offer(first, 0);
  await f.runner.idle();
  const proven = await f.ledger.get(watcherPanelRoundId(first.invocationId));
  for (const entry of proven.members) {
    await f.executions.createRunning({
      invocationId: entry.invocationId,
      parentInvocationId: `watcher-panel:${proven.roundId}:${entry.catId}`,
      userId: OWNER,
      threadId: f.thread.id,
      catId: entry.catId,
      executionKind: 'watcher',
      startedAt: proven.createdAt,
      causal: { watcherPanelRoundId: proven.roundId },
    });
    await f.executions.transitionTerminal(entry.invocationId, {
      status: 'succeeded',
      endedAt: Date.now(),
      terminalReason: 'watcher_panel_quiet',
    });
  }
  const [second] = await f.work('二');
  f.runner.offer(second, 0);
  await f.runner.idle();
  const firstRound = await f.ledger.get(watcherPanelRoundId(first.invocationId));
  const later = f.calls.filter((call) => call.source.invocationId === second.invocationId);
  assert.equal(later.length, 3);
  for (const call of later) {
    assert.equal(call.previous.cutoffAt, firstRound.cutoffAt);
    assert.equal(call.previous.sessionId, `s-${call.catId}`);
    assert.ok(call.previous.settledReplyIds.includes(second.responseSettlement.messageId));
  }
  assert.equal(firstRound.cutoffAt, first.responseSettlement.settledAt, 'the lock is the settlement time');
});

test('with the panel off nothing is judged, recorded or delivered', async () => {
  const f = await panelWorld({ enabled: false });
  const [source] = await f.work('关着');
  f.runner.offer(source, 0);
  await f.runner.idle();
  assert.equal(f.calls.length, 0);
  assert.equal(await f.ledger.get(watcherPanelRoundId(source.invocationId)), null);
  assert.equal(f.queue.list(f.thread.id, OWNER).length, 0);
});

test('turns at or below the activation floor are never opportunities', async () => {
  const f = await panelWorld();
  const [source] = await f.work('之前');
  f.runner.offer(source, source.settledSequence);
  await f.runner.idle();
  assert.equal(f.calls.length, 0);
});

test('a restart closes in-flight rounds and their watcher executions honestly', async () => {
  const f = await panelWorld();
  const [source] = await f.work('跑到一半');
  const roundId = watcherPanelRoundId(source.invocationId);
  await f.ledger.save({
    v: 1,
    roundId,
    userId: OWNER,
    threadId: f.thread.id,
    sourceInvocationId: source.invocationId,
    sourceSettledSequence: source.settledSequence,
    workerCatId: source.catId,
    cutoffMessageId: 'cut',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'running',
    guidanceDigest: 'sha256:test',
    members: [{ catId: 'gpt52', label: '甲', status: 'running', invocationId: 'panel-run' }],
  });
  await f.executions.createRunning({
    invocationId: 'panel-run',
    parentInvocationId: `watcher-panel:${roundId}:gpt52`,
    userId: OWNER,
    threadId: f.thread.id,
    catId: 'gpt52',
    executionKind: 'watcher',
    startedAt: Date.now(),
    causal: { watcherSourceInvocationId: source.invocationId, watcherPanelRoundId: roundId },
  });
  await f.runner.reconcile();
  const round = await f.ledger.get(roundId);
  assert.equal(round.status, 'interrupted');
  assert.equal(round.members[0].status, 'interrupted');
  const execution = await f.executions.get('panel-run');
  assert.equal(execution.status, 'canceled');
  assert.ok(execution.responseSettlement);
});

test('a held sentence must cite this thread up to the lock, once per member, while the round runs', async () => {
  const receipts = [];
  const f = await panelWorld({
    runMember: async (input) => {
      if (input.catId !== 'gpt52') return undefined;
      const invocationId = `inv-${input.source.invocationId}-${input.catId}`;
      const nudge = (sourceMessageId) =>
        f.runner.acceptNudge({
          invocationId,
          userId: OWNER,
          threadId: input.round.threadId,
          sentence: '看这里',
          sourceMessageId,
        });
      receipts.push(await nudge('not-in-thread'));
      receipts.push(await nudge(input.cutoff.id));
      receipts.push(await nudge(input.cutoff.id));
      return undefined;
    },
  });
  const [source] = await f.work('引用');
  f.runner.offer(source, 0);
  await f.runner.idle();
  assert.deepEqual(
    receipts.map((receipt) => receipt.accepted || receipt.reason),
    ['citation_outside_material', true, 'already_spoke'],
  );
  const late = await f.runner.acceptNudge({
    invocationId: `inv-${source.invocationId}-gpt52`,
    userId: OWNER,
    threadId: f.thread.id,
    sentence: '晚了',
    sourceMessageId: source.responseSettlement.messageId,
  });
  assert.deepEqual(late, { accepted: false, reason: 'not_current' });
  assert.equal(await f.runner.maySpeak(`inv-${source.invocationId}-gpt52`), false);
});

test('members that also work in the thread are marked, the worker itself included', async () => {
  const f = await panelWorld();
  await f.configs.updateWatcherConfig(OWNER, 1, {
    panel: { enabled: true, members: [{ catId: 'codex' }, { catId: 'gpt52' }], maxConcurrentRuns: 6 },
  });
  await f.sessions.getOrCreateActive({ userId: OWNER, catId: 'gpt52', threadId: f.thread.id });
  const [source] = await f.work('谁在这条线干活');
  f.runner.offer(source, 0);
  await f.runner.idle();
  const round = await f.ledger.get(watcherPanelRoundId(source.invocationId));
  assert.deepEqual(Object.fromEntries(round.members.map((member) => [member.catId, member.alsoWorksHere])), {
    codex: 'worker',
    gpt52: 'participant',
  });
});
