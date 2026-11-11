import { describe, expect, it } from 'vitest';
import { chatModels } from '../chat-models';
import { richBlockView } from '../rich-models';
import { fixtureData, fixtureUi } from './chat-fixture';

describe('rich blocks projected into the existing component contract', () => {
  it('preserves unified diff signs, whitespace and multiple hunks using the project parser', () => {
    const view = richBlockView(
      { v: 1, id: 'diff-1', kind: 'diff', filePath: 'a.ts', diff: '@@ -1,2 +1,2 @@\n keep\n-old\n+new' },
      'message-1',
      (s) => s,
    );
    expect(view?.diff?.hunks[0][1]).toEqual([
      [' ', 'keep'],
      ['-', 'old'],
      ['+', 'new'],
    ]);
  });
  it('keeps canonical message/block/item coordinates and resolves actual media URLs', () => {
    const data = fixtureData(),
      ui = fixtureUi();
    data.fileUrl = (s) => `https://api.test${s}`;
    data.messages[0] = {
      ...data.messages[0],
      contentBlocks: [{ type: 'image', url: '/uploads/user.png', alt: 'User attachment' }],
    };
    data.messages[1].extra = {
      rich: {
        v: 1,
        blocks: [
          {
            v: 1,
            id: 'gallery-1',
            kind: 'media_gallery',
            items: [
              { url: '/uploads/a.png', alt: '第一张' },
              { url: '/uploads/b.png', alt: '第二张' },
            ],
          },
        ],
      },
    };
    ui.lb = { mid: 'reply-1', block: 'gallery-1', i: 1 };
    const vm = chatModels(data, ui);
    const embedded = vm.chatStream.items[1].embeds[0];
    expect(vm.chatStream.items[0]).toMatchObject({
      kind: 'user',
      embeds: [
        {
          blockId: 'content-images',
          rich: {
            rk: 'media_gallery',
            count: 1,
            cards: { items: [{ src: 'https://api.test/uploads/user.png', alt: 'User attachment' }] },
          },
        },
      ],
    });
    expect(embedded.blockId).toBe('gallery-1');
    expect(embedded.rich.count).toBe(2);
    expect(embedded.rich.cards?.items[1]).toMatchObject({ src: 'https://api.test/uploads/b.png', alt: '第二张' });
    expect(vm.mediaPreview?.media.src).toBe('https://api.test/uploads/b.png');
  });
  it('retains card Markdown as data for the original body component and keeps file download sources', () => {
    expect(
      richBlockView(
        {
          v: 1,
          id: 'card',
          kind: 'card',
          title: '卡片',
          bodyMarkdown: '**正文**',
          fields: [{ label: '状态', value: '可用' }],
        },
        'm',
        (s) => s,
      ),
    ).toMatchObject({ markdown: '**正文**', kv: [{ k: '状态', v: '可用' }] });
    expect(
      richBlockView(
        { v: 1, id: 'file', kind: 'file', fileName: 'report.pdf', url: '/uploads/report.pdf' },
        'm',
        (s) => `https://api.test${s}`,
      )?.file?.source,
    ).toBe('https://api.test/uploads/report.pdf');
  });
});
