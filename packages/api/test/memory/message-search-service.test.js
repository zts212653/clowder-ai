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

  it('projects indexed scheduler notices as system for both human and cat searches, preserving real authors', async () => {
    const { default: Fastify } = await import('fastify');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { evidenceRoutes } = await import('../../dist/routes/evidence.js');
    const { MessageSearchService } = await import('../../dist/domains/memory/MessageSearchService.js');
    const indexed = new SqliteEvidenceStore(':memory:');
    const app = Fastify();
    const thread = { ...threads.get('visible'), participants: ['codex61-sol'], lastActiveAt: 1000 };
    const notices = [null, 'system'].map((catId, i) => ({
      id: `notice-${i}`,
      threadId: thread.id,
      userId: 'owner',
      from: { kind: 'system', service: 'hold-ball' },
      catId,
      content: '[定时任务] piano 持球唤醒。',
      timestamp: 500 + i,
      source: {
        connector: 'hold-ball',
        label: '持球通知',
        meta: { managedHold: true, taskId: 'test-wake', threadId: thread.id, catId: 'codex61-sol', wakeWhen: true },
      },
    }));
    const human = { ...messages.get('old'), id: 'human' };
    const cat = { ...human, id: 'cat', catId: 'codex61-sol' };
    const otherOwnerHold = { ...notices[0], id: 'other-owner-hold', userId: 'someone-else' };
    const internal = { ...notices[0], id: 'internal-system', userId: 'system' };
    const rows = [...notices, human, cat, otherOwnerHold, internal];
    try {
      await indexed.initialize();
      const builder = new IndexBuilder(
        indexed,
        process.cwd(),
        undefined,
        undefined,
        () => [thread],
        () => rows,
      );
      builder.markThreadDirty(thread.id);
      await builder.flushDirtyThreads();
      const raw = await indexed.searchMessagePassages('piano', {
        mode: 'lexical',
        sort: 'time',
        visibleThreadIds: [thread.id],
      });
      assert.deepEqual(new Set(raw.passages.map((row) => row.messageId)), new Set(rows.map((row) => row.id)));
      const actual = new MessageSearchService({
        evidenceStore: indexed,
        threadStore: { get: (id) => threads.get(id), list: () => [thread] },
        messageStore: { getById: (id) => rows.find((row) => row.id === id) ?? null },
      });
      await app.register(evidenceRoutes, { evidenceStore: indexed, messageSearchService: actual });
      const response = await app.inject({
        url: '/api/evidence/search?q=piano&resultUnit=message&mode=lexical',
        headers: { 'x-cat-cafe-user': 'owner' },
      });
      assert.equal(response.statusCode, 200);
      const fromHuman = response.json().results;
      const fromCat = (await actual.search({ ...input, mode: 'lexical' }, principal)).results;
      for (const hits of [fromHuman, fromCat]) {
        assert.equal(hits.length, 4, 'speaker classification cannot relax owner-hold or internal-message visibility');
        for (const notice of notices) assert.equal(hits.find((hit) => hit.messageId === notice.id)?.speaker, 'system');
        assert.equal(hits.find((hit) => hit.messageId === human.id)?.speaker, 'user');
        assert.equal(hits.find((hit) => hit.messageId === cat.id)?.speaker, 'codex61-sol');
      }
    } finally {
      await app.close();
      indexed.close();
    }
  });

  it('projects indexed external and legacy connector identities for both human and cat searches', async () => {
    const { default: Fastify } = await import('fastify');
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { evidenceRoutes } = await import('../../dist/routes/evidence.js');
    const { MessageSearchService } = await import('../../dist/domains/memory/MessageSearchService.js');
    const indexed = new SqliteEvidenceStore(':memory:');
    const app = Fastify();
    const thread = { ...threads.get('visible'), participants: ['codex61-sol'], lastActiveAt: 1000 };
    const notices = ['slack', 'feishu', 'wecom', 'github', 'hold-ball', 'unknown-connector'].map((connector, i) => ({
      id: `notice-${i}`,
      threadId: thread.id,
      userId: 'owner',
      catId: null,
      content: '[定时任务] piano 持球唤醒。',
      timestamp: 500 + i,
      source: {
        connector,
        label: `${connector} source`,
        icon: '',
        sender: { id: 'external-sender', name: 'Acceptance source' },
        meta: { managedHold: true, taskId: 'test-wake', threadId: thread.id, catId: 'codex61-sol', wakeWhen: true },
      },
    }));
    notices.push({
      ...notices[0],
      id: 'owner-cat-connector',
      catId: 'codex61-sol',
      source: { ...notices[0].source, connector: 'github-wait', label: 'GitHubWait' },
    });
    const human = { ...messages.get('old'), id: 'human' };
    const cat = { ...human, id: 'cat', catId: 'codex61-sol' };
    const otherOwnerHold = {
      ...notices[4],
      userId: 'scheduler',
      id: 'other-owner-hold',
      queueCustody: { ownerUserId: 'someone-else' },
    };
    const internal = { ...notices[0], id: 'internal-system', userId: 'system' };
    const typedLegacy = { ...human, id: 'typed-legacy', type: 'connector' };
    const damaged = { ...human, id: 'damaged-source', sourceParseFailure: true };
    const senderId = {
      ...notices[0],
      id: 'sender-id',
      source: { ...notices[0].source, sender: { id: 'external-id' } },
    };
    const sourceOnly = { ...notices[0], id: 'source-only', source: { ...notices[0].source, sender: undefined } };
    const oversized = {
      ...notices[0],
      id: 'bounded-source',
      source: { ...notices[0].source, label: 'x'.repeat(500), sender: { id: 'id', name: 'y'.repeat(500) } },
    };
    const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
    const pluginFrom = { kind: 'plugin', instanceId: 'pi_private-routing-id' };
    const pluginStore = new MessageStore();
    const plugin = pluginStore.append({
      userId: 'owner',
      threadId: thread.id,
      from: pluginFrom,
      content: 'piano plugin input',
      mentions: [],
      timestamp: human.timestamp,
      extra: {
        pluginMessage: {
          instanceId: pluginFrom.instanceId,
          revision: 1,
          provenance: { origin: pluginFrom, epistemicStatus: 'observation' },
          elements: [],
          presentation: {
            connector: 'custom',
            label: 'Room Connector',
            icon: 'message',
            sender: { id: 'private-chat-route' },
          },
        },
      },
    });
    assert.equal(plugin.source, undefined);
    const rows = [
      plugin,
      ...notices,
      typedLegacy,
      damaged,
      senderId,
      sourceOnly,
      oversized,
      human,
      cat,
      otherOwnerHold,
      internal,
    ];
    try {
      await indexed.initialize();
      const builder = new IndexBuilder(
        indexed,
        process.cwd(),
        undefined,
        undefined,
        () => [thread],
        () => rows,
      );
      builder.markThreadDirty(thread.id);
      await builder.flushDirtyThreads();
      const raw = await indexed.searchMessagePassages('piano', {
        mode: 'lexical',
        sort: 'time',
        visibleThreadIds: [thread.id],
      });
      assert.deepEqual(new Set(raw.passages.map((row) => row.messageId)), new Set(rows.map((row) => row.id)));
      const actual = new MessageSearchService({
        evidenceStore: indexed,
        threadStore: { get: (id) => threads.get(id), list: () => [thread] },
        messageStore: { getById: (id) => rows.find((row) => row.id === id) ?? null },
      });
      await app.register(evidenceRoutes, { evidenceStore: indexed, messageSearchService: actual });
      const response = await app.inject({
        url: '/api/evidence/search?q=piano&resultUnit=message&mode=lexical',
        headers: { 'x-cat-cafe-user': 'owner' },
      });
      assert.equal(response.statusCode, 200);
      const fromHuman = response.json().results;
      const fromCat = (await actual.search({ ...input, mode: 'lexical' }, principal)).results;
      for (const hits of [fromHuman, fromCat]) {
        assert.equal(hits.length, 15, 'speaker classification cannot relax owner-hold or internal-message visibility');
        for (const notice of notices) {
          const hit = hits.find((hit) => hit.messageId === notice.id);
          assert.equal(hit?.speaker, 'connector');
          assert.equal(hit?.speakerLabel, `${notice.source.label} · Acceptance source`);
        }
        assert.equal(hits.find((hit) => hit.messageId === typedLegacy.id)?.speaker, 'connector');
        assert.equal(hits.find((hit) => hit.messageId === damaged.id)?.speaker, 'system');
        assert.equal(hits.find((hit) => hit.messageId === senderId.id)?.speakerLabel, 'slack source · external-id');
        assert.equal(hits.find((hit) => hit.messageId === sourceOnly.id)?.speakerLabel, 'slack source');
        assert.equal(
          hits.find((hit) => hit.messageId === oversized.id)?.speakerLabel,
          `${'x'.repeat(80)} · ${'y'.repeat(80)}`,
        );
        assert.equal(hits.find((hit) => hit.messageId === plugin.id)?.speaker, 'connector');
        assert.equal(hits.find((hit) => hit.messageId === plugin.id)?.speakerLabel, 'Room Connector');
        assert.equal(hits.find((hit) => hit.messageId === human.id)?.speaker, 'user');
        assert.equal(hits.find((hit) => hit.messageId === cat.id)?.speaker, 'codex61-sol');
      }
    } finally {
      await app.close();
      indexed.close();
    }
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
