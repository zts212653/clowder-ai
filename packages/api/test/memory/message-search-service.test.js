import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('canonical message search projection', () => {
  let service;
  let searchOptions;
  let source;
  let candidates;
  let messages;
  let threads;
  let indexState;
  const principal = { userId: 'owner', viewer: { type: 'cat', catId: 'codex61-sol' } };
  const input = { query: 'piano', sort: 'time', mode: 'hybrid', limit: 20 };

  beforeEach(async () => {
    const { MessageSearchService } = await import('../../dist/domains/memory/MessageSearchService.js');
    threads = new Map([
      ['visible', { id: 'visible', title: 'Canonical title', createdBy: 'owner' }],
      ['private', { id: 'private', title: 'Private title', createdBy: 'someone-else' }],
    ]);
    messages = new Map();
    candidates = [];
    source = undefined;
    indexState = { current: true, suppressThreadTitle: false };
    for (const [id, timestamp] of [
      ['old', 1000],
      ['again', 2000],
      ['question', 3000],
    ]) {
      const content = 'piano discussion. Original second sentence. Third sentence.';
      messages.set(id, { id, threadId: 'visible', userId: 'owner', catId: null, content, timestamp });
      candidates.push({
        docAnchor: 'thread-visible',
        passageId: `msg-${id}`,
        threadId: 'visible',
        messageId: id,
        content,
        speaker: 'wrong-index-speaker',
        createdAt: '2099-01-01T00:00:00Z',
        match: 'lexical',
      });
    }
    service = new MessageSearchService({
      evidenceStore: {
        readMessagePassageState: () => indexState,
        searchMessagePassages: async (_query, options) => {
          searchOptions = options;
          return {
            passages: candidates,
            meta: {
              degraded: false,
              effectiveMode: 'hybrid',
              sort: 'time',
              candidateLimit: 2000,
              truncated: false,
              semanticCandidatesLimited: true,
              sourceCoverage: 'unknown',
              freshness: 'unknown',
            },
          };
        },
      },
      threadStore: { get: (id) => threads.get(id) ?? null, list: () => [...threads.values()] },
      messageStore: { getById: (id) => messages.get(id) ?? null },
    });
  });

  it('propagates execution lifetime without changing visibility or result projection', async () => {
    const controller = new AbortController();
    const context = { signal: controller.signal, deadlineAt: Date.now() + 5000 };
    const result = await service.search(input, principal, context);
    assert.equal(result.results.length, 3);
    assert.equal(searchOptions.signal, controller.signal);
    assert.equal(searchOptions.deadlineAt, context.deadlineAt);
    controller.abort(new DOMException('client left', 'AbortError'));
    await assert.rejects(service.search(input, principal, context), { name: 'AbortError' });
  });

  it('uses canonical body, title, speaker and time, sorting before the visible result limit', async () => {
    candidates.reverse();
    const result = await service.search({ ...input, limit: 1 }, principal);
    assert.deepEqual(
      result.results.map((hit) => hit.messageId),
      ['old'],
    );
    const hit = result.results[0];
    assert.equal(hit.threadTitle, 'Canonical title');
    assert.equal(hit.speaker, 'user');
    assert.equal(hit.timestamp, 1000);
    assert.equal(hit.snippet.text, 'piano discussion. Original second sentence.');
    assert.deepEqual(hit.highlights, [{ start: 0, end: 5 }]);
    assert.equal(result.meta.hasMore, true);
    assert.equal(result.meta.sourceCoverage, 'unknown');
  });

  it('binds source exclusion only to the authenticated principal and preserves identical older bodies', async () => {
    source = { threadId: 'visible', messageId: 'question' };
    const result = await service.search(input, { ...principal, source });
    assert.deepEqual(searchOptions.excludeSource, source);
    assert.deepEqual(
      result.results.map((hit) => hit.messageId),
      ['old', 'again'],
    );
    const human = await service.search(input, { userId: 'owner', viewer: { type: 'user' } });
    assert.equal(human.results.length, 3, 'an input box without a source message excludes nothing');
  });

  it('can exclude its authenticated in-flight question without publishing queued bodies as search results', async () => {
    messages.get('question').deliveryStatus = 'queued';
    const result = await service.search(input, {
      ...principal,
      source: { threadId: 'visible', messageId: 'question' },
    });
    assert.deepEqual(
      result.results.map((hit) => hit.messageId),
      ['old', 'again'],
    );
  });

  it('revalidates malformed/unreadable indexed targets and never echoes their index body', async () => {
    const variants = {
      private: { threadId: 'private' },
      deleted: { deletedAt: 5 },
      recalled: { deliveryStatus: 'canceled', _tombstone: true },
      queued: { deliveryStatus: 'queued', catId: null },
      whisper: { visibility: 'whisper', whisperTo: ['opus55'] },
      'other-owner': { userId: 'someone-else' },
      internal: { userId: 'system', catId: null },
      'held-for-other-owner': {
        userId: 'scheduler',
        catId: null,
        source: { connector: 'hold-ball' },
        extra: { scheduler: {} },
        queueCustody: { ownerUserId: 'someone-else' },
      },
      stale: { content: 'The indexed piano body has since changed.' },
    };
    for (const [id, changes] of Object.entries(variants)) {
      messages.set(id, { ...messages.get('old'), id, ...changes });
      candidates.push({ ...candidates[0], messageId: id, passageId: `msg-${id}` });
    }
    candidates.push({ ...candidates[0], threadId: 'private', messageId: 'old' });
    candidates.push({ ...candidates[0], messageId: 'missing' });
    const result = await service.search(input, principal);
    assert.deepEqual(
      result.results.map((hit) => hit.messageId),
      ['old', 'again', 'question'],
    );
    assert.deepEqual(searchOptions.visibleThreadIds, ['visible']);
    assert.equal(result.meta.partial, true);
  });

  it('does not grant an exact thread by an untrusted result or its requested coordinate', async () => {
    await assert.rejects(service.search({ ...input, threadId: 'private' }, principal), /not accessible/);
    threads.get('visible').deletedAt = 5;
    await assert.rejects(service.search({ ...input, threadId: 'visible' }, principal), /not accessible/);
  });

  it('does not invent a literal highlight for semantic-only recall', async () => {
    candidates[0].match = 'semantic';
    const result = await service.search({ ...input, query: 'earlier navigation', limit: 1 }, principal);
    assert.deepEqual(result.results[0].highlights, []);
  });

  it('honors index recall suppression even before the canonical message CAS changes its body', async () => {
    indexState.current = false;
    const result = await service.search(input, principal);
    assert.deepEqual(result.results, []);
  });

  it('does not copy a potentially recalled body from a thread title with unknown provenance', async () => {
    threads.get('visible').title = 'Recalled source body in a generated title';
    indexState.suppressThreadTitle = true;
    const result = await service.search(input, principal);
    assert.ok(result.results.every((hit) => !hit.threadTitle.includes('Recalled source body')));
  });

  it('deduplicates by exact thread/message identity after authoritative projection', async () => {
    candidates.push({ ...candidates[0] });
    const result = await service.search(input, principal);
    assert.equal(result.results.length, 3);
  });

  it('checks a date bound against canonical message time even if an index/provider ignores it', async () => {
    const dateTo = '1970-01-01T00:00:01.500Z';
    const result = await service.search({ ...input, dateTo }, principal);
    assert.deepEqual(
      result.results.map((hit) => hit.messageId),
      ['old'],
    );
    assert.equal(searchOptions.dateTo, dateTo);
  });

  it('bounds the common API/MCP response without calling dropped readable results a complete set', async () => {
    threads.get('visible').title = 'Canonical long title '.repeat(600);
    const result = await service.search(input, principal);
    assert.ok(JSON.stringify(result).length <= 24_000);
    assert.equal(result.meta.response.truncated, true);
    assert.equal(result.meta.hasMore, true);
  });

  it('fails closed when an authenticated invocation source is unavailable or belongs elsewhere', async () => {
    await assert.rejects(
      service.search(input, { ...principal, source: { threadId: 'visible', messageId: 'missing' } }),
      /source.*not accessible/,
    );
    await assert.rejects(
      service.search(input, { ...principal, source: { threadId: 'private', messageId: 'old' } }),
      /source.*not accessible/,
    );
  });
});
