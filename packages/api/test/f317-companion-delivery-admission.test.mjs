import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompanionWorkOverview } from '../src/domains/concierge/live/work/companion-work-overview.ts';
import { workFixture } from './helpers/f317-companion-work-fixture.mjs';

test('only addressable cat publications enter delivery slots, even when later human uploads fill the page', async (t) => {
  const f = await workFixture(t);
  const product = f.publish('真正的成品.md', 1000);
  f.messages.append({
    userId: 'owner',
    threadId: f.thread.id,
    from: { kind: 'agent', catId: 'codex-sol' },
    content: '对话辅助',
    mentions: [],
    timestamp: 2000,
    extra: {
      rich: {
        v: 1,
        blocks: [
          { kind: 'audio', v: 1, id: 'voice', text: '正在考虑你的问题', url: '/uploads/voice.mp3' },
          {
            kind: 'interactive',
            v: 1,
            id: 'choice',
            interactiveType: 'select',
            title: '要哪个方案？',
            options: [{ id: 'a', label: 'A' }],
          },
          { kind: 'html_widget', v: 1, id: 'widget', title: '临时图示', html: '<p>context</p>' },
          { kind: 'diff', v: 1, id: 'diff', filePath: 'draft.md', diff: '+draft' },
        ],
      },
    },
  });
  const beforeUploads = await new CompanionWorkOverview(f.options).read();
  assert.deepEqual(
    beforeUploads.recentDeliveries.map((row) => row.sourceRef),
    [`message:${f.thread.id}:${product.id}`],
  );
  for (let i = 0; i < 10; i++)
    f.messages.append({
      userId: 'owner',
      threadId: f.thread.id,
      from: { kind: 'user', userId: 'owner' },
      content: '这份是我的参考',
      mentions: [],
      timestamp: 3000 + i,
      contentBlocks: [
        { type: 'image', url: `/uploads/screen-${i}.png` },
        { type: 'file', url: `/uploads/notes-${i}.pdf`, fileName: `notes-${i}.pdf`, mimeType: 'application/pdf' },
      ],
    });
  const view = await new CompanionWorkOverview(f.options).read();
  assert.deepEqual(
    view.recentDeliveries.map((row) => row.sourceRef),
    [`message:${f.thread.id}:${product.id}`],
  );
  assert.equal(view.coverage.find((row) => row.source === 'messages').status, 'available');
});

test('publication revalidation applies the same cat-delivery admission as initial collection', async (t) => {
  const f = await workFixture(t);
  const product = f.publish('成品.md');
  const view = await new CompanionWorkOverview({
    ...f.options,
    messages: {
      getByThread: f.messages.getByThread.bind(f.messages),
      getById: (id) => (id === product.id ? { ...f.messages.getById(id), catId: null } : f.messages.getById(id)),
    },
  }).read();
  assert.deepEqual(view.recentDeliveries, []);
});
