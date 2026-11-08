import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { buildSearchableMessageContent } from '../../dist/domains/memory/message-search-content.js';
import { fixture, human, post } from '../helpers/message-search-answer-fixture.js';

const revision = (row) =>
  createHash('sha256')
    .update(buildSearchableMessageContent({ content: row.content, contentBlocks: row.contentBlocks }))
    .digest('hex');
const select = (row, quote, extra = {}) => ({
  threadId: row.threadId,
  messageId: row.id,
  contentRevision: revision(row),
  quote,
  reason: 'co-creator已拍板立即下线判官',
  ...extra,
});
function quoted(f, { readable = true, sourceName = 'FAKE AUTHOR' } = {}) {
  const text = '建议只在测试全部通过后，才下线判官。';
  const original = f.messages.append({
    from: { kind: 'agent', catId: 'gemini-argon' },
    userId: 'owner',
    threadId: 'sources',
    content: '### 历史备选（未采用）\n\n' + text,
    mentions: [],
    timestamp: 20,
    ...(!readable ? { visibility: 'whisper', whisperTo: ['other'] } : {}),
  });
  const attachment = {
    v: 1,
    id: 'quote-one',
    kind: 'quote',
    text,
    comment: '先看人猫区别，这版还不直接当合同。',
    source: {
      kind: 'message',
      threadId: original.threadId,
      messageId: original.id,
      senderCatId: sourceName,
      displayLabel: sourceName,
    },
  };
  const publisher = f.messages.append({
    from: { kind: 'user', userId: 'owner' },
    userId: 'owner',
    threadId: 'sources',
    content: '转引材料',
    contentBlocks: [
      { type: 'text', text: '转引材料' },
      { type: 'context_attachment', attachment },
    ],
    mentions: [],
    timestamp: 30,
  });
  return { original, publisher, text, attachment };
}

test('Host verifies the quoted original publisher and heading, separately from the current publisher/comment and cat reason', async () => {
  const f = fixture();
  try {
    const q = quoted(f);
    const prepared = await f.service.prepare({ ...f.request, selections: [select(q.publisher, '下线判官')] });
    const row = prepared.response.results[0];
    assert.equal(row.speaker, 'user');
    assert.equal(row.selection.part.kind, 'quote');
    assert.equal(row.selection.quotation.origin.speaker, 'gemini-argon');
    assert.deepEqual(row.selection.quotation.origin.headingPath, ['历史备选（未采用）']);
    assert.ok(row.selection.context.text.includes('只在测试全部通过后'));
    assert.equal(row.selection.comment.text, q.attachment.comment);
    assert.equal(row.selection.reason, 'co-creator已拍板立即下线判官');
    assert.equal(JSON.stringify(prepared.response).includes('FAKE AUTHOR'), false);
    assert.equal(prepared.response.meta.qualification, undefined);
    assert.equal(row.decisionSources, undefined);
    const published = await post(f, prepared);
    const view = await f
      .recreate()
      .read(published.message.id, published.published.extra.messageSearchAnswer.blockId, human);
    assert.equal(view.status, 'available');
    assert.deepEqual(view.response.meta.answerBinding, {
      messageId: published.message.id,
      blockId: published.published.extra.messageSearchAnswer.blockId,
    });
    assert.equal(
      f.store.response(f.store.get(prepared.publicationRef)).meta.answerBinding,
      undefined,
      'read coordinates do not rewrite the sole saved response',
    );
    assert.equal(f.searches(), 0);
    assert.equal(f.calls(), 0);
  } finally {
    f.db.close();
  }
});

test('an unreadable original yields only a verified current quotation; attachment names grant no author proof', async () => {
  const f = fixture();
  try {
    const q = quoted(f, { readable: false });
    const prepared = await f.service.prepare({ ...f.request, selections: [select(q.publisher, '下线判官')] });
    assert.equal(prepared.response.results[0].selection.quotation.origin, undefined);
    assert.equal(JSON.stringify(prepared.response).includes('FAKE AUTHOR'), false);
    assert.equal(JSON.stringify(prepared.response).includes(q.original.id), false);
  } finally {
    f.db.close();
  }
});

test('selection of the current publisher comment retains the distinct quoted material', async () => {
  const f = fixture();
  try {
    const q = quoted(f);
    const prepared = await f.service.prepare({ ...f.request, selections: [select(q.publisher, '还不直接当合同')] });
    const selection = prepared.response.results[0].selection;
    assert.equal(selection.part.kind, 'comment');
    assert.equal(selection.quotation.text, q.text);
    assert.ok(selection.context.text.includes('这版还不直接当合同'));
  } finally {
    f.db.close();
  }
});

