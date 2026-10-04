import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import type { ChatMessage as ChatMessageData } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { ChatMessage } from '../ChatMessage';
import { SHELL_PRESENTATION_STORAGE_KEY } from '../shell/shell-presentation';

const registry = vi.hoisted(() => ({ cats: [] as Array<{ id: string }> }));

// CatAvatar reads the same registry ChatMessage is given; a stub would hide the 16px avatar the plate must render.
vi.mock('@/hooks/useCatData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useCatData')>();
  return {
    ...actual,
    useCatData: () => ({
      getCatById: (id: string) => registry.cats.find((cat) => cat.id === id),
      cats: registry.cats,
      refresh: () => {},
    }),
  };
});

const OPUS = {
  id: 'opus',
  displayName: '布偶猫',
  nickname: '宪宪',
  breedId: 'ragdoll',
  avatar: '/avatars/opus.png',
  color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
  mentionPatterns: ['@opus'],
  clientId: 'anthropic',
  defaultModel: 'claude',
} as unknown as CatData;

const MAINE = {
  ...OPUS,
  id: 'codex',
  displayName: '缅因猫',
  nickname: undefined,
  breedId: 'maine-coon',
  avatar: '/avatars/codex.png',
  color: { primary: '#5B8C5A', secondary: '#D4E6D3' },
} as unknown as CatData;

function catMessage(overrides: Partial<ChatMessageData> = {}): ChatMessageData {
  return {
    id: 'cat-msg-1',
    type: 'assistant',
    catId: 'opus',
    content: '小太阳先把封面做三版。',
    timestamp: Date.UTC(2026, 9, 1, 12, 41),
    ...overrides,
  };
}

