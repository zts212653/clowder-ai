import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { primeCoCreatorConfigCache, resetCoCreatorConfigCacheForTest } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage as ChatMessageData } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { ChatMessage } from '../ChatMessage';
import { MessageActionSlotProvider } from '../MessageActionSlot';
import { SHELL_PRESENTATION_STORAGE_KEY } from '../shell/shell-presentation';

// The co-creator hook asks the API for the config on mount; these tests decide when (and whether) it arrives.
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(() => new Promise(() => undefined)) }));

/**
 * F322 B segment 1 (human message) — your own message in the new presentation (DESIGN.md「对话」, You 2026-10-01):
 * right-aligned, one whole 12px block, no avatar and no signature, the time once under the last of a run, the colour
 * from the human colour roles (cocoa when no colour is configured). Classic is what it always was.
 */
const T = Date.UTC(2026, 9, 1, 20, 41);
const timeText = (ts: number) =>
  new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

function own(id: string, overrides: Partial<ChatMessageData> = {}): ChatMessageData {
  return { id, type: 'user', content: `内容 ${id}`, timestamp: T, ...overrides };
}
const catReply = (id: string): ChatMessageData => ({
  id,
  type: 'assistant',
  catId: 'opus',
  content: `猫 ${id}`,
  timestamp: T + 1000,
});

