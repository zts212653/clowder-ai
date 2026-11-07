import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { MessageSearchService } from '../../dist/domains/memory/MessageSearchService.js';
import { MessageQueryQualifier } from '../../dist/domains/memory/message-query-qualifier.js';
import { executeMessageSearch } from '../../dist/routes/message-search-handler.js';

// Same candidate/batch sizes as req-ab9e, using synthetic bodies and controlled
// time. No model, production request, or claim about the original missing 369ms.
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
  const events = [];
  const traces = [];
  const batches = [];
  let projection = false;
  let cleaned = false;
  let releaseFast;
  let bothStarted;
  let fastDone;
  const started = new Promise((resolve) => {
    bothStarted = resolve;
  });
  const completed = new Promise((resolve) => {
    fastDone = resolve;
  });
  let supported;
  let lookupCalls = 0;
  let lookupDeadline;
  let finalReads = 0;
  const reply = {
    statusCode: 200,
    raw: Object.assign(new EventEmitter(), { writableEnded: false }),
    status(code) {
      this.statusCode = code;
      return this;
    },
    log: { info: (value) => traces.push(value.messageSearchTrace), warn() {} },
  };
  const qualifier = new MessageQueryQualifier(async (batch, context) => {
    batches.push(batch);
    const fast = batch.rows.length === 8;
    assert.equal(
      batch.rows.reduce((n, row) => n + row.body.length, 0),
      fast ? 12891 : 28927,
    );
    let close;
    context.onTeardown(
      new Promise((resolve) => {
        close = resolve;
      }),
    );
    if (batches.length === 2) bothStarted();
    if (fast) {
      await new Promise((resolve) => {
        releaseFast = resolve;
      });
      supported = batch.rows.slice(0, 2).map((row) => row.messageId);
      const text = JSON.stringify({
        requestId: batch.requestId,
        rows: batch.rows.map((row, i) => [
          row.id,
          i < 2 ? 'supported' : i === 7 ? 'indeterminate' : 'rejected',
          i < 2 ? row.body.slice(0, 30) : null,
        ]),
      });
      assert.equal(context.onResult(text), true);
      close();
      events.push('fast-closed');
      fastDone();
      return text;
    }
    if (early) {
      close();
      return JSON.stringify({ requestId: batch.requestId, rows: [] });
    }
    await new Promise((resolve) =>
      context.signal.addEventListener(
        'abort',
        () => {
          events.push('slow-aborted');
          setTimeout(
            () => {
              cleaned = true;
              close();
              events.push('slow-closed');
              if (change === 'revision') messages.get(supported[0]).content = 'revised after qualification';
              if (change === 'thread') threads[0].createdBy = 'another-owner';
              if (change === 'source') messages.get('question').deletedAt = Date.now();
              if (change === 'external') reply.raw.emit('close');
              resolve();
            },
            change === 'cleanup expiry' ? 2001 : 1630,
          );
        },
        { once: true },
      ),
    );
    throw context.signal.reason;
  });
  const service = new MessageSearchService({
    qualifier,
    threadStore: { list: () => threads, get: (id) => threads.find((row) => row.id === id) },
    messageStore: {
      getById(id) {
        if (id !== 'question' && !projection) {
          projection = true;
          t.mock.timers.tick(1069);
        }
        if (cleaned || (early && lookupCalls)) {
          finalReads++;
          if (id === 'question') {
            events.push('final-source');
            t.mock.timers.tick(change === 'final expiry' ? 250 : 9);
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
        lookupCalls++;
        lookupDeadline = context.deadlineAt;
        events.push('decision-sources');
        // Respect the supplied deadline, as the real Git index does. Even optional
        // bounded work can use the last milliseconds needed for mandatory checks.
        t.mock.timers.tick(Math.min(370, Math.max(0, context.deadlineAt - Date.now())));
        if (Date.now() >= context.deadlineAt) return { status: 'unavailable', facts: new Map() };
        return {
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
        };
      },
    },
  });
  const pending = executeMessageSearch(
    service,
    { query: '审稿人 读论文 视频 taste', mode: 'hybrid', sort: 'relevance', limit: 10 },
    {
      userId: 'owner',
      viewer: { type: 'cat', catId: 'codex61-sol' },
      source: { threadId: 'source', messageId: 'question' },
    },
    reply,
  );
  await started;
  t.mock.timers.tick(6281);
  releaseFast();
  await completed;
  if (!early) {
    // Model a timer that could not run until 124ms after its original cutoff;
    // cleanup still takes 1630ms and the total request deadline stays 15000ms.
    t.mock.timers.setTime(start + 13124);
    t.mock.timers.tick(0);
    t.mock.timers.tick(change === 'cleanup expiry' ? 2001 : 1630);
  }
  const response = await pending;
  assert.equal(batches.length, 2);
  return {
    response,
    status: reply.statusCode,
    elapsed: Date.now() - start,
    lookupCalls,
    lookupDeadline,
    finalReads,
    supported,
    events,
    traces,
    start,
  };
}

for (const change of ['none', 'revision', 'thread']) {
  test(`completed fast batch survives slow cleanup without optional enrichment stealing final admission: ${change}`, async (t) => {
    const f = await search(t, change);
    assert.equal(f.status, 200);
    assert.ok(f.elapsed < 15000);
    assert.equal(f.lookupCalls, 0, 'after the work cutoff, optional facts cannot consume cleanup/admission time');
    assert.deepEqual(f.response.meta.decisionIndex, { status: 'unavailable' });
    const count = change === 'none' ? 2 : change === 'revision' ? 1 : 0;
    assert.equal(f.response.results.length, count);
    assert.equal(f.response.meta.qualification.supported, count);
    assert.equal(f.response.meta.qualification.unassessed, 1968 + 2 - count);
    assert.equal(f.response.meta.qualification.indeterminate, 1);
    assert.deepEqual(f.response.meta.qualification.batches, { started: 2, completed: 1, cancelled: 1, failed: 0 });
    assert.ok(f.finalReads >= 3, 'source and each supported message must still be readmitted');
    assert.ok(f.events.indexOf('final-source') > f.events.indexOf('slow-closed'));
    assert.ok(f.traces.some((row) => row.phase === 'decision-sources'));
    assert.ok(JSON.stringify(f.response).length <= 24000);
  });
}

for (const change of ['source', 'external', 'final expiry', 'cleanup expiry']) {
  test(`partial support cannot bypass ${change}`, async (t) => {
    const f = await search(t, change);
    assert.equal(f.status, change === 'source' ? 403 : 503);
    assert.equal(f.response.results, undefined);
    if (change.endsWith('expiry')) assert.equal(f.response.degradeReason, 'message_search_timeout');
    assert.ok(f.events.includes('slow-closed'), 'publication/error still waits for runner cleanup');
  });
}

test('optional facts still attach when work finishes early, within the original work budget', async (t) => {
  const f = await search(t, 'none', true);
  assert.equal(f.status, 200);
  assert.equal(f.lookupCalls, 1);
  assert.equal(f.lookupDeadline, f.start + 13000);
  assert.equal(f.response.results.length, 2);
  assert.ok(f.response.results.every((row) => row.decisionSources[0].conclusion === 'synthetic fact'));
  assert.ok(f.finalReads >= 3);
});
