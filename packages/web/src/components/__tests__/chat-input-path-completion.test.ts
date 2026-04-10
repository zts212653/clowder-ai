/**
 * F080-P2: Path completion integration tests with ChatInput.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInput } from '@/components/ChatInput';
import { useInputHistoryStore } from '@/stores/inputHistoryStore';

// ── Mocks ──
const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

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

function jsonOk(data: unknown) {
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  vi.useFakeTimers();
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  vi.useRealTimers();
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  useInputHistoryStore.setState({ entries: [] });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // Default: no path completion results
  mockApiFetch.mockImplementation(() => jsonOk({ entries: [] }));
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

describe('ChatInput path completion', () => {
  it('shows path completion menu when API returns entries', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/projects/complete')) {
        return jsonOk({
          entries: [
            { name: 'components/', path: '/test/src/components', isDirectory: true },
            { name: 'utils/', path: '/test/src/utils', isDirectory: true },
          ],
        });
      }
      return jsonOk({ entries: [] });
    });

    const onSend = vi.fn();
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-1', onSend }));
    });

    // Type a path pattern
    act(() => {
      typeInto(getTextarea(), './src/');
    });
    // Advance debounce timer
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    const menu = container.querySelector('[data-testid="path-completion-menu"]');
    expect(menu).not.toBeNull();
    expect(menu?.textContent).toContain('components/');
    expect(menu?.textContent).toContain('utils/');
  });

  it('does not show menu when no path pattern', async () => {
    const onSend = vi.fn();
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-1', onSend }));
    });
    act(() => {
      typeInto(getTextarea(), 'hello world');
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    const menu = container.querySelector('[data-testid="path-completion-menu"]');
    expect(menu).toBeNull();
  });

  it('selects entry with Tab key and inserts into input', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/projects/complete')) {
        return jsonOk({
          entries: [{ name: 'components/', path: '/test/src/components', isDirectory: true }],
        });
      }
      return jsonOk({ entries: [] });
    });

    const onSend = vi.fn();
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-1', onSend }));
    });

    act(() => {
      typeInto(getTextarea(), './src/comp');
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    // Menu should be visible
    const menu = container.querySelector('[data-testid="path-completion-menu"]');
    expect(menu).not.toBeNull();

    // Tab to select
    act(() => {
      pressKey(getTextarea(), 'Tab');
    });

    // Input should be updated with completed path
    expect(getTextarea().value).toBe('./src/components/');
    // Menu should close
    const menuAfter = container.querySelector('[data-testid="path-completion-menu"]');
    expect(menuAfter).toBeNull();
  });

  it('closes menu on Escape', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/projects/complete')) {
        return jsonOk({
          entries: [{ name: 'foo/', path: '/test/foo', isDirectory: true }],
        });
      }
      return jsonOk({ entries: [] });
    });

    const onSend = vi.fn();
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-1', onSend }));
    });

    act(() => {
      typeInto(getTextarea(), './foo');
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(container.querySelector('[data-testid="path-completion-menu"]')).not.toBeNull();

    act(() => {
      pressKey(getTextarea(), 'Escape');
    });
    expect(container.querySelector('[data-testid="path-completion-menu"]')).toBeNull();
  });

  it('hides ghost text when path completion menu is open', async () => {
    useInputHistoryStore.setState({ entries: ['./src/components/App.tsx'] });

    mockApiFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/projects/complete')) {
        return jsonOk({
          entries: [{ name: 'components/', path: '/test/src/components', isDirectory: true }],
        });
      }
      return jsonOk({ entries: [] });
    });

    const onSend = vi.fn();
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-1', onSend }));
    });

    act(() => {
      typeInto(getTextarea(), './src/');
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    // Path menu should be open
    expect(container.querySelector('[data-testid="path-completion-menu"]')).not.toBeNull();
    // Ghost text should be hidden
    expect(container.querySelector('[data-testid="ghost-suggestion"]')).toBeNull();
  });

  it('P1 regression: Esc does not cause menu to reopen after debounce', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/projects/complete')) {
        return jsonOk({
          entries: [{ name: 'foo/', path: '/test/foo', isDirectory: true }],
        });
      }
      return jsonOk({ entries: [] });
    });

    const onSend = vi.fn();
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-1', onSend }));
    });

    act(() => {
      typeInto(getTextarea(), './foo');
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(container.querySelector('[data-testid="path-completion-menu"]')).not.toBeNull();

    // Esc to close
    act(() => {
      pressKey(getTextarea(), 'Escape');
    });
    expect(container.querySelector('[data-testid="path-completion-menu"]')).toBeNull();

    // Wait past another debounce — menu must NOT reopen
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(container.querySelector('[data-testid="path-completion-menu"]')).toBeNull();
  });

  it('P1 regression: after selecting file, Enter sends message (not re-select)', async () => {
    mockApiFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/projects/complete')) {
        return jsonOk({
          entries: [{ name: 'index.ts', path: '/test/src/index.ts', isDirectory: false }],
        });
      }
      return jsonOk({ entries: [] });
    });

    const onSend = vi.fn();
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-1', onSend }));
    });

    act(() => {
      typeInto(getTextarea(), './src/ind');
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(container.querySelector('[data-testid="path-completion-menu"]')).not.toBeNull();

    // Tab to select file
    act(() => {
      pressKey(getTextarea(), 'Tab');
    });
    expect(container.querySelector('[data-testid="path-completion-menu"]')).toBeNull();

    // Wait past debounce — menu should NOT reopen for a file selection
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(container.querySelector('[data-testid="path-completion-menu"]')).toBeNull();

    // Enter should send, not re-select
    act(() => {
      pressKey(getTextarea(), 'Enter');
    });
    expect(onSend).toHaveBeenCalled();
  });

  it('cloud P1 regression: stale response does not reopen menu after path deleted', async () => {
    // Scenario: type path → fetch dispatched → delete path → response arrives
    // Expected: menu stays closed because input no longer has path pattern
    let resolveDeferred: (value: unknown) => void;
    const deferredPromise = new Promise((resolve) => {
      resolveDeferred = resolve;
    });

    mockApiFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/projects/complete')) {
        return deferredPromise.then(() => ({
          ok: true,
          json: () =>
            Promise.resolve({
              entries: [{ name: 'components/', path: '/test/src/components', isDirectory: true }],
            }),
        }));
      }
      return jsonOk({ entries: [] });
    });

    const onSend = vi.fn();
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-1', onSend }));
    });

    // Type path to trigger fetch
    act(() => {
      typeInto(getTextarea(), './src');
    });
    // Advance past debounce to dispatch the request
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    // Now replace input with non-path text BEFORE response arrives
    act(() => {
      typeInto(getTextarea(), 'hello');
    });
    await act(async () => {
      vi.advanceTimersByTime(50);
    });

    // Resolve the deferred response
    await act(async () => {
      resolveDeferred?.(undefined);
      await Promise.resolve(); // flush microtasks
    });

    // Menu must NOT reopen — input no longer has a path pattern
    expect(container.querySelector('[data-testid="path-completion-menu"]')).toBeNull();
  });

  it('path completion takes priority over history ghost when both match', async () => {
    // History has a match, and path completion also returns results
    useInputHistoryStore.setState({ entries: ['./src/old-file.ts'] });

    mockApiFetch.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/projects/complete')) {
        return jsonOk({
          entries: [{ name: 'components/', path: '/test/src/components', isDirectory: true }],
        });
      }
      return jsonOk({ entries: [] });
    });

    const onSend = vi.fn();
    act(() => {
      root.render(React.createElement(ChatInput, { threadId: 'thread-1', onSend }));
    });

    act(() => {
      typeInto(getTextarea(), './src/');
    });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    // Path menu visible (dropdown), not ghost text
    expect(container.querySelector('[data-testid="path-completion-menu"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="ghost-suggestion"]')).toBeNull();
  });
});
