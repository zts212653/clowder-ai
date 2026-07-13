/**
 * ThreadIndicator inline title editing tests.
 * Covers: double-click/F2 entry, Enter/Escape/blur submit/cancel, IME guard.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadIndicator } from '@/components/ThreadIndicator';

const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const hoistedMocks = { mockIMEComposing: false };
vi.mock('@/hooks/useIMEGuard', () => ({
  useIMEGuard: () => ({
    onCompositionStart: vi.fn(),
    onCompositionEnd: vi.fn(),
    isComposing: () => hoistedMocks.mockIMEComposing,
  }),
}));

const TEST_THREADS = [
  {
    id: 'thread_xyz',
    title: '讨论 F095 设计',
    projectPath: '/projects/cat-cafe',
    createdBy: 'user1',
    participants: ['user1'],
    lastActiveAt: Date.now(),
    createdAt: Date.now(),
    pinned: false,
    favorited: false,
    preferredCats: [] as string[],
  },
];

const mockUpdateThreadTitle = vi.fn();
const mockStore: Record<string, unknown> = {
  threads: TEST_THREADS,
  updateThreadTitle: mockUpdateThreadTitle,
};
vi.mock('@/stores/chatStore', () => {
  const hook = Object.assign(
    (selector?: (s: typeof mockStore) => unknown) => (selector ? selector(mockStore) : mockStore),
    { getState: () => mockStore },
  );
  return { useChatStore: hook };
});

const nativeInputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;

describe('ThreadIndicator inline title editing', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = null;
    mockStore.threads = TEST_THREADS;
    mockUpdateThreadTitle.mockReset();
    mockApiFetch.mockReset();
    hoistedMocks.mockIMEComposing = false;

    // Suppress React act() warnings for fire-and-forget submitRename.
    // The production code intentionally uses `void submitRename()` in onKeyDown/onBlur handlers,
    // which detaches the promise from React's act tracking. State updates from the async chain's
    // finally block (setIsSaving/setIsEditing) are inherently "orphaned" from act's perspective.
    const origConsoleError = console.error;
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === 'string' && (args[0] as string).includes('not wrapped in act')) return;
      origConsoleError.call(console, ...args);
    });
  });

  afterEach(() => {
    if (root) {
      act(() => root?.unmount());
      root = null;
    }
    container.remove();
  });

  const render = async () => {
    root = createRoot(container);
    await act(async () => {
      root?.render(React.createElement(ThreadIndicator, { threadId: 'thread_xyz' }));
    });
  };

  const titleSpan = () => container.querySelector('span.cursor-text') as HTMLElement | null;
  const editInput = () => container.querySelector('input') as HTMLInputElement | null;

  const enterEditMode = async () => {
    await act(async () => {
      titleSpan()?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
  };

  const setInputValue = (input: HTMLInputElement, value: string) => {
    nativeInputSetter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  /** Flush fire-and-forget submitRename: macrotask drains the async chain (apiFetch → .json() → state updates) */
  const flushSubmitRename = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it('enters edit mode on double-click', async () => {
    await render();
    expect(editInput()).toBeNull();
    await enterEditMode();
    expect(editInput()).not.toBeNull();
    expect(editInput()?.value).toBe('讨论 F095 设计');
  });

  it('enters edit mode on F2 keypress', async () => {
    await render();
    expect(editInput()).toBeNull();
    await act(async () => {
      titleSpan()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
    });
    expect(editInput()).not.toBeNull();
  });

  it('submits rename on Enter and calls PATCH', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ title: '新标题' }) });
    await render();
    await enterEditMode();
    setInputValue(editInput()!, '新标题');
    // Single act: dispatch + macrotask flush keeps all submitRename state updates inside one act boundary
    await act(async () => {
      editInput()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushSubmitRename();
    });
    expect(mockApiFetch).toHaveBeenCalledWith('/api/threads/thread_xyz', expect.objectContaining({ method: 'PATCH' }));
    expect(mockUpdateThreadTitle).toHaveBeenCalledWith('thread_xyz', '新标题');
  });

  it('submits rename on blur and calls PATCH', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({ title: '模糊保存' }) });
    await render();
    await enterEditMode();
    setInputValue(editInput()!, '模糊保存');
    await act(async () => {
      editInput()?.blur();
      await flushSubmitRename();
    });
    expect(mockApiFetch).toHaveBeenCalledWith('/api/threads/thread_xyz', expect.objectContaining({ method: 'PATCH' }));
    expect(mockApiFetch).toHaveBeenCalledTimes(1);
    expect(mockUpdateThreadTitle).toHaveBeenCalledWith('thread_xyz', '模糊保存');
  });

  it('cancels on Escape without calling PATCH', async () => {
    await render();
    await enterEditMode();
    await act(async () => {
      editInput()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(editInput()).toBeNull();
    expect(titleSpan()?.textContent).toBe('讨论 F095 设计');
  });

  it('cancels when draft is empty without calling PATCH', async () => {
    await render();
    await enterEditMode();
    setInputValue(editInput()!, '  ');
    await act(async () => {
      editInput()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flushSubmitRename();
    });
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('does not submit during IME composition', async () => {
    hoistedMocks.mockIMEComposing = true;
    await render();
    await enterEditMode();
    await act(async () => {
      editInput()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(mockApiFetch).not.toHaveBeenCalled();
    expect(editInput()).not.toBeNull(); // still in edit mode
  });

  it('cancels edit without PATCH when threadId changes (cross-thread rename guard)', async () => {
    // Regression: editing thread A, then switching to thread B must cancel A's draft
    // without sending a PATCH — the useEffect([threadId]) guard sets isEditing = false.
    await render();
    await enterEditMode();
    setInputValue(editInput()!, '改了但没保存');
    expect(editInput()).not.toBeNull(); // still editing

    // Simulate switching to a different thread by re-rendering with a new threadId
    const threadB = {
      id: 'thread_abc',
      title: '另一个对话',
      projectPath: '/projects/other',
      createdBy: 'user1',
      participants: ['user1'],
      lastActiveAt: Date.now(),
      createdAt: Date.now(),
      pinned: false,
      favorited: false,
      preferredCats: [] as string[],
    };
    mockStore.threads = [...TEST_THREADS, threadB];
    await act(async () => {
      root?.render(React.createElement(ThreadIndicator, { threadId: 'thread_abc' }));
    });

    // Edit mode must be cancelled — no input visible, no PATCH sent
    expect(editInput()).toBeNull();
    expect(mockApiFetch).not.toHaveBeenCalled();
    // The displayed title is thread B's, not the draft from thread A
    expect(titleSpan()?.textContent).toBe('另一个对话');
  });

  it('in-flight PATCH for thread A does not close edit on thread B (generation guard)', async () => {
    // Regression: blur triggers submitRename(A) → PATCH in flight → switch to B →
    // user double-clicks to edit B → A's finally must NOT setIsEditing(false) on B.
    let resolvePatch!: (v: { ok: boolean; json: () => Promise<{ title: string }> }) => void;
    mockApiFetch.mockReturnValue(
      new Promise((r) => {
        resolvePatch = r;
      }),
    );

    await render();
    await enterEditMode();
    setInputValue(editInput()!, '新标题A');

    // Trigger blur → submitRename fires, PATCH starts (unresolved)
    await act(async () => {
      editInput()?.blur();
    });
    // PATCH is in flight — isSaving should be true, but we're about to switch threads

    // Switch to thread B
    const threadB = {
      id: 'thread_abc',
      title: '对话B',
      projectPath: '/projects/other',
      createdBy: 'user1',
      participants: ['user1'],
      lastActiveAt: Date.now(),
      createdAt: Date.now(),
      pinned: false,
      favorited: false,
      preferredCats: [] as string[],
    };
    mockStore.threads = [...TEST_THREADS, threadB];
    await act(async () => {
      root?.render(React.createElement(ThreadIndicator, { threadId: 'thread_abc' }));
    });

    // isSaving must be reset by the threadId change (generation bump)
    expect(editInput()).toBeNull(); // not editing yet

    // User double-clicks to edit thread B
    await act(async () => {
      titleSpan()?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(editInput()).not.toBeNull(); // B's edit is open

    // Now resolve thread A's PATCH — its finally block must NOT close B's edit
    await act(async () => {
      resolvePatch({ ok: true, json: () => Promise.resolve({ title: '新标题A' }) });
      await flushSubmitRename();
    });

    // B's edit must still be open
    expect(editInput()).not.toBeNull();
  });
});