describe('F322 B segment 1 — cat nameplate, no outer bubble', () => {
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
    registry.cats = [OPUS, MAINE];
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
  });

  function render(message: ChatMessageData, props: Partial<React.ComponentProps<typeof ChatMessage>> = {}) {
    act(() => {
      root.render(
        <ChatMessage
          message={message}
          threadId="thread-1"
          getCatById={(id) => registry.cats.find((cat) => cat.id === id) as CatData | undefined}
          {...props}
        />,
      );
    });
  }

  const enableV2 = () => window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'v2');
  const plate = () => container.querySelector('[data-testid="cat-nameplate"]') as HTMLElement | null;
  const bubble = () => container.querySelector('[data-testid="message-bubble"]') as HTMLElement;
  const wrapper = () => container.querySelector('[data-message-id]') as HTMLElement;

  describe('classic presentation is untouched', () => {
    it('still draws the bubble with the cat surface, the 32px avatar column and the small name', () => {
      render(catMessage());

      expect(plate()).toBeNull();
      expect(bubble().style.backgroundColor).toBe('var(--color-opus-surface)');
      expect(bubble().className).toContain('px-4 py-3');
      expect(bubble().className).toContain('rounded-2xl rounded-bl-sm');
      expect(wrapper().firstElementChild?.querySelector('img')?.getAttribute('width')).toBe('32');
      const name = container.querySelector('[data-testid="message-header"] span.truncate') as HTMLElement;
      expect(name.textContent).toContain('布偶猫');
      expect(name.style.opacity).toBe('0.8');
    });
  });

  describe('v2 presentation', () => {
    beforeEach(enableV2);

    it('puts the cat in a nameplate at the head of the reply: 16px avatar and name, no separate avatar column', () => {
      render(catMessage());

      const p = plate();
      expect(p).not.toBeNull();
      const avatars = container.querySelectorAll('img');
      expect(avatars).toHaveLength(1);
      expect(p?.contains(avatars[0] as Node)).toBe(true);
      expect(avatars[0]?.getAttribute('width')).toBe('16');
      // The plate is already this cat's colour: the avatar carries no ring of its own (design owner, 2026-10-01).
      expect(avatars[0]?.parentElement?.className.split(/\s+/)).not.toContain('ring-2');
      expect(p?.textContent).toContain('布偶猫');
      // The plate is inside the header, which stays where code and tests find it.
      expect(container.querySelector('[data-testid="message-header"]')?.contains(p)).toBe(true);
    });

    it('sizes the plate as designed and fades the cat surface to transparent from top to bottom', () => {
      render(catMessage());
      const p = plate() as HTMLElement;

      expect(p.className.split(/\s+/)).toEqual(expect.arrayContaining(['h-[26px]', 'rounded-t-lg', 'pl-2', 'pr-2.5']));
      expect(p.style.backgroundImage).toBe('linear-gradient(to bottom, var(--color-opus-surface), transparent)');
    });

    it('gives the name the cat name colour at full strength (no opacity that would cost contrast), 13px / 600', () => {
      render(catMessage());
      const name = plate()?.querySelector('[data-testid="cat-nameplate-name"]') as HTMLElement;

      expect(name.style.color).toBe('var(--color-opus-text)');
      expect(name.style.opacity).toBe('');
      expect(name.className.split(/\s+/)).toEqual(
        expect.arrayContaining(['text-compact', 'font-semibold', 'truncate']),
      );
    });

    it('puts the time to the right of the plate, not inside it', () => {
      render(catMessage());
      const time = container.querySelector('[data-testid="cat-nameplate-time"]') as HTMLElement;

      expect(time).not.toBeNull();
      expect(plate()?.contains(time)).toBe(false);
      expect(plate()?.nextElementSibling).toBe(time);
      expect(time.className.split(/\s+/)).toContain('text-xs');
    });

    it('draws no bubble: no fill, no border, no frame padding, no radius, no hover lift; the text lines up with the avatar', () => {
      render(catMessage());
      const b = bubble();

      expect(b.style.backgroundColor).toBe('');
      expect(b.style.borderColor).toBe('');
      for (const chrome of ['px-4', 'py-3', 'overflow-hidden', 'hover:-translate-y-0.5']) {
        expect(b.className.split(/\s+/)).not.toContain(chrome);
      }
      expect(b.className).not.toMatch(/\brounded/);
      // The only inset is the plate's own 8px, so the first character sits under the avatar's left edge.
      expect(b.className.split(/\s+/)).toContain('pl-2');
      expect(b.className).not.toMatch(/\bborder\b/);
      // The text keeps the colour the nested thinking / CLI blocks derive from.
      expect(b.style.color).toBe('var(--cat-msg-text)');
    });

    it('does not carry a breed voice into the reply: the maine-coon mono font is the bubble voice, not the plain reply voice', () => {
      render(catMessage({ catId: 'codex' }));

      expect(bubble().className).not.toContain('font-mono');
    });

    it('keeps the DOM targets: data-message-id on the wrapper, message-bubble around the body, group for hover actions', () => {
      render(catMessage());

      expect(wrapper().getAttribute('data-message-id')).toBe('cat-msg-1');
      expect(wrapper().className).toContain('group');
      expect(wrapper().className).toContain('cat-persona-derived');
      expect(bubble().textContent).toContain('小太阳先把封面做三版');
      expect(container.querySelector('[data-testid="message-header"]')).not.toBeNull();
    });

    it('keeps the streaming state on the avatar and the edit-cat action on a click', () => {
      const onEditCat = vi.fn();
      render(catMessage({ isStreaming: true }), { onEditCat });

      const avatarButton = plate()?.querySelector('button') as HTMLButtonElement;
      expect(avatarButton).not.toBeNull();
      expect(avatarButton.className).toContain('animate-pulse');
      act(() => avatarButton.click());
      expect(onEditCat).toHaveBeenCalledWith('opus');
    });

    it('keeps the message actions, the copy-id control and the badges in the header row after the time', () => {
      render(
        catMessage({
          extra: { recovery: { kind: 'f254_withheld_message' } } as ChatMessageData['extra'],
        }),
      );
      const header = container.querySelector('[data-testid="message-header"]') as HTMLElement;

      expect(header.textContent).toContain('事故恢复');
      expect(header.querySelector('[data-testid="cat-nameplate"]')).not.toBeNull();
    });

    it('keeps the whisper pill next to the plate', () => {
      render(catMessage({ visibility: 'whisper', whisperTo: ['codex'] }));

      expect(plate()).not.toBeNull();
      expect(container.querySelector('[data-testid="message-header"]')?.textContent).toContain('悄悄话');
    });

    it('lets the body reach the reading column edge instead of stopping at 75%', () => {
      render(catMessage());
      const column = wrapper().firstElementChild as HTMLElement;

      expect(column.className.split(/\s+/)).toContain('max-w-full');
      expect(column.className).not.toContain('75%');
    });

    it('falls back to the old bubble where a nameplate would be wrong: compact replies', () => {
      render(catMessage(), { compact: true });

      expect(plate()).toBeNull();
      expect(bubble().className).toContain('px-4 py-3');
    });

    it('falls back to the old bubble where the cat is not known to the registry', () => {
      registry.cats = [];
      render(catMessage({ catId: 'ghost' }));

      expect(plate()).toBeNull();
    });

    it('does not touch the co-creator message', () => {
      render({ id: 'u-1', type: 'user', content: '三版封面，暖一点', timestamp: Date.UTC(2026, 9, 1, 12, 40) });

      expect(plate()).toBeNull();
      expect(container.textContent).toContain('三版封面，暖一点');
    });
  });

  it('switches with the shell presentation without a reload', () => {
    render(catMessage());
    expect(plate()).toBeNull();

    act(() => {
      window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'v2');
      window.dispatchEvent(new Event('storage'));
      window.dispatchEvent(new CustomEvent('cat-cafe:shell-presentation-sync'));
    });
    expect(plate()).not.toBeNull();

    act(() => {
      window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'classic');
      window.dispatchEvent(new CustomEvent('cat-cafe:shell-presentation-sync'));
    });
    expect(plate()).toBeNull();
    expect(bubble().className).toContain('px-4 py-3');
  });
});
