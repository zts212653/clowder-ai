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