for (const field of ['quote-source', 'original-publisher', 'original-withdrawal'])
  test(`a ${field} change invalidates a saved card without rewriting supported history`, async () => {
    const f = fixture();
    try {
      const q = quoted(f);
      const prepared = await f.service.prepare({ ...f.request, selections: [select(q.publisher, '下线判官')] });
      const published = await post(f, prepared);
      const recordBefore = f.store.get(prepared.publicationRef);
      if (field === 'quote-source')
        f.messages.getById(q.publisher.id).contentBlocks[1].attachment.source.senderCatId = 'changed';
      if (field === 'original-publisher') f.messages.getById(q.original.id).from = { kind: 'agent', catId: 'other' };
      if (field === 'original-withdrawal')
        f.messages.getById(q.original.id).recall = { version: 1, exposure: 'none', recalledAt: 50 };
      assert.equal(
        revision(f.messages.getById(q.publisher.id)),
        prepared.response.results[0].contentRevision,
        'text revision alone cannot attest source metadata',
      );
      const view = await f.service.read(
        published.message.id,
        published.published.extra.messageSearchAnswer.blockId,
        human,
      );
      assert.equal(view.status, 'unavailable');
      assert.equal(f.store.get(prepared.publicationRef).response_json, recordBefore.response_json);
    } finally {
      f.db.close();
    }
  });

test('an invalid selection does not consume the one operation, while a valid retry reuses its immutable chosen source', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.service.prepare({ ...f.request, selections: [select(f.source[0], 'missing sentence')] }));
    assert.equal(f.store.forOperation('owner', f.request.producer, f.request.operationId), null);
    const selections = [select(f.source[0], 'original source 0')];
    const first = await f.service.prepare({ ...f.request, selections });
    const retry = await f.service.prepare({ ...f.request, selections });
    assert.equal(first.publicationRef, retry.publicationRef);
    assert.equal(first.searchId, retry.searchId);
    await assert.rejects(
      f.service.prepare({ ...f.request, selections: [select(f.source[1], 'original source 1')] }),
      /CONFLICT/,
    );
    assert.equal(f.searches(), 0);
    assert.equal(f.calls(), 0);
  } finally {
    f.db.close();
  }
});

test('ambiguous quotes require exact structural part and UTF-16 range, and split emoji or repeated messages fail closed', async () => {
  const f = fixture();
  try {
    const row = f.messages.getById(f.source[0].id);
    row.content = '😀 同一句\n同一句';
    await assert.rejects(f.service.prepare({ ...f.request, selections: [select(row, '同一句')] }), /ambiguous/);
    const input = select(row, '同一句', { part: { kind: 'body' }, range: { start: 7, end: 10 } });
    await assert.rejects(f.service.prepare({ ...f.request, selections: [input, input] }), /once/);
    await assert.rejects(
      f.service.prepare({
        ...f.request,
        selections: [select(row, '\ude00', { part: { kind: 'body' }, range: { start: 1, end: 2 } })],
      }),
      /absent|ambiguous/,
    );
    const good = await f.service.prepare({ ...f.request, selections: [input] });
    assert.deepEqual(good.response.results[0].selection.range, { start: 7, end: 10 });
  } finally {
    f.db.close();
  }
});

test('a stale index, current question, external cancellation or revoked invocation source never publishes a chosen card', async () => {
  for (const kind of ['stale', 'question', 'abort', 'source']) {
    const f = fixture();
    try {
      const row = f.source[0],
        controller = new AbortController();
      const request = { ...f.request, selections: [select(row, 'original source 0')] };
      if (kind === 'stale') f.evidenceStore.readMessagePassageState = () => ({ current: false });
      if (kind === 'question')
        request.principal = { ...request.principal, source: { threadId: row.threadId, messageId: row.id } };
      if (kind === 'source')
        request.principal = { ...request.principal, source: { threadId: 'sources', messageId: 'missing' } };
      if (kind === 'abort') controller.abort(new Error('cancelled'));
      await assert.rejects(f.service.prepare(request, { signal: controller.signal }));
      assert.equal(f.store.forOperation('owner', f.request.producer, f.request.operationId), null);
    } finally {
      f.db.close();
    }
  }
});

test('headings use Markdown structure, retain the historical branch, and ignore fenced pseudo-headings', async () => {
  const f = fixture();
  try {
    const row = f.messages.getById(f.source[0].id);
    row.content =
      '# 总结\n\n```md\n# 已批准\n```\n\n历史备选（未采用）\n----------------------\n\n只有测试通过后，才下线判官；当前尚未采用。';
    const prepared = await f.service.prepare({ ...f.request, selections: [select(row, '下线判官')] });
    assert.deepEqual(prepared.response.results[0].selection.headingPath, ['总结', '历史备选（未采用）']);
    assert.ok(prepared.response.results[0].selection.context.text.includes('当前尚未采用'));
  } finally {
    f.db.close();
  }
});

