import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { projectInvocationSettlement } from '../src/domains/cats/services/agents/invocation/InvocationSettlementProjection.ts';
import { resolveActiveInvocationsStrict } from '../src/domains/cats/services/agents/invocation/live-invocation-projection.ts';
import {
  createContentFreeFreshnessNotice,
  FreshnessNoticeBroker,
} from '../src/domains/cats/services/freshness/FreshnessNoticeBroker.ts';
import { decideFreshnessRelevance } from '../src/domains/cats/services/freshness/FreshnessRelevancePolicy.ts';
import { ThreadUnseenChecker } from '../src/domains/cats/services/freshness/ThreadUnseenChecker.ts';
import { observeCliExecutionProcess } from '../src/utils/CliExecutionObservation.ts';

function projectionFixture(id) {
  const threadId = `projection-${id}`;
  const userId = 'isolated-projection-owner';
  const parent = `parent-${id}`;
  const child = `guard-${id}`;
  const activeRun = {
    threadId,
    targetId: 'opus',
    invocationId: child,
    responseMessageId: `response-${id}`,
    inputEntryIds: [],
    inputMessageIds: [],
    privateInputEntryIds: [],
    startedAt: 30,
  };
  const children = [
    {
      invocationId: `primary-${id}`,
      parentInvocationId: parent,
      threadId,
      userId,
      catId: 'opus',
      status: 'succeeded',
      executionKind: 'ordinary',
      startedAt: 10,
      endedAt: 20,
      updatedAt: 20,
    },
    {
      invocationId: child,
      parentInvocationId: parent,
      threadId,
      userId,
      catId: 'opus',
      status: 'running',
      executionKind: 'routing_guard',
      startedAt: 30,
      updatedAt: 30,
    },
  ];
  let reads = 0;
  const tracker = {
    getUserId: () => userId,
    getExecutionId: () => parent,
    getActiveSlots: () => [{ catId: 'opus', startedAt: 10, activeRun }],
  };
  const records = {
    listRunningByThread: async () => [
      { id: parent, threadId, userId, targetCats: ['opus'], status: 'running', createdAt: 10, updatedAt: 30 },
    ],
  };
  const turns = {
    listByParent: async () => {
      reads += 1;
      return structuredClone(children);
    },
  };
  return {
    threadId,
    userId,
    parent,
    child,
    activeRun,
    children,
    reads: () => reads,
    resolve: (status) => resolveActiveInvocationsStrict(threadId, userId, tracker, records, status, turns),
  };
}

test('native freshness instruction selects unread without confusing full projection with selection', () => {
  const notice = createContentFreeFreshnessNotice({ threadId: 'isolated-thread', unseenCount: 3 });
  assert.match(notice, /readIntent: "unread"/);
  assert.match(notice, /responseMode: "full"/);
  assert.match(notice, /contextScope=unread_delta/);
  assert.match(notice, /不表示完整历史/);
});

test('actual canonical slot projects public settlement only with exact live auxiliary child evidence', async (t) => {
  const f = projectionFixture('auxiliary');
  const before = structuredClone(f.children);
  assert.equal((await f.resolve())[0].settlement, undefined, 'a running ledger row alone is not a native owner');
  const process = new EventEmitter();
  observeCliExecutionProcess(process, {
    threadId: f.threadId,
    userId: f.userId,
    catId: 'opus',
    executionId: f.parent,
    invocationId: f.child,
  });
  t.after(() => process.emit('exit', 0, null));
  const projected = await f.resolve();
  assert.deepEqual(projected[0].settlement, {
    activeTurnInvocationId: f.child,
    completedTurnInvocationIds: ['primary-auxiliary'],
  });
  assert.deepEqual(projected[0].activeRun, f.activeRun);
  assert.equal(
    f.reads(),
    2,
    'one canonical child snapshot per projection; do not independently reread to manufacture a lineage',
  );
  assert.deepEqual(f.children, before, 'read-only projection does not mutate execution truth');
});

test('terminal response filtering remains authoritative even when an auxiliary native process is still live', async (t) => {
  const f = projectionFixture('terminal');
  const process = new EventEmitter();
  observeCliExecutionProcess(process, {
    threadId: f.threadId,
    userId: f.userId,
    catId: 'opus',
    executionId: f.parent,
    invocationId: f.child,
  });
  t.after(() => process.emit('exit', 0, null));
  assert.deepEqual(await f.resolve(async () => 'terminal'), []);
});

test('same canonical resolver does not borrow terminal lineage from a foreign scope or a later child', async (t) => {
  const f = projectionFixture('scope');
  const process = new EventEmitter();
  observeCliExecutionProcess(process, {
    threadId: f.threadId,
    userId: f.userId,
    catId: 'opus',
    executionId: f.parent,
    invocationId: f.child,
  });
  t.after(() => process.emit('exit', 0, null));
  const primary = f.children[0];
  for (const delta of [
    { parentInvocationId: 'foreign-parent' },
    { threadId: 'foreign-thread' },
    { userId: 'foreign-owner' },
    { catId: 'foreign-cat' },
    { status: 'failed' },
    { status: 'canceled' },
    { endedAt: 31 },
    { endedAt: undefined },
  ]) {
    f.children[0] = { ...primary, ...delta };
    assert.equal((await f.resolve())[0].settlement, undefined, JSON.stringify(delta));
  }
  f.children[0] = primary;
  assert.ok((await f.resolve())[0].settlement);
});

