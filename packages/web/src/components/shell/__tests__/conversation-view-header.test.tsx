import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, QueueEntry } from '@/stores/chat-types';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';

const state = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  participants: ['opus55', 'codex-sol'] as string[],
  executions: {} as Record<string, { threadId: string; catId: string }>,
  messages: [] as ChatMessage[],
  queue: [] as QueueEntry[],
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/utils/api-client', () => ({ apiFetch: state.apiFetch }));
vi.mock('@/stores/activeExecutionStore', () => ({
  useActiveExecutionStore: (
    select: (value: { executionsByKey: Record<string, { threadId: string; catId: string }> }) => unknown,
  ) => select({ executionsByKey: state.executions }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (id: string) => {
      if (id === 'private-runtime-id-unknown') return undefined;
      return {
        displayName: id === 'opus55' ? '布偶猫 Opus' : id.startsWith('cat-') ? `伙伴${id.slice(4)}` : '小太阳·砚砚',
        color: { primary: '#777777' },
      };
    },
  }),
}));
vi.mock('../../ThreadIndicator', () => ({ ThreadIndicator: () => null, tailTruncate: (value: string) => value }));
vi.mock('../../ThreadCatPill', () => ({ ThreadCatPill: () => null }));
vi.mock('../../execution-row/ThreadTitleResetMenu', () => ({ ThreadTitleResetMenu: () => null }));
vi.mock('../HeaderCounts', () => ({ ThreadTasksButton: () => null, ThreadWorksButton: () => null }));

