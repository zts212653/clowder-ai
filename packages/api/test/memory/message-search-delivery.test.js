import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageSearchService } from '../../dist/domains/memory/MessageSearchService.js';

// Real service/canonical admission; controlled recall, no provider or production data.
function fixture(count = 12) {
  const messages = new Map();
  const passages = Array.from({ length: count }, (_, i) => {
    const id = `message-${i}`;
    const content = i === 0 ? '新伙伴的称呼终于敲定了。' : `Mira 起名的原始讨论 ${i}。`;
    messages.set(id, {
      id,
      threadId: 'visible',
      userId: 'owner',
      catId: null,
      content,
      timestamp: 1000 + i,
    });
    return {
      threadId: 'visible',
      messageId: id,
      docAnchor: 'thread-visible',
      passageId: `msg-${id}`,
      content,
      match: i === 0 ? 'semantic' : 'lexical',
    };
  });
  const thread = { id: 'visible', title: 'Names', createdBy: 'owner' };
  let calls = 0;
  const reads = [];
  const options = [];
  const deps = {
    qualifier: {
      qualify() {
        calls++;
        throw new Error('Generative qualification is retired');
      },
    },
    messageStore: {
      getById: (id) => {
        reads.push(id);
        return messages.get(id);
      },
    },
    threadStore: { get: () => thread, list: () => [thread] },
    evidenceStore: {
      readMessagePassageState: () => ({ current: true }),
      searchMessagePassages: async (_query, input) => {
        options.push(input);
        return {
          passages,
          meta: { effectiveMode: 'hybrid', degraded: false, candidateLimit: 2000, semanticCandidatesLimited: true },
        };
      },
    },
  };
  return { deps, messages, passages, reads, options, calls: () => calls, thread };
}
const principal = { userId: 'owner', viewer: { type: 'cat', catId: 'codex61-sol' } };
const input = { query: 'Mira 起名', sort: 'relevance', limit: 2 };

test('ordinary search returns admitted literal and semantic sources without any generative judge', async () => {
  const f = fixture();
  const result = await new MessageSearchService(f.deps).search(input, principal);
  assert.equal(f.calls(), 0, 'ordinary recall must never call a judge, even with ample remaining budget');
  assert.deepEqual(
    result.results.map((row) => row.messageId),
    ['message-0', 'message-1'],
  );
  assert.equal(
    result.meta.qualification,
    undefined,
    'raw source rows must not impersonate historical supported verdicts',
  );
  assert.equal(result.meta.hasMore, true);
  assert.equal(result.results[0].match, 'semantic');
  assert.deepEqual(result.results[0].highlights, []);
  assert.deepEqual(result.results[0].matchEvidence, { kind: 'semantic', terms: [] });
  assert.deepEqual(result.results[1].matchEvidence, { kind: 'literal', terms: ['Mira', '起名'] });
});

test('both sorts request the same relevance queue while reporting the requested presentation', async () => {
  const f = fixture();
  f.messages.get('message-11').timestamp = 100;
  const result = await new MessageSearchService(f.deps).search({ ...input, sort: 'time' }, principal);
  assert.equal(
    f.options[0].candidateOrder,
    'relevance',
    'time cannot ask the reader to discard newer relevant sources before LIMIT',
  );
  assert.equal(result.meta.sort, 'time');
  assert.equal(result.results[0].messageId, 'message-11');
});

test('relevance stops after limit plus one admitted source, including semantic-only candidates', async () => {
  const f = fixture(2000);
  const result = await new MessageSearchService(f.deps).search(input, principal);
  assert.equal(result.results.length, 2);
  assert.ok(f.reads.length <= 6, `only page/witness and final reads are needed; got ${f.reads.length}`);
});

test('optional projection stops early enough to final-admit safe rows before the unchanged 15 seconds', async (t) => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const f = fixture(2000);
  const original = f.deps.evidenceStore.searchMessagePassages;
  f.deps.evidenceStore.searchMessagePassages = async (...args) => {
    t.mock.timers.tick(8000);
    return original(...args);
  };
  f.deps.messageStore.getById = (id) => {
    t.mock.timers.tick(200);
    return f.messages.get(id);
  };
  const result = await new MessageSearchService(f.deps).search({ ...input, sort: 'time' }, principal);
  assert.ok(result.results.length > 0);
  assert.ok(Date.now() - now < 15000);
  assert.equal(result.meta.partial, true);
  assert.equal(result.meta.timeWindow.complete, false);
});

test('a source revised during optional enrichment is dropped individually before publication', async () => {
  const f = fixture();
  f.deps.decisionIndex = {
    lookup: async () => {
      f.messages.get('message-0').content = 'updated source';
      return { status: 'ready', revision: 'a'.repeat(40), facts: new Map() };
    },
  };
  const result = await new MessageSearchService(f.deps).search(input, principal);
  assert.deepEqual(
    result.results.map((row) => row.messageId),
    ['message-1', 'message-2'],
  );
  assert.equal(result.meta.partial, true);
});

test('a complete time window discloses when final admission stops before filling the requested page', async (t) => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ['Date'], now });
  const f = fixture(32);
  let finalRead = false;
  f.deps.decisionIndex = {
    lookup: async () => {
      finalRead = true;
      return { status: 'unavailable', facts: new Map() };
    },
  };
  f.deps.messageStore.getById = (id) => {
    if (finalRead) t.mock.timers.tick(450);
    return f.messages.get(id);
  };
  const result = await new MessageSearchService(f.deps).search({ ...input, sort: 'time', limit: 20 }, principal, {
    deadlineAt: now + 4000,
  });
  assert.deepEqual(result.meta.timeWindow, { limit: 32, admitted: 32, complete: true });
  assert.equal(result.results.length, 8);
  assert.equal(result.meta.hasMore, true);
  assert.match(result.notice.coverage, /仅列出本次可得的部分来源/);
  assert.ok(Date.now() < now + 4000);
});

test('external cancellation still fails the whole search after readable rows were collected', async () => {
  const f = fixture();
  const controller = new AbortController();
  f.deps.decisionIndex = {
    lookup: async () => {
      controller.abort(new DOMException('caller canceled', 'AbortError'));
      return { status: 'unavailable', facts: new Map() };
    },
  };
  await assert.rejects(new MessageSearchService(f.deps).search(input, principal, { signal: controller.signal }), {
    name: 'AbortError',
  });
});

test('all individually revised sources produce an empty partial response rather than a whole-query failure', async () => {
  const f = fixture();
  f.deps.decisionIndex = {
    lookup: async () => {
      for (const message of f.messages.values()) message.content = 'revised source';
      return { status: 'unavailable', facts: new Map() };
    },
  };
  const result = await new MessageSearchService(f.deps).search(input, principal);
  assert.deepEqual(result.results, []);
  assert.equal(result.meta.partial, true);
  assert.equal(f.calls(), 0);
});

test('a revoked authenticated question fails the whole ordinary search after optional enrichment', async () => {
  const f = fixture();
  f.messages.set('question', { ...f.messages.get('message-0'), id: 'question' });
  f.deps.decisionIndex = {
    lookup: async () => {
      f.messages.get('question').deletedAt = 1;
      return { status: 'unavailable', facts: new Map() };
    },
  };
  await assert.rejects(
    new MessageSearchService(f.deps).search(input, {
      ...principal,
      source: { threadId: 'visible', messageId: 'question' },
    }),
    (error) => error.statusCode === 403 && /source.*not accessible/i.test(error.message),
  );
});