test('auxiliary settlement ends with native process exit and cannot describe an ordinary child', async () => {
  const f = projectionFixture('exit');
  const owner = { threadId: f.threadId, userId: f.userId, catId: 'opus', executionId: f.parent, invocationId: f.child };
  const scope = { ...owner, turnInvocationId: f.child };
  const process = new EventEmitter();
  observeCliExecutionProcess(process, owner);
  try {
    assert.ok(projectInvocationSettlement(scope, f.children));
    assert.equal(
      projectInvocationSettlement(scope, [f.children[0], { ...f.children[1], executionKind: 'ordinary' }]),
      undefined,
    );
    assert.equal(
      projectInvocationSettlement(scope, [f.children[0], { ...f.children[1], status: 'failed' }]),
      undefined,
    );
  } finally {
    process.emit('exit', 0, null);
  }
  assert.equal(projectInvocationSettlement(scope, f.children), undefined);
  assert.equal((await f.resolve())[0].settlement, undefined);
});

test('bounded live-exposure scan is incomplete, resumes, and neither acknowledges nor publishes queued work', async () => {
  let cursorReads = 0;
  let cursorWrites = 0;
  const rows = Array.from({ length: 210 }, (_, i) => ({
    id: String(i + 1),
    visibilitySeq: i + 1,
    threadId: 'scan-thread',
    userId: 'scan-owner',
    catId: null,
    from: { kind: 'user', userId: 'scan-owner' },
    content: 'owned synthetic scan fixture',
  }));
  const checker = new ThreadUnseenChecker({
    userId: 'scan-owner',
    cursorStore: {
      getSeenCursor: async () => {
        cursorReads += 1;
        return '0';
      },
      setSeenCursor: () => {
        cursorWrites += 1;
      },
    },
    messageStore: {
      getByThreadAfter: async (_tid, after, limit) => {
        const id = after.startsWith('v2:') ? after.split(':').at(-1) : after;
        return rows.slice(Number(id), Number(id) + limit);
      },
    },
    exposureReason: (row) => (Number(row.id) <= 200 ? 'same_live_call_exposure' : null),
  });
  const first = await checker.checkUnseen({ threadId: 'scan-thread', catId: 'opus' });
  assert.deepEqual(first, { kind: 'incomplete', reason: 'scan_cap', scanned: 200 });
  const second = await checker.checkUnseen({ threadId: 'scan-thread', catId: 'opus' });
  assert.equal(second.count, 10);
  assert.deepEqual(
    second.correlationMessageIds,
    rows.slice(200).map((x) => x.id),
  );
  assert.equal(cursorReads, 2);
  assert.equal(cursorWrites, 0);
});

test('native broker emits no notice or delivery receipt for an incomplete scan', async () => {
  const events = [];
  const broker = new FreshnessNoticeBroker({
    context: { invocationId: 'scan-child', threadId: 'scan-thread', catId: 'opus' },
    checkUnseen: async () => ({ kind: 'incomplete', reason: 'scan_cap', scanned: 200 }),
    appendEvent: async (event) => events.push(event),
  });
  assert.equal(
    await broker.prepare({
      provider: 'openai_codex',
      carrier: 'app_server',
      deliverySemantics: 'same_turn',
      toolSurface: 'mcp',
      turnId: 'scan-turn',
    }),
    null,
  );
  assert.deepEqual(events, []);
});

test('fork retired post-message gate, MCP piggyback and notice-driven reinvoke are not resurrected', () => {
  for (const name of ['checkFreshnessForPostMessage', 'FreshnessNoticeService', 'createFreshnessReinvokeCheck']) {
    assert.equal(
      existsSync(new URL(`../src/domains/cats/services/freshness/${name}.ts`, import.meta.url)),
      false,
      name,
    );
  }
});

test('retained pure relevance distinguishes old closure annotation without turning it into a delivery carrier', () => {
  const message = { id: 'relevance', catId: null, content: 'synthetic annotation', extra: {} };
  message.extra.freshness = { priorFrontierMessageId: 'old' };
  assert.deepEqual(decideFreshnessRelevance(message, { catId: 'opus' }), { relevant: true, reason: 'relevant' });
  message.extra.freshness = { kind: 'closure_replacement', closureId: 'old-closure', targetCatId: 'astra' };
  assert.deepEqual(decideFreshnessRelevance(message, { catId: 'opus' }), {
    relevant: false,
    reason: 'closure_replacement_for_other_cat',
  });
  assert.deepEqual(decideFreshnessRelevance(message, { catId: 'astra' }), { relevant: true, reason: 'relevant' });
});
