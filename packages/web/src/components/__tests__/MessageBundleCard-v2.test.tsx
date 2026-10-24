import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageBundleCard } from '../MessageBundleCard';
import { writeShellLanguage } from '../shell/shell-language';
import { writeShellPresentation } from '../shell/shell-presentation';

const api = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => api(...args) }));
vi.mock('../rich/RichBlocks', () => ({
  RichBlocks: ({ readOnly }: { readOnly?: boolean }) => <div data-rich-read-only={String(readOnly)} />,
}));
vi.mock('../CatAvatar', () => ({ CatAvatar: ({ size }: { size: number }) => <span data-avatar-size={size} /> }));

const available = (id: string, text: string) => ({
  status: 'available',
  kind: 'message',
  messageId: id,
  sourceThreadId: 'source',
  from: { kind: 'agent', catId: 'opus' },
  timestamp: 100,
  readableContent: text,
});
const items = [
  { status: 'tombstone', messageId: 'first', reason: 'source_unavailable' },
  available('second', 'SECOND source'),
  available('third', 'THIRD source'),
];
const response = (value: unknown = items) =>
  new Response(
    JSON.stringify({
      messageBundleId: 'bundle',
      targetThreadId: 'target',
      createdBy: 'operator',
      createdAt: 200,
      note: 'My forwarding note',
      sourceThread: { id: 'source', title: 'Source Thread' },
      items: value,
    }),
    { status: 200 },
  );

describe('F322 forwarded paper card', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    api.mockReset();
    api.mockImplementation(async () => response());
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    writeShellPresentation('classic');
    writeShellLanguage('zh');
  });
  async function render(presentation: 'classic' | 'v2') {
    writeShellPresentation(presentation);
    await act(async () =>
      root.render(<MessageBundleCard messageId="bundle" forwarderName="You" getCatLabel={(id) => `Cat ${id}`} />),
    );
  }
  async function toggle() {
    const button = host.querySelector<HTMLButtonElement>('button[aria-expanded]');
    expect(button).not.toBeNull();
    await act(async () => button!.click());
  }
  it('pins the complete classic output even with English selected', async () => {
    writeShellLanguage('en');
    await render('classic');
    expect(host.innerHTML).toMatchSnapshot();
  });
  it('previews the original first two entries including the unavailable first entry, and puts the note outside the card', async () => {
    await render('v2');
    expect(host.querySelectorAll('[data-bundle-preview-item]')).toHaveLength(2);
    expect(host.textContent).toContain('原消息已删除、撤回或不可见');
    expect(host.textContent).toContain('SECOND source');
    expect(host.textContent).not.toContain('THIRD source');
    expect(host.querySelector('[data-avatar-size="16"]')).not.toBeNull();
    const note = host.querySelector('[data-message-bundle-note]');
    expect(note?.getAttribute('aria-label')).toBe('转发留言');
    expect(note?.closest('[data-message-bundle-card]')).toBeNull();
    expect(host.textContent).not.toContain('You 的留言');
    expect(host.querySelectorAll('[data-message-bundle-id="bundle"]')).toHaveLength(1);
  });
  it('rereads permission on every expansion and never displays the old preview after a denied reread', async () => {
    await render('v2');
    api.mockResolvedValueOnce(response([available('second', 'FRESH source'), available('third', 'FRESH third')]));
    await toggle();
    expect(api).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain('FRESH source');
    expect(host.textContent).not.toContain('SECOND source');
    await toggle();
    api.mockResolvedValueOnce(new Response('{}', { status: 403 }));
    await toggle();
    expect(api).toHaveBeenCalledTimes(3);
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
    expect(host.textContent).not.toContain('FRESH source');
  });
  it('counts source messages once when a partial message is represented by a quote and a card', async () => {
    api.mockResolvedValueOnce(
      response([
        { ...available('same-source', 'selected text'), kind: 'quote' },
        {
          ...available('same-source', 'selected card'),
          kind: 'rich_block',
          richBlock: { id: 'selected-card', kind: 'card', v: 1, title: 'Selected card' },
        },
        available('other-source', 'other message'),
      ]),
    );
    await render('v2');
    expect(host.textContent).toContain('2 条聊天记录');
    expect(host.textContent).toContain('展开全部 3 项内容');
    expect(host.textContent).not.toContain('3 条聊天记录');
  });
  it('uses English wording for the same ordered preview without changing source content', async () => {
    writeShellLanguage('en');
    await render('v2');
    expect(host.textContent).toContain('Show all 3');
    expect(host.textContent).toContain('SECOND source');
    expect(host.querySelector('[data-message-bundle-note]')?.getAttribute('aria-label')).toBe('Forwarding note');
  });
  it('never paints another bundle while its new identity is being authorized', async () => {
    await render('v2');
    api.mockImplementationOnce(() => new Promise(() => undefined));
    await act(async () =>
      root.render(<MessageBundleCard messageId="other-bundle" forwarderName="You" getCatLabel={(id) => `Cat ${id}`} />),
    );
    expect(host.textContent).not.toContain('SECOND source');
    expect(host.querySelector('[data-message-bundle-id="other-bundle"]')).toBeNull();
    expect(host.querySelector('output')).not.toBeNull();
  });
  it('opens a single authorized message directly, with no multi-item fold control', async () => {
    api.mockResolvedValueOnce(response([available('only', 'SINGLE readable source')]));
    await render('v2');
    expect(host.textContent).toContain('SINGLE readable source');
    expect(host.querySelector('[data-bundle-preview-item]')).toBeNull();
    expect(host.querySelector('button[aria-expanded]')).toBeNull();
    expect(host.querySelector('button[aria-label="查看来源消息 1"]')).not.toBeNull();
  });
  it('keeps an authorized single rich block read-only inside the unframed paper', async () => {
    const item = {
      ...available('rich', 'rich source'),
      kind: 'rich_block',
      richBlock: {
        id: 'block-1',
        kind: 'card',
        v: 1,
        title: 'Immutable source',
        actions: [{ label: 'Do not invoke', action: 'send-message' }],
      },
    };
    api.mockResolvedValueOnce(response([item]));
    await render('v2');
    expect(host.querySelector('[data-forwarded-rich-block="block-1"] [data-rich-read-only="true"]')).not.toBeNull();
    expect(host.querySelector('button[aria-expanded]')).toBeNull();
  });
});
