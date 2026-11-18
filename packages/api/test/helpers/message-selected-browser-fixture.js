import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildSearchableMessageContent } from '../../dist/domains/memory/message-search-content.js';
import { fixture, human, post, seedHistoricalAnswer } from './message-search-answer-fixture.js';

/** Real Host admissions and publication bindings on deterministic private fixtures; no model or live data. */
export async function selectedAnswerBrowserFixture() {
  const f = fixture();
  try {
    f.threads.set('recall-controlled', { id: 'recall-controlled', title: '选材卡受控原对话', createdBy: 'owner' });
    const sources = {},
      records = {},
      views = {},
      contexts = {},
      navigation = {};
    const text = '建议只在测试全部通过后，才下线判官。';
    let verifiedOriginal;
    for (const kind of ['verified', 'unverified']) {
      const original = f.messages.append({
        from: { kind: 'agent', catId: 'gemini-argon' },
        userId: 'owner',
        threadId: 'sources',
        content: '### 历史备选（未采用）\n\n' + text,
        mentions: [],
        timestamp: 1793900000000,
        ...(kind === 'unverified' ? { visibility: 'whisper', whisperTo: ['other'] } : {}),
      });
      if (kind === 'verified') verifiedOriginal = original;
      const publisher = f.messages.append({
        from: { kind: 'user', userId: 'owner' },
        userId: 'owner',
        threadId: 'sources',
        content: '转引材料',
        mentions: [],
        timestamp: 1793900010000,
        contentBlocks: [
          { type: 'text', text: '转引材料' },
          {
            type: 'context_attachment',
            attachment: {
              v: 1,
              id: `quote-${kind}`,
              kind: 'quote',
              text,
              comment: '先看人猫区别，这版还不直接当合同。',
              source: {
                kind: 'message',
                threadId: original.threadId,
                messageId: original.id,
                senderCatId: 'FORGED AUTHOR',
                displayLabel: 'FORGED AUTHOR',
              },
            },
          },
        ],
      });
      const producer = { kind: 'agent_key', id: `selected-${kind}`, catId: 'codex61-sol' };
      const prepared = await f.service.prepare({
        ...f.request,
        producer,
        targetThreadId: 'recall-controlled',
        input: { query: '判官下线' },
        selections: [
          {
            threadId: publisher.threadId,
            messageId: publisher.id,
            contentRevision: createHash('sha256').update(buildSearchableMessageContent(publisher)).digest('hex'),
            quote: '下线判官',
            reason: 'co-creator已拍板立即下线判官',
          },
        ],
      });
      const result = await post(f, prepared, { threadId: 'recall-controlled', producer });
      assert.ok(result.published);
      const binding = result.published.extra.messageSearchAnswer;
      const view = await f.service.read(result.message.id, binding.blockId, human);
      assert.equal(view.status, 'available');
      const selected = view.response.results[0];
      views[kind] = view;
      records[kind] = { ...result.published, type: 'assistant' };
      sources[kind] = [{ ...publisher, type: 'user' }];
      navigation[kind] = await f.search.resolveNavigationReference(selected, human);
      contexts[kind] = await f.search.resolveNavigationReference(selected, human, 3);
    }
    for (const kind of ['compact', 'multiple']) {
      const quotes =
        kind === 'compact'
          ? ['PR `#7166` 已合入 **main**，引用卡先只露重点。']
          : ['PR `#7166` 已合入 **main**，引用卡先只露重点。', '引用卡保留 **原话归属**，前后文收进展开区。'];
      const originals = quotes.map((quote, index) =>
        f.messages.append({
          from: { kind: 'agent', catId: index ? 'codex61-sol' : 'gemini-argon' },
          userId: 'owner',
          threadId: 'sources',
          mentions: [],
          content: `工具过程。${'这里是无关的前段日志。'.repeat(40)}\n\n核完了：${quote}未通过测试时，不要提前发布。\n\n后续过程。${'这里是无关的后段日志。'.repeat(40)}`,
          timestamp: 1793900100000 + index * 1000,
        }),
      );
      f.messages.append({
        from: { kind: 'user', userId: 'owner' },
        userId: 'owner',
        threadId: 'sources',
        mentions: [],
        content: '**后续回复**：展开后可以接着读。',
        timestamp: 1793900200000,
      });
      const producer = { kind: 'agent_key', id: `selected-${kind}`, catId: 'codex61-sol' };
      const prepared = await f.service.prepare({
        ...f.request,
        producer,
        targetThreadId: 'recall-controlled',
        input: { query: '引用卡' },
        selections: originals.map((message, index) => ({
          threadId: message.threadId,
          messageId: message.id,
          contentRevision: createHash('sha256').update(buildSearchableMessageContent(message)).digest('hex'),
          quote: quotes[index],
          reason: index ? '这一条说明归属与展开方式。' : '这一条给出已合入的准确位置。',
        })),
      });
      const result = await post(f, prepared, { threadId: 'recall-controlled', producer });
      assert.ok(result.published);
      const binding = result.published.extra.messageSearchAnswer;
      views[kind] = await f.service.read(result.message.id, binding.blockId, human);
      assert.equal(views[kind].status, 'available');
      records[kind] = { ...result.published, type: 'assistant' };
      sources[kind] = originals.map((message) => ({ ...message, type: 'assistant', catId: message.from.catId }));
      for (const selected of views[kind].response.results) {
        navigation[`${kind}:${selected.messageId}`] = await f.search.resolveNavigationReference(selected, human);
        contexts[`${kind}:${selected.messageId}`] = await f.search.resolveNavigationReference(selected, human, 3);
      }
    }
    assert.equal(f.searches(), 0);
    assert.equal(f.calls(), 0);
    const producer = { kind: 'agent_key', id: 'legacy-card', catId: 'codex61-sol' };
    const legacy = await seedHistoricalAnswer({
      ...f,
      request: { ...f.request, producer, targetThreadId: 'recall-controlled' },
    });
    assert.ok(legacy.response.meta.qualification.supported > 0);
    assert.equal(legacy.response.meta.resultKind, undefined);
    const legacyPost = await post(f, legacy, { threadId: 'recall-controlled', producer });
    const binding = legacyPost.published.extra.messageSearchAnswer;
    views.legacy = await f.service.read(legacyPost.message.id, binding.blockId, human);
    records.legacy = { ...legacyPost.published, type: 'assistant' };
    f.messages.getById(verifiedOriginal.id).recall = { version: 1, exposure: 'none', recalledAt: 1793900020000 };
    views.withdrawn = await f.service.read(
      records.verified.id,
      records.verified.extra.messageSearchAnswer.blockId,
      human,
    );
    assert.equal(views.withdrawn.status, 'unavailable');
    navigation.origin = await f.search.resolveNavigationReference({ threadId: 'recall-controlled' }, human);
    assert.equal(navigation.origin.status, 'available');
    return {
      views,
      records,
      sources,
      contexts,
      navigation,
      execution: { selectedSearches: 0, modelCalls: f.calls(), legacySearches: f.searches() },
    };
  } finally {
    f.db.close();
  }
}