import { ChatContainerHeader } from '../../ChatContainerHeader';
import { writeShellLanguage } from '../shell-language';
import { writeShellPresentation } from '../shell-presentation';

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
describe('F322 conversation view control in the real v2 header', () => {
  let host: HTMLDivElement;
  let root: Root;
  async function render() {
    useSidebarProjectionStore.setState({
      rows: [
        {
          id: 'thread-view',
          title: 'Conversation view test',
          participants: state.participants,
          pinned: false,
          favorited: false,
          labels: [],
          preferredCats: [],
          projectPath: '/test/project',
          lastActiveAt: 0,
          systemKind: null,
          isHubThread: false,
          unreadCount: 0,
          hasUserMention: false,
          presence: { status: 'idle' },
        },
      ],
      pendingThreadCommands: {},
    });
    await act(async () =>
      root.render(
        <ChatContainerHeader
          sidebarOpen
          onToggleSidebar={() => {}}
          threadId="thread-view"
          viewMode="single"
          onToggleViewMode={() => {}}
          statusPanelOpen={false}
          onToggleStatusPanel={() => {}}
          conversationViewMessages={state.messages}
          conversationViewQueue={state.queue}
        />,
      ),
    );
    await settle();
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    writeShellPresentation('v2');
    state.participants = ['opus55', 'codex-sol'];
    state.executions = {};
    state.messages = [
      {
        id: 'message-to-opus',
        type: 'user',
        content: '请看这里',
        timestamp: 10,
        lifecycle: {
          kind: 'input',
          orderKey: '10:message-to-opus',
          dispatchRefs: [
            {
              targetId: 'opus55',
              phase: 'settled',
              statusMessageId: 'response-opus',
              dispatchedAt: 12,
              inputRead: { status: 'read', at: 15 },
            },
          ],
        },
      },
      {
        id: 'response-opus',
        type: 'assistant',
        catId: 'opus55',
        from: { kind: 'agent', catId: 'opus55' },
        content: '看到了',
        timestamp: 20,
        lifecycle: {
          kind: 'response',
          orderKey: '18:response-opus',
          targetId: 'opus55',
          invocationId: 'inv-opus',
          startedAt: 18,
          status: 'completed',
          inputMessageIds: ['message-to-opus'],
          inputEntryIds: ['entry-opus'],
          completedAt: 20,
        },
      },
    ];
    state.queue = [];
    state.apiFetch.mockReset();
    state.apiFetch.mockImplementation(async (path: string) => {
      if (path.includes('/active-pane')) return Response.json({ active: false });
      if (path.includes('/api/config/conversation-view')) {
        return Response.json({ stored: null, effective: { mode: 'group' }, source: 'product' });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    useSidebarProjectionStore.setState({ rows: [], pendingThreadCommands: {} });
    host.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('replaces the passive avatar strip with an evidence-gated view menu and exact scope copy', async () => {
    state.executions = { active: { threadId: 'thread-view', catId: 'opus55' } };
    await render();
    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="conversation-view-menu-toggle"]');
    expect(toggle?.textContent).toContain('群聊');
    expect(host.querySelector('[data-testid="header-participants"]')).toBeNull();

    await act(async () => toggle?.click());
    const menu = host.querySelector<HTMLElement>('[data-testid="conversation-view-menu"]');
    expect(menu?.getAttribute('role')).toBe('menu');
    expect(menu?.querySelector('[data-conversation-view="group"]')?.getAttribute('aria-checked')).toBe('true');
    const catChoices = [...(menu?.querySelectorAll<HTMLButtonElement>('[data-conversation-cat]') ?? [])];
    expect(catChoices).toHaveLength(2);
    expect(catChoices[0]?.disabled).toBe(false);
    expect(catChoices[1]?.disabled).toBe(true);
    expect(catChoices[0]?.textContent).toContain('发给它的和它说的');
    expect(catChoices[1]?.textContent).toContain('还没有可确认的对话记录');
    expect(menu?.textContent).toContain('正在工作');

    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(host.querySelector('[data-testid="conversation-view-menu"]')).toBeNull();
    expect(document.activeElement).toBe(toggle);

    await act(async () => toggle?.click());
    expect(host.querySelector('[data-testid="conversation-view-menu"]')).not.toBeNull();
    await act(async () => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    expect(host.querySelector('[data-testid="conversation-view-menu"]')).toBeNull();
  });

  it('shows a confirmed cat view after save and restores group without changing the message scope copy', async () => {
    state.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.includes('/active-pane')) return Response.json({ active: false });
      if (init?.method === 'PUT') {
        const requested = JSON.parse(String(init.body)) as { view: { mode: 'group' | 'cat'; catId?: string } };
        return Response.json({ stored: requested.view, effective: requested.view, source: 'thread' });
      }
      return Response.json({ stored: null, effective: { mode: 'group' }, source: 'product' });
    });
    await render();
    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="conversation-view-menu-toggle"]');
    await act(async () => toggle?.click());
    await act(async () => host.querySelector<HTMLButtonElement>('[data-conversation-cat="opus55"]')?.click());
    await settle();

    expect(toggle?.textContent).toContain('布偶猫 Opus');
    expect(
      toggle?.querySelector('[data-conversation-view-current]')?.getAttribute('data-conversation-view-current'),
    ).toBe('cat');

    await act(async () => toggle?.click());
    expect(host.querySelector('[data-conversation-cat="opus55"]')?.getAttribute('aria-checked')).toBe('true');
    await act(async () => host.querySelector<HTMLButtonElement>('[data-conversation-view="group"]')?.click());
    await settle();
    expect(toggle?.textContent).toContain('群聊');
  });

  it('uses the shell language live and keeps classic free of the entry', async () => {
    writeShellLanguage('en');
    await render();
    expect(host.querySelector('[data-testid="conversation-view-menu-toggle"]')?.textContent).toContain('Group chat');

    await act(async () => writeShellPresentation('classic'));
    expect(host.querySelector('[data-testid="conversation-view-menu-toggle"]')).toBeNull();
  });

  it('keeps every participant discoverable without exposing an unknown runtime id as a name', async () => {
    state.participants = [
      ...Array.from({ length: 12 }, (_, index) => `cat-${index + 1}`),
      'private-runtime-id-unknown',
    ];
    await render();
    await act(async () =>
      host.querySelector<HTMLButtonElement>('[data-testid="conversation-view-menu-toggle"]')?.click(),
    );
    const menu = host.querySelector('[data-testid="conversation-view-menu"]');
    expect(menu?.querySelectorAll('[data-conversation-cat]')).toHaveLength(13);
    expect(menu?.textContent).toContain('伙伴12');
    expect(menu?.textContent).toContain('猫猫');
    expect(menu?.textContent).not.toContain('private-runtime-id-unknown');
  });

  it('keeps group available after preference loading fails and lets a confirmed save recover', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.includes('/active-pane')) return Response.json({ active: false });
      if (init?.method === 'PUT') {
        return Response.json({ stored: { mode: 'group' }, effective: { mode: 'group' }, source: 'thread' });
      }
      throw new Error('offline');
    });
    await render();
    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="conversation-view-menu-toggle"]');
    await act(async () => toggle?.click());
    const menu = host.querySelector('[data-testid="conversation-view-menu"]');
    const group = menu?.querySelector<HTMLButtonElement>('[data-conversation-view="group"]');
    expect(menu?.textContent).toContain('视图暂未恢复，当前显示群聊');
    expect(group?.disabled).toBe(false);

    await act(async () => group?.click());
    await settle();
    expect(host.querySelector('[data-testid="conversation-view-menu"]')).toBeNull();
    expect(errorLog).toHaveBeenCalledWith('Failed to load conversation view preference', expect.any(Error));
  });

  it('does not accept a stored cat view without evidence and only replaces it after a confirmed group save', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.messages = [];
    let putCount = 0;
    state.apiFetch.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.includes('/active-pane')) return Response.json({ active: false });
      if (init?.method === 'PUT') {
        putCount += 1;
        if (putCount === 1) return new Response(JSON.stringify({ error: 'save failed' }), { status: 500 });
        return Response.json({ stored: { mode: 'group' }, effective: { mode: 'group' }, source: 'thread' });
      }
      return Response.json({
        stored: { mode: 'cat', catId: 'opus55' },
        effective: { mode: 'cat', catId: 'opus55' },
        source: 'thread',
      });
    });
    await render();
    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="conversation-view-menu-toggle"]');
    expect(toggle?.textContent).toContain('群聊');

    await act(async () => toggle?.click());
    const group = host.querySelector<HTMLButtonElement>('[data-conversation-view="group"]');
    await act(async () => group?.click());
    await settle();
    expect(host.querySelector('[data-testid="conversation-view-menu"]')?.textContent).toContain('保存失败，请重试');

    await act(async () => group?.click());
    await settle();
    expect(host.querySelector('[data-testid="conversation-view-menu"]')).toBeNull();
    expect(putCount).toBe(2);
    expect(errorLog).toHaveBeenCalledWith('Failed to save conversation view preference', expect.any(Error));
  });
});
