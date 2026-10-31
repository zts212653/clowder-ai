import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { ThreadCatPill } from '@/components/ThreadCatPill';
import { useChatStore } from '@/stores/chatStore';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';

const api = vi.hoisted(() => vi.fn(async () => new Response('{}', { status: 200 })));
vi.mock('@/utils/api-client', () => ({ apiFetch: api }));
vi.mock('@/utils/sidebar-thread-snapshot', () => ({ invalidateSidebarProjection: vi.fn() }));
vi.mock('@/components/MemberSessionStrategy', () => ({
  MemberSessionStrategy: ({ catId }: { catId: string }) => <span data-strategy-cat={catId} />,
}));

const cats = [
  {
    id: 'old-cat',
    displayName: 'Old cat',
    breedDisplayName: 'Maine',
    clientId: 'openai',
    color: { primary: '#777777', secondary: '#eeeeee' },
  },
  {
    id: 'new-cat',
    displayName: 'New cat',
    breedDisplayName: 'Maine',
    clientId: 'openai',
    color: { primary: '#888888', secondary: '#eeeeee' },
  },
];
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (id: string) => cats.find((cat) => cat.id === id),
    getCatsByBreed: () => new Map([['maine', cats]]),
  }),
  formatCatName: (cat: { displayName: string }) => cat.displayName,
}));

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { React?: typeof React; IS_REACT_ACT_ENVIRONMENT?: boolean }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  writeShellPresentation('v2');
  writeShellLanguage('en');
  useChatStore.setState({
    threads: [
      {
        id: 'thread-a',
        title: 'Thread',
        projectPath: '/project',
        preferredCats: ['old-cat'],
        createdBy: 'owner',
        participants: [],
        lastActiveAt: 1,
        createdAt: 1,
      },
    ],
  });
  useSidebarProjectionStore.setState({
    rows: [
      {
        id: 'thread-a',
        title: 'Thread',
        participants: [],
        pinned: false,
        favorited: false,
        labels: [],
        preferredCats: ['new-cat'],
        projectPath: '/project',
        lastActiveAt: 1,
        systemKind: null,
        isHubThread: false,
        unreadCount: 0,
        hasUserMention: false,
        presence: { status: 'idle' },
      },
    ],
    pendingThreadCommands: {},
  });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe('preferred-cat canonical truth and selection semantics', () => {
  it('uses the sidebar optimistic projection and rolls it back after a rejected command', () => {
    act(() => root.render(<ThreadCatPill threadId="thread-a" presentation="composer" />));
    let commandId = '';
    act(() => {
      commandId = useSidebarProjectionStore.getState().beginSidebarCommand('thread-a', 'preferredCats', ['old-cat']);
    });
    expect(host.querySelector('[data-testid="thread-cat-pill"]')?.textContent).toBe('Old cat');
    act(() => useSidebarProjectionStore.getState().failSidebarCommand(commandId));
    expect(host.querySelector('[data-testid="thread-cat-pill"]')?.textContent).toBe('New cat');
  });
  it('its own save updates the canonical projection before an eventual snapshot refresh', async () => {
    act(() => root.render(<ThreadCatPill threadId="thread-a" presentation="composer" />));
    act(() => (host.querySelector('[data-testid="thread-cat-pill"]') as HTMLButtonElement).click());
    expect(document.querySelector('[data-strategy-cat]')?.getAttribute('data-strategy-cat')).toBe('new-cat');
    const button = (name: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
        (node) => node.textContent === name,
      )!;
    act(() => button('Old cat').click());
    await act(async () => button('Save').click());
    expect(host.querySelector('[data-testid="thread-cat-pill"]')?.textContent).toBe('Old cat');
    expect(api).toHaveBeenCalledWith(
      '/api/threads/thread-a',
      expect.objectContaining({ body: JSON.stringify({ preferredCats: ['old-cat'] }) }),
    );
    expect(Object.values(useSidebarProjectionStore.getState().pendingThreadCommands).at(-1)?.value).toEqual([
      'old-cat',
    ]);
  });
  it('uses the canonical sidebar projection when the legacy thread cache is stale', () => {
    act(() => root.render(<ThreadCatPill threadId="thread-a" presentation="composer" />));
    expect(host.querySelector('[data-testid="thread-cat-pill"]')?.textContent).toContain('New cat');
    expect(host.textContent).not.toContain('Old cat');
  });

  it('announces the currently selected preferred cat', () => {
    useSidebarProjectionStore.setState({
      rows: useSidebarProjectionStore
        .getState()
        .rows.map((row) => (row.id === 'thread-a' ? { ...row, preferredCats: ['old-cat'] } : row)),
    });
    act(() => root.render(<ThreadCatPill threadId="thread-a" presentation="composer" />));
    act(() => (host.querySelector('[data-testid="thread-cat-pill"]') as HTMLButtonElement).click());
    const selected = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (button) => button.textContent === 'Old cat',
    );
    expect(selected?.getAttribute('aria-pressed')).toBe('true');
  });
});
