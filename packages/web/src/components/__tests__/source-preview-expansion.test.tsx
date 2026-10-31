import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import type { ChatMessage as Message } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { ChatMessage } from '../ChatMessage';

let presentation: 'classic' | 'v2' = 'classic';
vi.mock('../shell/shell-presentation', () => ({ useShellPresentation: () => presentation }));
vi.mock('@/hooks/useCoCreatorConfig', () => ({
  useCoCreatorConfig: () => ({
    name: 'owner',
    aliases: [],
    mentionPatterns: [],
    color: { primary: '#B05F45', secondary: '#eeeeee' },
  }),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(() => new Promise(() => undefined)) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('../content-overflow/useMeasuredOverflow', () => ({
  useMeasuredOverflow: () => ({ ref: vi.fn(), overflowing: true }),
}));
const member = { id: 'codex', displayName: 'Member', color: { primary: '#659D62', secondary: '#eeeeee' } } as CatData;
const getCatById = (id: string) => (id === 'codex' ? member : undefined);
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById, cats: [member] }),
  formatCatName: (cat: CatData) => cat.displayName,
}));
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
const source: Message = {
  id: 'source',
  from: { kind: 'user', userId: 'owner' },
  type: 'user',
  content: '完整原文 '.repeat(25) + 'EXACT_BODY_TAIL',
  timestamp: 1,
};
const response: Message = {
  id: 'response',
  from: { kind: 'agent', catId: 'codex' },
  catId: 'codex',
  type: 'assistant',
  content: 'response body',
  timestamp: 2,
  replyTo: source.id,
  replyPreview: { from: source.from, senderCatId: null, content: '摘要' },
};

describe('source expansion reads the exact authorized timeline body', () => {
  let container: HTMLDivElement, root: Root;
  beforeEach(() => {
    presentation = 'classic';
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    useChatStore.setState({ currentThreadId: 't', messages: [] });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useChatStore.setState({ currentThreadId: '', messages: [] });
  });
  function render(inputs: Message[], message = response) {
    act(() =>
      root.render(<ChatMessage message={message} threadId="t" timelineMessages={inputs} getCatById={getCatById} />),
    );
  }
  function pill() {
    const button = [...container.querySelectorAll<HTMLButtonElement>('button[title]')].find(
      (x) => x.firstElementChild?.textContent?.trim() === '↩',
    );
    if (!button) throw new Error('source pill missing');
    return button;
  }
  it('keeps the short summary collapsed and reveals the complete source only after expansion', () => {
    render([source]);
    expect(pill().textContent).toContain('摘要');
    expect(pill().textContent).not.toContain('EXACT_BODY_TAIL');
    act(() => pill().click());
    expect(pill().textContent).toContain(source.content);
    act(() => pill().click());
    expect(pill().textContent).toContain('摘要');
    expect(pill().textContent).not.toContain('EXACT_BODY_TAIL');
  });
  it.each([
    ['different source id', [{ ...source, id: 'other-source' }]],
    ['recalled source', [{ ...source, extra: { recall: { version: 1, exposure: 'seen', recalledAt: 3 } } }]],
    ['ambiguous binding', [source, { ...source, content: 'duplicate EXACT_BODY_TAIL' }]],
    ['missing source', []],
  ] as const)('does not expand a body from %s', (_reason, inputs) => {
    render([...inputs] as Message[]);
    act(() => pill().click());
    expect(pill().textContent).not.toContain('EXACT_BODY_TAIL');
  });
  it('never expands a deleted source preview even if stale body data remains', () => {
    render([source], {
      ...response,
      replyPreview: { from: source.from, senderCatId: null, content: '', deleted: true },
    });
    act(() => pill().click());
    expect(pill().textContent).toContain('消息已删除');
    expect(pill().textContent).not.toContain('EXACT_BODY_TAIL');
  });
  it('does not borrow the current store body for a different rendered thread', () => {
    useChatStore.setState({ currentThreadId: 'other', messages: [source] });
    act(() => root.render(<ChatMessage message={response} threadId="t" getCatById={getCatById} />));
    act(() => pill().click());
    expect(pill().textContent).not.toContain('EXACT_BODY_TAIL');
  });
  it('preserves the v2 short source preview and direct jump', () => {
    presentation = 'v2';
    render([source]);
    expect(pill().getAttribute('aria-expanded')).toBeNull();
    expect(pill().textContent).toContain('摘要');
    act(() => pill().click());
    expect(pill().textContent).not.toContain('EXACT_BODY_TAIL');
  });
});
