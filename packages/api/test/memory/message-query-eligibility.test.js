import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MessageSearchService } from '../../dist/domains/memory/MessageSearchService.js';
import { MessageQueryQualifier } from '../../dist/domains/memory/message-query-qualifier.js';

// Retrieval is deliberately permissive: these tests specify publication, not
// whether partial lexical / NN clues may enter the bounded index candidate pool.
function fixture(query, rows, { sort = 'time', sourceId } = {}) {
  const thread = { id: 'visible', title: 'Source discussion', createdBy: 'owner' };
  const messages = new Map();
  const candidates = rows.map(([id, content, timestamp, match = 'lexical', extra = {}]) => {
    messages.set(id, {
      id,
      threadId: thread.id,
      userId: 'owner',
      from: { kind: 'user', userId: 'owner' },
      content,
      timestamp,
      ...extra,
    });
    return {
      docAnchor: `thread-${thread.id}`,
      passageId: `msg-${id}`,
      threadId: thread.id,
      messageId: id,
      content,
      match,
      createdAt: new Date(timestamp).toISOString(),
    };
  });
  const service = new MessageSearchService({
    qualifier: new MessageQueryQualifier(async (batch) =>
      JSON.stringify({
        requestId: batch.requestId,
        rows: batch.rows.map((row) => {
          const supported = [
            'original',
            'paraphrase',
            'reported',
            'old-copy',
            'translated',
            'forward',
            'public',
          ].includes(row.messageId);
          return [row.id, supported ? 'supported' : 'rejected', supported ? row.body : null];
        }),
      }),
    ),
    evidenceStore: {
      readMessagePassageState: () => ({ current: true, suppressThreadTitle: false }),
      searchMessagePassages: async () => ({
        passages: candidates,
        meta: {
          effectiveMode: 'hybrid',
          sort,
          candidateLimit: 2000,
          truncated: false,
          semanticCandidatesLimited: true,
          sourceCoverage: 'unknown',
          freshness: 'unknown',
          degraded: false,
        },
      }),
    },
    threadStore: { get: (id) => (id === thread.id ? thread : null), list: () => [thread] },
    messageStore: { getById: (id) => messages.get(id) ?? null },
  });
  const principal = {
    userId: 'owner',
    viewer: { type: 'cat', catId: 'codex61-sol' },
    ...(sourceId ? { source: { threadId: thread.id, messageId: sourceId } } : {}),
  };
  return { service, principal, input: { query, mode: 'hybrid', sort, limit: 20 } };
}
const ids = (result) => result.results.map((hit) => hit.messageId);

describe('J5 complete-query eligibility at the canonical publication boundary', () => {
  for (const [object, event, synonym, otherEvent, another] of [
    ['Mira', '起名', '新称呼定下来了', '今天的排班', 'Nola'],
    ['Elio', '值班', '轮值时间表已经确定', '命名的原始讨论', 'Aster'],
  ]) {
    for (const sort of ['time', 'relevance']) {
      it(`${object}/${event}/${sort}: excludes a changed object or event while preserving paraphrases and same-text history`, async () => {
        const query = `${object} ${event}`;
        // This order also establishes the independent retrieval/relevance order.
        const { service, principal, input } = fixture(
          query,
          [
            ['other-topic', `另一个项目的${event}规则`, 10],
            ['original', `给 ${object} ${event}的原始讨论`, 40],
            ['other-object', `给 ${another} ${event}的原始讨论`, 15],
            ['paraphrase', `${object} 的${synonym}`, 20, 'semantic'],
            ['other-event', `${object} ${otherEvent}`, 12],
            ['reported', `我们回顾了给 ${object} ${event}时的决定`, 60],
            ['old-copy', query, 70],
            ['question', query, 80],
          ],
          { sort, sourceId: 'question' },
        );
        const result = await service.search(input, principal);
        assert.deepEqual(
          ids(result),
          sort === 'time'
            ? ['paraphrase', 'original', 'reported', 'old-copy']
            : ['original', 'paraphrase', 'reported', 'old-copy'],
        );
        assert.equal(result.meta.sort, sort);
        assert.equal(result.meta.partial, true);
        assert.equal(result.meta.sourceCoverage, 'unknown');
        assert.equal(result.meta.freshness, 'unknown');
      });
    }
  }

  it('retains a semantic-only same-event message while rejecting a near-topic NN neighbour', async () => {
    const { service, principal, input } = fixture('recovery of deleted documents', [
      ['near-topic', 'Recovery exercise after a knee injury', 10, 'semantic'],
      ['other-event', 'How to organise the documents for a workshop', 15, 'semantic'],
      ['translated', '找回被误删的文稿的操作步骤', 20, 'semantic'],
      ['paraphrase', 'Recovering a document that was accidentally removed', 30, 'semantic'],
    ]);
    const result = await service.search(input, principal);
    assert.deepEqual(ids(result), ['translated', 'paraphrase']);
    const translated = result.results[0];
    assert.equal(translated.match, 'semantic');
    assert.deepEqual(translated.highlights, [], 'semantic evidence cannot fabricate literal offsets');
  });

  it('requires the queried relation instead of accepting the same entities and event in reversed roles', async () => {
    const { service, principal, input } = fixture('Ari 向 Bex 转交文稿', [
      ['reverse', 'Bex 已将文稿转交给 Ari 处理。', 10, 'semantic'],
      ['translated-reverse', 'Bex sent the draft to Ari.', 15, 'semantic'],
      ['forward', 'Ari 已将文稿转交给 Bex 处理。', 20, 'semantic'],
      ['translated', 'Ari sent the draft to Bex.', 30, 'semantic'],
    ]);
    assert.deepEqual(ids(await service.search(input, principal)), ['forward', 'translated']);
  });

  it('preserves the same semantic-only object/event qualification in cat and direct UI calls', async () => {
    const { default: Fastify } = await import('fastify');
    const { evidenceRoutes } = await import('../../dist/routes/evidence.js');
    const { service, principal, input } = fixture('laptop battery replacement', [
      ['screen', 'laptop screen replacement', 10, 'semantic'],
      ['phone', 'phone battery replacement', 15, 'semantic'],
      ['translated', '更换笔记本电脑的电池。', 20, 'semantic'],
    ]);
    const app = Fastify();
    try {
      await app.register(evidenceRoutes, { evidenceStore: {}, messageSearchService: service });
      const query = new URLSearchParams({
        q: input.query,
        resultUnit: 'message',
        scope: 'threads',
        mode: input.mode,
        messageSort: input.sort,
        limit: String(input.limit),
      });
      const response = await app.inject({
        url: `/api/evidence/search?${query}`,
        headers: { 'x-cat-cafe-user': 'owner' },
      });
      assert.equal(response.statusCode, 200);
      const human = response.json();
      const cat = await service.search(input, principal);
      assert.deepEqual(ids(human), ids(cat), 'the same admitted source snapshot has one shared qualification contract');
      assert.deepEqual(ids(cat), ['translated']);
      assert.deepEqual(cat.results[0].highlights, []);
    } finally {
      await app.close();
    }
  });

  it('keeps visibility and withdrawal checks before publication even when query evidence is exact', async () => {
    const { service, principal, input } = fixture('Mira 起名', [
      ['withdrawn', 'Mira 起名', 10, 'lexical', { deletedAt: 11 }],
      ['tombstone', 'Mira 起名', 12, 'lexical', { _tombstone: true }],
      ['other-owner', 'Mira 起名', 13, 'lexical', { userId: 'someone-else' }],
      ['public', 'Mira 起名', 20],
    ]);
    assert.deepEqual(ids(await service.search(input, principal)), ['public']);
  });
});
