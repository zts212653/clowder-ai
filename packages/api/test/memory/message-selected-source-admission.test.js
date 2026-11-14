import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { fixture, human, post } from '../helpers/message-search-answer-fixture.js';

for (const port of ['independent async message', 'async visibility with batch-shaped methods'])
  test(`a selected card refuses an unproved ${port} read`, async () => {
    const f = fixture();
    try {
      const source = f.source[0];
      const prepared = await f.service.prepare({
        ...f.request,
        selections: [
          {
            threadId: source.threadId,
            messageId: source.id,
            contentRevision: createHash('sha256').update(source.content).digest('hex'),
            quote: 'original source 0',
            reason: 'read the original',
          },
        ],
      });
      const card = await post(f, prepared);
      if (port === 'independent async message') {
        const get = f.messages.getById.bind(f.messages);
        f.messages.getById = async (id) => structuredClone(get(id));
      } else {
        f.threadStore.list = async () => [...f.threads.values()];
        f.messages.getByIds = async (ids) => new Map(ids.map((id) => [id, structuredClone(f.messages.getById(id))]));
        f.threadStore.getMany = async (ids) => new Map(ids.map((id) => [id, f.threads.get(id)]));
      }
      assert.equal(
        (await f.recreate().read(card.message.id, card.published.extra.messageSearchAnswer.blockId, human)).status,
        'unavailable',
      );
      assert.equal(f.searches(), 0);
      assert.equal(f.calls(), 0);
    } finally {
      f.db.close();
    }
  });