test('the Host never validates a quote manufactured by joining separate text, quote and comment parts', async () => {
  const f = fixture();
  try {
    const q = quoted(f);
    await assert.rejects(
      f.service.prepare({ ...f.request, selections: [select(q.publisher, q.text + '\n\n' + q.attachment.comment)] }),
      /absent|ambiguous/,
    );
  } finally {
    f.db.close();
  }
});

test('withdrawal of the authenticated question during verification fails the whole preparation', async () => {
  const f = fixture();
  try {
    const question = f.messages.append({
      from: { kind: 'user', userId: 'owner' },
      userId: 'owner',
      threadId: 'origin',
      content: 'question',
      mentions: [],
      timestamp: 5,
    });
    let checked = 0;
    f.evidenceStore.readMessagePassageState = () => {
      if (++checked === 2) f.messages.getById(question.id).deletedAt = 100;
      return { current: true };
    };
    await assert.rejects(
      f.service.prepare({
        ...f.request,
        principal: { ...f.request.principal, source: { threadId: question.threadId, messageId: question.id } },
        selections: [select(f.source[0], 'original source 0')],
      }),
      /Invocation source/,
    );
    assert.equal(f.store.forOperation('owner', f.request.producer, f.request.operationId), null);
  } finally {
    f.db.close();
  }
});

test('large selected contexts stay whole and fit the existing bounded publication envelope', async () => {
  const f = fixture();
  try {
    const selections = Array.from({ length: 20 }, (_, index) => {
      const quote = `条件原句 ${index}：未通过测试前不能执行。`;
      const row = f.messages.append({
        from: { kind: 'user', userId: 'owner' },
        userId: 'owner',
        threadId: 'sources',
        content: '前置语境。'.repeat(150) + quote + '后续条件。'.repeat(150),
        mentions: [],
        timestamp: 100 + index,
      });
      return select(row, quote, { reason: '这是选材猫自己的判断；'.repeat(40) });
    });
    const prepared = await f.service.prepare({ ...f.request, selections });
    const { response } = prepared;
    assert.ok(response.results.length > 0 && response.results.length < selections.length);
    assert.ok(JSON.stringify(response).length <= 23000);
    assert.equal(response.meta.response.truncated, true);
    assert.equal(response.meta.hasMore, true);
    for (const row of response.results) {
      const selected = row.selection;
      assert.equal(selected.context.text.slice(selected.context.quoteStart, selected.context.quoteEnd), selected.quote);
      assert.equal(selected.reason, selections[0].reason);
    }
    assert.equal(f.searches(), 0);
    assert.equal(f.calls(), 0);
  } finally {
    f.db.close();
  }
});

test('late optional ledger reads never alter already delivered selected sources', async () => {
  const f = fixture();
  try {
    const lookup = f.decisionIndex.lookup;
    f.decisionIndex.lookup = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return lookup(...args);
    };
    const started = Date.now();
    const prepared = await f.service.prepare(
      { ...f.request, selections: [select(f.source[0], 'original source 0')] },
      { deadlineAt: started + 4000 },
    );
    assert.ok(Date.now() - started < 4000);
    assert.equal(prepared.response.meta.decisionIndex.status, 'unavailable');
    assert.equal(prepared.response.results[0].decisionSources, undefined);
    const original = JSON.stringify(prepared);
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(JSON.stringify(prepared), original);
    assert.equal(f.searches(), 0);
    assert.equal(f.calls(), 0);
  } finally {
    f.db.close();
  }
});

test('an independent asynchronous port without a coherent read witness is safely unavailable', async () => {
  const f = fixture();
  try {
    const q = quoted(f);
    const prepared = await f.service.prepare({ ...f.request, selections: [select(q.publisher, '下线判官')] });
    const published = await post(f, prepared);
    const get = f.messages.getById.bind(f.messages);
    f.messages.getByIds = undefined; // Exercise the supported store port without batching.
    let originReads = 0;
    f.messages.getById = async (id) => {
      const message = get(id);
      if (id === q.original.id && ++originReads === 2) {
        await new Promise((resolve) => setImmediate(resolve));
        get(q.publisher.id).recall = { version: 1, exposure: 'none', recalledAt: 100 };
      }
      return message;
    };
    const view = await f.service.read(
      published.message.id,
      published.published.extra.messageSearchAnswer.blockId,
      human,
    );
    assert.equal(originReads, 0, 'unsupported independent async reads are refused before they can claim a graph proof');
    assert.equal(view.status, 'unavailable');
  } finally {
    f.db.close();
  }
});
