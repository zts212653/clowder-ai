import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { MessageSearchService } from '../../dist/domains/memory/MessageSearchService.js';
import { executeMessageSearchOperation } from '../../dist/routes/message-search-handler.js';

// Preserve the 1976-row, long-body input and 15s request from the retired runner
// test. Optional ledger I/O now exercises the same final-admission reserve.
async function search(t, change = 'none', early = false) {
  const start = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: start });
  const lengths = [2000, 1900, 2100, 100, 100, 100, 100, 100, 100, 10291, 24927];
  const messages = new Map();
  const passages = Array.from({ length: 1976 }, (_, i) => {
    const id = `0001800000000000-${String(i).padStart(6, '0')}-1234abcd`;
    const prefix = `审稿人 evidence ${i}. `;
    const content = prefix + '.'.repeat((lengths[i] ?? 100) - prefix.length);
    messages.set(id, { id, threadId: 'results', userId: 'owner', catId: null, content, timestamp: i + 1 });
    return {
      threadId: 'results',
      messageId: id,
      content,
      docAnchor: 'thread-results',
      passageId: `msg-${id}`,
      match: 'lexical',
    };
  });
  messages.set('question', {
    id: 'question',
    threadId: 'source',
    userId: 'owner',
    catId: null,
    content: 'question',
    timestamp: 1,
  });
  const threads = [
    { id: 'results', createdBy: 'owner' },
    { id: 'source', createdBy: 'owner' },
  ];
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let finishLedger, rejectLedger;
  const heldLedger = new Promise((resolve, reject) => {
    finishLedger = resolve;
    rejectLedger = reject;
  });
  const events = [],
    traces = [];
  let projection = false,
    final = false,
    finalReads = 0,
    lookupDeadline;
  const reply = {
    statusCode: 200,
    raw: Object.assign(new EventEmitter(), { writableEnded: false }),
    status(code) {
      this.statusCode = code;
      return this;
    },
    log: { info: (value) => traces.push(value.messageSearchTrace), warn() {} },
  };
  const facts = (rows) => ({
    status: 'ready',
    revision: 'a'.repeat(40),
    facts: new Map(
      rows.map((row) => [
        `${row.threadId}:${row.messageId}`,
        [
          {
            status: 'decided',
            conclusion: 'synthetic fact',
            featureId: 'F322',
            documentPath: 'docs/features/F322-everyday-work-experience.md',
            documentRevision: 'a'.repeat(40),
            line: 1,
          },
        ],
      ]),
    ),
  });
  const service = new MessageSearchService({
    get qualifier() {
      throw new Error('Generative qualification is retired');
    },
    threadStore: { list: () => threads, get: (id) => threads.find((row) => row.id === id) },
    messageStore: {
      getById(id) {
        if (id !== 'question' && !projection) {
          projection = true;
          t.mock.timers.tick(1069);
        }
        if (final) {
          finalReads++;
          if (id === 'question') {
            events.push('final-source');
            t.mock.timers.tick(change === 'final expiry' ? 2100 : 9);
          }
        }
        return messages.get(id);
      },
    },
    evidenceStore: {
      readMessagePassageState: () => ({ current: true }),
      searchMessagePassages: async () => {
        t.mock.timers.tick(2944);
        return { passages, meta: { candidateLimit: 2000, effectiveMode: 'hybrid' } };
      },
    },
    decisionIndex: {
      async lookup(rows, context) {
        lookupDeadline = context.deadlineAt;
        events.push('decision-sources');
        entered();
        if (!early) await heldLedger;
        else t.mock.timers.tick(370);
        final = true;
        return facts(rows);
      },
    },
  });
  const pending = executeMessageSearchOperation(
    (execution) =>
      service.search(
        { query: '审稿人 读论文 视频 taste', mode: 'hybrid', sort: 'relevance', limit: 10 },
        {
          userId: 'owner',
          viewer: { type: 'cat', catId: 'codex61-sol' },
          source: { threadId: 'source', messageId: 'question' },
        },
        execution,
      ),
    reply,
  );
  await started;
  if (!early) {
    // A delayed timer runs at 13124ms. The original 15000ms hard deadline stays.
    t.mock.timers.setTime(start + 13124);
    t.mock.timers.tick(0);
    final = true;
    if (change === 'revision') messages.get(passages[0].messageId).content = 'revised after optional work';
    if (change === 'thread') threads[0].createdBy = 'another-owner';
    if (change === 'source') messages.get('question').deletedAt = Date.now();
    if (change === 'external') reply.raw.emit('close');
  }
  const response = await pending;
  // Finish abandoned work after delivery; neither success nor rejection can alter it.
  if (change === 'late rejection') rejectLedger(new Error('late optional failure'));
  else finishLedger();
  await Promise.resolve();
  await Promise.resolve();
  return {
    response,
    status: reply.statusCode,
    elapsed: Date.now() - start,
    lookupDeadline,
    finalReads,
    events,
    traces,
    start,
    passages,
  };
}

for (const change of ['none', 'revision', 'thread']) {
  test(`ordinary sources survive abandoned enrichment with current final admission: ${change}`, async (t) => {
    const f = await search(t, change);
    assert.equal(f.status, 200);
    assert.ok(f.elapsed < 15000);
    assert.deepEqual(f.response.meta.decisionIndex, { status: 'unavailable' });
    assert.equal(f.response.results.length, change === 'thread' ? 0 : 10);
    assert.equal(f.response.meta.qualification, undefined);
    if (change === 'revision') assert.ok(f.response.results.every((row) => row.messageId !== f.passages[0].messageId));
    assert.ok(f.finalReads >= 12, 'authenticated source and all page/witness rows are readmitted');
    assert.ok(f.events.includes('final-source'));
    assert.ok(JSON.stringify(f.response).length <= 24000);
  });
}
for (const change of ['source', 'external', 'final expiry']) {
  test(`ordinary partial sources cannot bypass ${change}`, async (t) => {
    const f = await search(t, change);
    assert.equal(f.status, change === 'source' ? 403 : 503);
    assert.equal(f.response.results, undefined);
    if (change === 'final expiry') assert.equal(f.response.degradeReason, 'message_search_timeout');
  });
}
test('abandoned optional I/O can reject after delivery without delaying or mutating safe sources', async (t) => {
  const f = await search(t, 'late rejection');
  assert.equal(f.status, 200);
  assert.equal(f.response.results.length, 10);
  assert.ok(f.response.results.every((row) => !row.decisionSources));
  assert.ok(f.elapsed < 15000);
});
test('optional facts attach when finished within the unchanged original work reserve', async (t) => {
  const f = await search(t, 'none', true);
  assert.equal(f.status, 200);
  assert.equal(f.lookupDeadline, f.start + 13000);
  assert.equal(f.response.results.length, 10);
  assert.ok(f.response.results.every((row) => row.decisionSources[0].conclusion === 'synthetic fact'));
  assert.ok(f.finalReads >= 12);
});
