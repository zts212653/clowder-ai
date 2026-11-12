import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MessageSearchService } from '../../dist/domains/memory/MessageSearchService.js';

// Keep the original neutral samples: ordinary recall admits readable clues without
// a semantic verdict. Cat selection, rather than this queue, judges their relevance.
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
    qualifier: {
      qualify() {
        throw new Error('Generative qualification is retired');
      },
    },
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

describe('ordinary recall retains readable clues without complete-query qualification', () => {
  for (const [object, event, synonym, otherEvent, another] of [
    ['Mira', '起名', '新称呼定下来了', '今天的排班', 'Nola'],
    ['Elio', '值班', '轮值时间表已经确定', '命名的原始讨论', 'Aster'],
  ]) {
    for (const sort of ['time', 'relevance']) {
      it(`${object}/${event}/${sort}: preserves changed-object and changed-event clues as well as paraphrases and same-text history`, async () => {
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
            ? ['other-topic', 'other-event', 'other-object', 'paraphrase', 'original', 'reported', 'old-copy']
            : ['other-topic', 'original', 'other-object', 'paraphrase', 'other-event', 'reported', 'old-copy'],
        );
        assert.equal(result.meta.qualification, undefined);
        assert.equal(result.meta.sort, sort);
        assert.equal(result.meta.partial, true);
        assert.equal(result.meta.sourceCoverage, 'unknown');
        assert.equal(result.meta.freshness, 'unknown');
      });
    }
  }

  it('retains a semantic-only same-event message alongside the near-topic NN neighbours', async () => {
    const { service, principal, input } = fixture('recovery of deleted documents', [
      ['near-topic', 'Recovery exercise after a knee injury', 10, 'semantic'],
      ['other-event', 'How to organise the documents for a workshop', 15, 'semantic'],
      ['translated', '找回被误删的文稿的操作步骤', 20, 'semantic'],
      ['paraphrase', 'Recovering a document that was accidentally removed', 30, 'semantic'],
    ]);
    const result = await service.search(input, principal);
    assert.deepEqual(ids(result), ['near-topic', 'other-event', 'translated', 'paraphrase']);
    assert.equal(result.meta.qualification, undefined);
    const translated = result.results.find((row) => row.messageId === 'translated');
    assert.equal(translated.match, 'semantic');
    assert.deepEqual(translated.highlights, [], 'semantic evidence cannot fabricate literal offsets');
  });

  it('leaves forward and reversed relations visible for cat selection to distinguish', async () => {
    const { service, principal, input } = fixture('Ari 向 Bex 转交文稿', [
      ['reverse', 'Bex 已将文稿转交给 Ari 处理。', 10, 'semantic'],
      ['translated-reverse', 'Bex sent the draft to Ari.', 15, 'semantic'],
      ['forward', 'Ari 已将文稿转交给 Bex 处理。', 20, 'semantic'],
      ['translated', 'Ari sent the draft to Bex.', 30, 'semantic'],
    ]);
    const response = await service.search(input, principal);
    assert.deepEqual(ids(response), ['reverse', 'translated-reverse', 'forward', 'translated']);
    assert.equal(response.meta.qualification, undefined);
  });

  it('ordinary cat and UI sources share raw semantics without claiming qualification', async () => {
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
      assert.deepEqual(ids(human), ids(cat), 'ordinary UI and cat paths share the same admitted source window');
      assert.deepEqual(ids(cat), ['screen', 'phone', 'translated']);
      assert.equal(cat.meta.qualification, undefined);
      assert.deepEqual(cat.results.find((row) => row.messageId === 'translated').highlights, []);
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
