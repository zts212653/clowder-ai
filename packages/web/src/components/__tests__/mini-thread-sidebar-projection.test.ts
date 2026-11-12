// @vitest-environment jsdom
/**
 * PR-3a (contract 3.7/3.8): the split-pane mini sidebar reads the F297 canonical snapshot for its
 * status dot and unread badge. Local thread state is fed by thread rooms, which background threads
 * will stop joining; the snapshot is refreshed by user-room events instead.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MiniThreadSidebar } from '@/components/MiniThreadSidebar';
import { type SidebarSnapshotRow, useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
});

vi.mock('@/stores/chatStore', () => ({
  useChatStore: () => ({
    threads: [
      { id: 't1', title: 'Thread 1', participants: ['opus'] },
      { id: 't2', title: 'Thread 2', participants: ['codex'] },
    ],
    splitPaneThreadIds: ['t1'],
  }),
}));

vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: ({ catId }: { catId: string }) => React.createElement('span', null, catId),
}));

function row(id: string, overrides: Partial<SidebarSnapshotRow>): SidebarSnapshotRow {
  return {
    id,
    title: id,
    participants: [],
    pinned: false,
    favorited: false,
    labels: [],
    preferredCats: [],
    projectPath: '/p',
    lastActiveAt: 1,
    systemKind: null,
    isHubThread: false,
    unreadCount: 0,
    hasUserMention: false,
    presence: { status: 'idle' },
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useSidebarProjectionStore.setState({ rows: [] });
});

describe('MiniThreadSidebar reads the canonical Sidebar snapshot', () => {
  it('shows the snapshot unread badge and status dot for a background thread', () => {
    useSidebarProjectionStore.setState({
      rows: [row('t2', { unreadCount: 12, hasUserMention: true, presence: { status: 'error' } })],
    });
    act(() => root.render(React.createElement(MiniThreadSidebar, { onAssignToPane: vi.fn() })));

    const background = container.querySelector('button[title="Thread 2"]');
    expect(background?.textContent).toContain('9+');
    expect(background?.querySelector('.bg-conn-red-text')).not.toBeNull();
    expect(background?.querySelector('.bg-\\[var\\(--semantic-critical\\)\\]')).not.toBeNull();
  });

  it('shows no badge or dot until the snapshot has the thread', () => {
    act(() => root.render(React.createElement(MiniThreadSidebar, { onAssignToPane: vi.fn() })));

    const background = container.querySelector('button[title="Thread 2"]');
    expect(background?.textContent).toBe('codexThread 2');
    expect(background?.querySelector('.rounded-full')).toBeNull();
  });

  it('follows a snapshot refresh', () => {
    act(() => root.render(React.createElement(MiniThreadSidebar, { onAssignToPane: vi.fn() })));
    act(() => {
      useSidebarProjectionStore.setState({ rows: [row('t2', { unreadCount: 1, presence: { status: 'working' } })] });
    });

    const background = container.querySelector('button[title="Thread 2"]');
    expect(background?.textContent).toContain('1');
    expect(background?.querySelector('.animate-pulse')).not.toBeNull();
  });
});