describe('ChatMessage: your own message', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    resetCoCreatorConfigCacheForTest();
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useChatStore.setState({ currentThreadId: 'thread-1', messages: [], threads: [], isLoadingThreads: false });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.clear();
    resetCoCreatorConfigCacheForTest();
  });

  const config = { name: 'You', aliases: [], mentionPatterns: ['@co-creator'] };
  const configure = (color?: { primary: string; secondary: string }) =>
    act(() => primeCoCreatorConfigCache(color ? { ...config, color } : config));
  const v2 = () => window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'v2');

  function render(
    message: ChatMessageData,
    props: Partial<React.ComponentProps<typeof ChatMessage>> = {},
    actionSlot = false,
  ) {
    const node = (
      <ChatMessage
        message={message}
        threadId="thread-1"
        getCatById={() => undefined}
        onEditCoCreator={() => undefined}
        {...props}
      />
    );
    act(() => {
      root.render(
        actionSlot ? <MessageActionSlotProvider register={() => undefined}>{node}</MessageActionSlotProvider> : node,
      );
    });
  }

  const wrapper = (id: string) => container.querySelector(`[data-message-id="${id}"]`) as HTMLElement;
  const bubble = (id: string) => wrapper(id).querySelector('[data-testid="message-bubble"]') as HTMLElement;
  const time = (id: string) => wrapper(id).querySelector('[data-testid="human-message-time"]') as HTMLElement | null;

  describe('classic presentation is untouched', () => {
    it('keeps the avatar, the name and the time in the header, and the corner tail', () => {
      configure({ primary: '#6B5443', secondary: '#E9DCCF' });
      render(own('a'));

      expect(container.querySelector('button[aria-label="编辑 You"]')).not.toBeNull();
      expect(wrapper('a').textContent).toContain('You');
      expect(wrapper('a').textContent).toContain(timeText(T));
      expect(bubble('a').className).toContain('rounded-br-sm');
      expect(bubble('a').style.backgroundColor).toBe('var(--color-cocreator-surface)');
      expect(time('a')).toBeNull();
    });
  });

  describe('new presentation', () => {
    beforeEach(v2);

    it('has no avatar and no signature: nothing says who you are, because right-aligned is you', () => {
      configure({ primary: '#6B5443', secondary: '#E9DCCF' });
      render(own('a'));

      expect(container.querySelector('button[aria-label="编辑 You"]')).toBeNull();
      expect(wrapper('a').textContent).not.toContain('You');
      expect(wrapper('a').textContent).not.toContain('ME');
      expect(container.querySelector('[data-testid="cat-nameplate"]')).toBeNull();
    });

    it('is one whole right-aligned 12px block, about eighty percent at most, text left-aligned', () => {
      configure({ primary: '#6B5443', secondary: '#E9DCCF' });
      render(own('a'));

      expect(wrapper('a').className.split(/\s+/)).toContain('justify-end');
      expect((wrapper('a').firstElementChild as HTMLElement).className).toContain('max-w-[80%]');
      expect(bubble('a').className.split(/\s+/)).toEqual(expect.arrayContaining(['rounded-xl', 'text-left']));
      expect(bubble('a').className).not.toContain('rounded-br-sm');
      expect(bubble('a').textContent).toContain('内容 a');
    });

    it('takes its fill from the human colour role and keeps the shared message text colour', () => {
      configure({ primary: '#815b5b', secondary: '#FFDDD2' });
      render(own('a'));

      expect(bubble('a').style.backgroundColor).toBe('var(--color-cocreator-surface)');
      expect(bubble('a').style.color).toBe('var(--cat-msg-text)');
    });

    it('is the human colour role whatever the config says: no colour set means cocoa, never a neutral', () => {
      // The component asks for the role; which hue and chroma the role has is the cascade's business (shell-v2.css bakes the
      // shared cocoa, CoCreatorHueInjector replaces it when the config has a colour - both are pinned elsewhere and by the probe).
      render(own('a'));
      expect(bubble('a').style.backgroundColor).toBe('var(--color-cocreator-surface)');

      configure(undefined);
      expect(bubble('a').style.backgroundColor).toBe('var(--color-cocreator-surface)');

      configure({ primary: 'not-a-colour', secondary: '#FFDDD2' });
      expect(bubble('a').style.backgroundColor).toBe('var(--color-cocreator-surface)');

      configure({ primary: '#6B5443', secondary: '#E9DCCF' });
      expect(bubble('a').style.backgroundColor).toBe('var(--color-cocreator-surface)');
      expect(bubble('a').outerHTML).not.toContain('--shell-selected');
    });

    it('shows its time once, under the last message of a run, in the muted caption style', () => {
      configure({ primary: '#6B5443', secondary: '#E9DCCF' });
      const [a, b] = [own('a'), own('b', { timestamp: T + 60_000 })];
      render(a, { timelineMessages: [a, b] });
      expect(time('a')).toBeNull();

      render(b, { timelineMessages: [a, b] });
      expect(time('b')?.textContent).toBe(timeText(T + 60_000));
      expect(time('b')?.className.split(/\s+/)).toContain('text-xs');
      expect(time('b')?.style.color).toBe('var(--shell-muted)');
      // Under the bubble, not in the header above it.
      expect(time('b')?.previousElementSibling).toBe(bubble('b'));
    });

    it('shows the time when a cat reply ends the run, and when it is the only message', () => {
      configure({ primary: '#6B5443', secondary: '#E9DCCF' });
      const a = own('a');
      render(a, { timelineMessages: [a, catReply('x')] });
      expect(time('a')?.textContent).toBe(timeText(T));

      render(a);
      expect(time('a')?.textContent).toBe(timeText(T));
    });

    it('keeps what you could do with the message: the action anchor, the copy-id control, the whisper mark', () => {
      configure({ primary: '#6B5443', secondary: '#E9DCCF' });
      render(own('a', { visibility: 'whisper', whisperTo: ['codex'] }), {}, true);

      expect(wrapper('a').querySelector('[data-message-action-slot]')).not.toBeNull();
      expect(wrapper('a').querySelector('button[aria-label^="复制消息 ID"]')).not.toBeNull();
      expect(wrapper('a').textContent).toContain('悄悄话');
      // An unrevealed whisper keeps its own warning look instead of the human fill.
      expect(bubble('a').className).toContain('border-dashed');
      expect(bubble('a').style.backgroundColor).toBe('');
    });

    it('adds no empty row above a plain message: the header takes no space until it has something to show', () => {
      configure({ primary: '#6B5443', secondary: '#E9DCCF' });
      render(own('a'), {}, true);
      const header = wrapper('a').querySelector('[data-testid="human-message-header"]') as HTMLElement;

      expect(header).not.toBeNull();
      expect(header.className.split(/\s+/)).not.toContain('mb-1');
    });

    it('falls back to the old path where the new one would be wrong: compact replies', () => {
      configure({ primary: '#6B5443', secondary: '#E9DCCF' });
      render(own('a'), { compact: true });

      expect(container.querySelector('button[aria-label="编辑 You"]')).not.toBeNull();
      expect(bubble('a').className).toContain('border-cafe-subtle');
    });

    it('still paints nothing for a message recalled before anyone saw it', () => {
      configure({ primary: '#6B5443', secondary: '#E9DCCF' });
      render(own('a', { extra: { recall: { exposure: 'none', recalledAt: 1 } } as ChatMessageData['extra'] }));

      expect(container.querySelector('[data-message-id="a"]')).toBeNull();
    });
  });

  it('switches with the shell presentation without a reload', () => {
    configure({ primary: '#6B5443', secondary: '#E9DCCF' });
    render(own('a'));
    expect(container.querySelector('button[aria-label="编辑 You"]')).not.toBeNull();

    act(() => {
      window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'v2');
      window.dispatchEvent(new CustomEvent('cat-cafe:shell-presentation-sync'));
    });
    expect(container.querySelector('button[aria-label="编辑 You"]')).toBeNull();
    expect(bubble('a').className).toContain('rounded-xl');
  });
});
