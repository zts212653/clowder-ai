/**
 * F080: Input history completion — ghost text + Tab accept + Ctrl+R search.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '@/components/ChatInput';
import { useInputHistoryStore } from '@/stores/inputHistoryStore';

// ── Mocks ──
vi.mock('@/components/icons/SendIcon', () => ({
  SendIcon: () => React.createElement('span', null, 'send'),
}));
vi.mock('@/components/icons/LoadingIcon', () => ({
  LoadingIcon: () => React.createElement('span', null, 'loading'),
}));
vi.mock('@/components/icons/AttachIcon', () => ({
  AttachIcon: () => React.createElement('span', null, 'attach'),
}));
vi.mock('@/components/ImagePreview', () => ({ ImagePreview: () => null }));
vi.mock('@/utils/compressImage', () => ({ compressImage: (f: File) => Promise.resolve(f) }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [
      {
        id: 'opus',
        displayName: '布偶猫',
        color: { primary: '#9B7EBD', secondary: '#E8D5F5' },
        mentionPatterns: ['布偶猫'],
        clientId: 'anthropic',
        defaultModel: 'opus',
        avatar: '/a.png',
        roleDescription: 'dev',
        personality: 'kind',
      },
    ],
    isLoading: false,
    getCatById: () => undefined,
    getCatsByBreed: () => new Map(),
  }),
}));

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  useInputHistoryStore.setState({ entries: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function getTextarea(): HTMLTextAreaElement {
  return container.querySelector('textarea') as HTMLTextAreaElement;
}

function typeInto(textarea: HTMLTextAreaElement, value: string) {
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  nativeSetter.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function pressKey(textarea: HTMLTextAreaElement, key: string, opts: Partial<KeyboardEventInit> = {}) {
  textarea.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts }));
}

describe('ChatInput history completion', () => {
  it('saves sent message to input history', () => {
    const onSend = vi.fn();
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-1', onSend }));
    });
    act(() => {
      typeInto(getTextarea(), 'hello world');
    });
    act(() => {
      pressKey(getTextarea(), 'Enter');
    });

    expect(onSend).toHaveBeenCalledWith('hello world', undefined, undefined, undefined);
    expect(useInputHistoryStore.getState().entries).toContain('hello world');
  });

  it('shows ghost text suggestion element when prefix matches history', () => {
    // Pre-populate history
    useInputHistoryStore.setState({ entries: ['hello world', 'hey there'] });

    const onSend = vi.fn();
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-1', onSend }));
    });
    act(() => {
      typeInto(getTextarea(), 'hel');
    });

    const ghost = container.querySelector('[data-testid="ghost-suggestion"]');
    expect(ghost).not.toBeNull();
    // Ghost should show the full suggestion text with visible/invisible parts
    expect(ghost?.textContent).toContain('hello world');
  });

  it('accepts ghost suggestion on Tab key', () => {
    useInputHistoryStore.setState({ entries: ['hello world'] });

    const onSend = vi.fn();
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-1', onSend }));
    });
    act(() => {
      typeInto(getTextarea(), 'hel');
    });

    // Press Tab to accept
    act(() => {
      pressKey(getTextarea(), 'Tab');
    });

    expect(getTextarea().value).toBe('hello world');
  });

  it('accepts ghost suggestion on ArrowRight key', () => {
    useInputHistoryStore.setState({ entries: ['hello world'] });

    const onSend = vi.fn();
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-1', onSend }));
    });
    act(() => {
      typeInto(getTextarea(), 'hel');
    });
    act(() => {
      pressKey(getTextarea(), 'ArrowRight');
    });

    expect(getTextarea().value).toBe('hello world');
  });

  it('does not show ghost text when no match', () => {
    useInputHistoryStore.setState({ entries: ['hello world'] });

    const onSend = vi.fn();
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-1', onSend }));
    });
    act(() => {
      typeInto(getTextarea(), 'xyz');
    });

    const ghost = container.querySelector('[data-testid="ghost-suggestion"]');
    expect(ghost).toBeNull();
  });

  it('clears ghost text after accepting suggestion', () => {
    useInputHistoryStore.setState({ entries: ['hello world'] });

    const onSend = vi.fn();
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-1', onSend }));
    });
    act(() => {
      typeInto(getTextarea(), 'hel');
    });
    act(() => {
      pressKey(getTextarea(), 'Tab');
    });

    // Ghost should be gone after accepting
    const ghost = container.querySelector('[data-testid="ghost-suggestion"]');
    expect(ghost).toBeNull();
  });

  it('ArrowRight does NOT accept when cursor is not at end', () => {
    useInputHistoryStore.setState({ entries: ['hello world'] });

    const onSend = vi.fn();
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-1', onSend }));
    });
    act(() => {
      typeInto(getTextarea(), 'hel');
    });

    // Move cursor to position 1 (not at end)
    const ta = getTextarea();
    ta.selectionStart = 1;
    ta.selectionEnd = 1;

    act(() => {
      pressKey(ta, 'ArrowRight');
    });

    // Should NOT accept — value stays 'hel'
    expect(ta.value).toBe('hel');
  });

  it('Ctrl+R clears active mention menu before opening search', () => {
    useInputHistoryStore.setState({ entries: ['hello world'] });

    const onSend = vi.fn();
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-1', onSend }));
    });
    // Type @ to trigger mention menu
    act(() => {
      typeInto(getTextarea(), '@');
    });
    const mentionMenu = container.querySelector('[class*="absolute bottom-full"]');
    expect(mentionMenu).not.toBeNull();

    // Ctrl+R should close mention menu and open search
    act(() => {
      pressKey(getTextarea(), 'r', { ctrlKey: true });
    });
    const searchModal = container.querySelector('[data-testid="history-search"]');
    expect(searchModal).not.toBeNull();
    // Mention menu should be gone
    const mentionMenuAfter = container.querySelectorAll('[class*="absolute bottom-full"]');
    // Only the search modal should be positioned absolute, not the mention menu
    const hasMentionMenu = Array.from(mentionMenuAfter).some((el) => el.textContent?.includes('布偶猫'));
    expect(hasMentionMenu).toBe(false);
  });

  it('ghost text clears when input changes programmatically (insertMention)', () => {
    useInputHistoryStore.setState({ entries: ['hello world'] });

    const onSend = vi.fn();
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-1', onSend }));
    });
    // Type to get ghost suggestion
    act(() => {
      typeInto(getTextarea(), 'hel');
    });
    const ghostBefore = container.querySelector('[data-testid="ghost-suggestion"]');
    expect(ghostBefore).not.toBeNull();

    // Now type @ to trigger mention — this changes input programmatically
    act(() => {
      typeInto(getTextarea(), '@布偶猫 ');
    });
    const ghostAfter = container.querySelector('[data-testid="ghost-suggestion"]');
    // Ghost should be gone — no history entry starts with "@布偶猫 "
    expect(ghostAfter).toBeNull();
  });

  it('opens history search on Ctrl+R', () => {
    useInputHistoryStore.setState({ entries: ['hello world', 'test message'] });

    const onSend = vi.fn();
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-1', onSend }));
    });
    act(() => {
      pressKey(getTextarea(), 'r', { ctrlKey: true });
    });

    const searchModal = container.querySelector('[data-testid="history-search"]');
    expect(searchModal).not.toBeNull();
  });

  it('does not select history item on Enter during IME composition', () => {
    useInputHistoryStore.setState({ entries: ['hello world', 'test message'] });

    const onSend = vi.fn();
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-1', onSend }));
    });
    // Open search modal
    act(() => {
      pressKey(getTextarea(), 'r', { ctrlKey: true });
    });

    const searchModal = container.querySelector('[data-testid="history-search"]');
    expect(searchModal).not.toBeNull();

    const searchInput = searchModal?.querySelector('input') as HTMLInputElement;
    expect(searchInput).not.toBeNull();

    // Type a search term
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(searchInput, 'hel');
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Simulate Enter during IME composition: compositionstart → keydown(Enter)
    act(() => {
      searchInput.dispatchEvent(new Event('compositionstart', { bubbles: true }));
      searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    // Search modal should still be open (not dismissed by IME Enter)
    const modalAfter = container.querySelector('[data-testid="history-search"]');
    expect(modalAfter).not.toBeNull();
  });
});
