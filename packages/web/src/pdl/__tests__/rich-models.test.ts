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
      )?.file,
    ).toMatchObject({ source: 'https://api.test/uploads/report.pdf', mid: 'm', url: '/uploads/report.pdf' });
    // an image or file that is not a registered work opens by its message and its stored url
    expect(
      richBlockView(
        { v: 1, id: 'g', kind: 'media_gallery', items: [{ url: '/uploads/a.png', alt: 'a' }] },
        'm',
        (s) => `https://api.test${s}`,
      )?.cards?.items[0],
    ).toMatchObject({ src: 'https://api.test/uploads/a.png', mid: 'm', url: '/uploads/a.png', work: '' });
  });
});

it('shows a profile update proposal as its rationale, the line diff and the full before/after', () => {
  const body = [
    '评审意见先结论。',
    '',
    '**改动（+1 / -1 行）：**',
    '~~~diff',
    '@@ -1,2 +1,2 @@',
    ' # 开场',
    '-先说进度。',
    '+先写结论。',
    '~~~',
    '',
    '**当前内容：**',
    '```',
    '# 开场\n先说进度。',
    '```',
    '',
    '**提议改为：**',
    '```',
    '# 开场\n先写结论。',
    '```',
  ].join('\n');
  const view = richBlockView(
    { v: 1, id: 'p', kind: 'card', title: '提议更新开场简介', bodyMarkdown: body },
    'm',
    (s) => s,
  );
  expect(view).toMatchObject({
    markdown: '评审意见先结论。',
    diff: {
      hunks: [
        [
          '@@ -1,2 +1,2 @@',
          [
            [' ', '# 开场'],
            ['-', '先说进度。'],
            ['+', '先写结论。'],
          ],
        ],
      ],
    },
    profile: { key: 'm:p:full', before: '# 开场\n先说进度。', after: '# 开场\n先写结论。' },
  });
  const first = body.replace(/~~~diff[\s\S]*?~~~/, '~~~diff\n（内容无逐行差异）\n~~~');
  expect(
    richBlockView({ v: 1, id: 'p', kind: 'card', title: 't', bodyMarkdown: first }, 'm', (s) => s)?.diff,
  ).toBeUndefined();
});

it('treats a Codex question group as submitted when a sibling has a saved answer', () => {
  const first = {
    id: 'first',
    v: 1 as const,
    kind: 'interactive' as const,
    groupId: 'codex-async-question-group',
    interactiveType: 'select' as const,
    disabled: true,
    selectedIds: ['a'],
    options: [{ id: 'a', label: 'A' }],
  };
  const second = { ...first, id: 'second', disabled: false, selectedIds: [] };
  const result = richBlockView(second, 'message', (url) => url, {}, [first, second]);
  expect(result?.pick).toMatchObject({ done: true, submit: false, custom: null });
});
