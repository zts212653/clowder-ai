// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ThreadGroup } from '../ThreadSidebar/thread-utils';
import { useCollapseState } from '../ThreadSidebar/use-collapse-state';

type HookResult = ReturnType<typeof useCollapseState>;

// React 18 createRoot + act() needs this flag in bare Vitest/jsdom.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let captured: HookResult | null = null;
let storage: Storage;

function makeGroups(): ThreadGroup[] {
  return [
    {
      type: 'pinned',
      label: '置顶',
      threads: [
        {
          id: 'thread-pinned',
          title: 'Pinned thread',
          participants: [],
          projectPath: 'default',
          createdBy: 'test-user',
          lastActiveAt: Date.now(),
          pinned: true,
          favorited: false,
          createdAt: Date.now(),
        },
      ],
    },
    {
      type: 'project',
      label: 'cat-cafe',
      projectPath: '/proj/cat-cafe',
      threads: [
        {
          id: 'thread-project',
          title: 'Project thread',
          participants: [],
          projectPath: '/proj/cat-cafe',
          createdBy: 'test-user',
          lastActiveAt: Date.now() - 1000,
          pinned: false,
          favorited: false,
          createdAt: Date.now() - 1000,
        },
      ],
    },
  ];
}

function HookHost(props: { threadGroups: ThreadGroup[]; currentThreadId: string | undefined }) {
  captured = useCollapseState({
    threadGroups: props.threadGroups,
    searchQuery: '',
    currentThreadId: props.currentThreadId,
  });
  return null;
}

describe('useCollapseState', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    storage = {
      get length() {
        return store.size;
      },
      clear: () => store.clear(),
      getItem: (key: string) => store.get(key) ?? null,
      key: (index: number) => [...store.keys()][index] ?? null,
      removeItem: (key: string) => store.delete(key),
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: storage,
    });
    storage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    captured = null;
  });

  afterEach(() => {
    if (root) {
      act(() => root.unmount());
    }
    container?.remove();
    captured = null;
    storage.clear();
  });

  it('does not re-expand the same group when only threadGroups change', async () => {
    const firstGroups = makeGroups();

    await act(async () => {
      root.render(React.createElement(HookHost, { threadGroups: firstGroups, currentThreadId: 'thread-pinned' }));
    });

    expect(captured?.isCollapsed('pinned')).toBe(false);

    act(() => {
      captured?.toggleGroup('pinned');
    });

    expect(captured?.isCollapsed('pinned')).toBe(true);

    const updatedGroups = makeGroups();
    updatedGroups[0]!.threads = [
      {
        ...updatedGroups[0]!.threads[0]!,
        lastActiveAt: Date.now() + 5000,
      },
    ];

    await act(async () => {
      root.render(React.createElement(HookHost, { threadGroups: updatedGroups, currentThreadId: 'thread-pinned' }));
    });

    expect(captured?.isCollapsed('pinned')).toBe(true);
  });
});
