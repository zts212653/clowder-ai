import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useLabelStore } from '@/stores/label-store';
import { writeShellLanguage } from '../../shell/shell-language';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { SIDEBAR_TAB_STORAGE_KEY } from '../sidebar-tab-state';
import { sidebarStatusTextColor } from '../ThreadRowSignals';
import {
  createThreadSidebarHarness,
  defaultSidebarApiMock,
  installThreadSidebarGlobals,
  jsonOk,
  mockApiFetch,
  mockStore,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
  type ThreadSidebarHarness,
} from './thread-sidebar-test-helpers';

describe('collapsed production Group attention shortcuts', () => {
  let harness: ThreadSidebarHarness;
  let pending = true;
  let decisionVersion = 1;
  let ignoredDecisionVersion: number | undefined;
  let personalRevision = 8;
  let decisionsUnavailable = false;
  let open: boolean | undefined = false;
  let preference: Record<string, boolean>;
  function setup(count: number) {
    const threads = Array.from({ length: 8 }, (_, i) => ({
      id: `member-${i}`,
      title: `Member ${i}`,
      projectPath: 'default',
      participants: [],
      lastActiveAt: 100 - i,
      pinned: true,
      unreadCount: i < count ? i + 1 : 0,
      hasUserMention: i === 1 && count > 1,
      presence: { status: 'idle' },
    }));
    mockStore.threads = threads;
    mockStore.currentThreadId = 'outside';
    const group = { id: 'g', name: 'Our group', threadIds: threads.map((t) => t.id) };
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/session') return jsonOk({ userId: 'owner' });
      if (path === '/api/config/thread-attention') {
        if (init?.method === 'PUT') {
          const input = JSON.parse(String(init.body));
          if (input.collapsedPeek !== undefined) preference[input.anchor] = input.collapsedPeek;
          if (input.open !== undefined) open = input.open;
        }
        return jsonOk({
          aliases: {},
          open: open === undefined ? {} : { 'group:g': open },
          collapsedPeek: preference,
          groups: [group],
        });
      }
      if (path.startsWith('/api/concierge/work/decisions') && decisionsUnavailable)
        return Promise.resolve(new Response('{}', { status: 503 }));
      if (path.startsWith('/api/concierge/work/decisions'))
        return jsonOk({
          version: 1,
          status: 'available',
          scope: 'owner_all_projects',
          identity: { ownerUserId: 'owner' },
          observedAt: 3,
          sources: {
            approvals: { status: 'available', exhaustiveness: 'complete' },
            needsMe: { status: 'available', exhaustiveness: 'complete' },
            personalPreferences: { status: 'available', exhaustiveness: 'complete' },
          },
          personalView: { mode: 'visible', preferenceRevision: personalRevision },
          readWindow: { startedAt: 1, endedAt: 3, consistency: 'independent_source_reads' },
          consistency: { state: 'verified', reasons: [] },
          items:
            pending &&
            count > 1 &&
            !(path.includes('personalView=visible') && ignoredDecisionVersion === decisionVersion)
              ? [
                  {
                    decisionRef: 'approval:F193:p',
                    kind: 'approval',
                    summary: 'Decide',
                    linkedNeedsMe: [],
                    preferenceCoordinate: {
                      kind: 'mailbox',
                      decisionRef: 'approval:F193:p',
                      version: `sha256:${String(decisionVersion).repeat(64)}`,
                    },
                    approval: {
                      proposalId: 'p',
                      resolution: 'open',
                      navigation: { state: 'anchored', approvalCardRef: { threadId: 'member-2', messageId: 'm' } },
                    },
                  },
                ]
              : [],
          page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: false },
        });
      return defaultSidebarApiMock(path);
    });
  }
  beforeEach(() => {
    installThreadSidebarGlobals();
    resetThreadSidebarMocks();
    writeShellPresentation('v2');
    writeShellLanguage('zh');
    window.localStorage.setItem(SIDEBAR_TAB_STORAGE_KEY, 'pinned');
    useLabelStore.setState({ labels: [], isLoading: false });
    pending = true;
    decisionVersion = 1;
    ignoredDecisionVersion = undefined;
    personalRevision = 8;
    decisionsUnavailable = false;
    open = false;
    preference = {};
    harness = createThreadSidebarHarness();
  });
  afterEach(() => {
    harness.cleanup();
    writeShellPresentation('classic');
    resetThreadSidebarGlobals();
  });
  const ids = () =>
    [...harness.container.querySelectorAll<HTMLElement>('[data-peek-reason]')].map((e) => [
      e.dataset.threadId,
      e.dataset.peekReason,
    ]);
  const header = () => harness.container.querySelector('[data-testid="group-header-v2"]');
  it('refreshes both row and collapsed decision signals on ignore, restore and a newer version', async () => {
    setup(5);
    const threads = mockStore.threads as { unreadCount: number; hasUserMention: boolean }[];
    for (const thread of threads) {
      thread.unreadCount = 0;
      thread.hasUserMention = false;
    }
    threads[0].unreadCount = 1;
    const refresh = async (event: string) =>
      act(async () => {
        window.dispatchEvent(new Event(event));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    await harness.render();
    expect(ids()).toEqual([
      ['member-2', 'decision'],
      ['member-0', 'unread'],
    ]);
    await act(async () => header()?.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
    expect(harness.container.querySelector('[data-testid="thread-row-pending-decision"]')).not.toBeNull();
    ignoredDecisionVersion = 1;
    personalRevision++;
    await refresh('cat-cafe:ignored-item-preferences-updated');
    expect(harness.container.querySelector('[data-testid="thread-row-pending-decision"]')).toBeNull();
    expect(harness.container.querySelector('[data-testid="thread-row-unread"]')?.textContent).toBe('1 未读');
    await act(async () => header()?.querySelector<HTMLButtonElement>('button[aria-controls]')?.click());
    expect(ids()).toEqual([['member-0', 'unread']]);
    ignoredDecisionVersion = undefined;
    personalRevision++;
    await refresh('cat-cafe:ignored-item-preferences-updated');
    expect(ids()[0]).toEqual(['member-2', 'decision']);
    ignoredDecisionVersion = 1;
    personalRevision++;
    await refresh('cat-cafe:ignored-item-preferences-updated');
    expect(ids()).toEqual([['member-0', 'unread']]);
    decisionVersion = 2;
    await refresh('cat-cafe:runtime-interaction-updated');
    expect(ids()[0]).toEqual(['member-2', 'decision']);
  });
  it('caps five at three, sorts the actual decision first and expands only through the explicit remainder', async () => {
    setup(5);
    await harness.render();
    expect(ids()).toEqual([
      ['member-2', 'decision'],
      ['member-1', 'mention'],
      ['member-0', 'unread'],
    ]);
    expect(header()?.textContent).toContain('5 条要看');
    expect(harness.container.querySelector('[data-testid="group-peek-more"]')?.textContent).toBe('还有 2 条 · 展开');
    await act(async () =>
      harness.container.querySelector<HTMLButtonElement>('[data-testid="group-peek-more"]')?.click(),
    );
    expect(header()?.getAttribute('data-expanded')).toBe('true');
    expect(ids()).toHaveLength(0);
  });
  it.each([
    'zh',
    'en',
  ] as const)('shares conversation attention badges and decision status meaning in %s', async (language) => {
    writeShellLanguage(language);
    setup(5);
    await harness.render();
    const decision = harness.container.querySelector<HTMLElement>(
      '[data-peek-reason="decision"] [data-testid="group-peek-label"]',
    );
    expect(decision?.textContent).toBe(language === 'zh' ? '等你决定' : 'To decide');
    expect(decision?.style.background).toBe('');
    expect(decision?.style.color).toBe(sidebarStatusTextColor('warning'));
    expect(decision?.querySelector<HTMLElement>('[data-testid="group-peek-decision-dot"]')?.style.background).toBe(
      'var(--semantic-warning)',
    );
    const mention = harness.container.querySelector<HTMLElement>('[data-testid="group-peek-mention"]');
    const unread = harness.container.querySelector<HTMLElement>('[data-testid="group-peek-unread"]');
    expect(mention?.textContent).toBe(language === 'zh' ? '@你' : '@you');
    expect(unread?.textContent).toBe(language === 'zh' ? '1 未读' : '1 unread');
    const mentionStyle = mention?.getAttribute('style');
    const unreadStyle = unread?.getAttribute('style');
    await act(async () =>
      harness.container.querySelector<HTMLButtonElement>('[data-testid="group-peek-more"]')?.click(),
    );
    expect(harness.container.querySelector('[data-testid="thread-row-mention"]')?.getAttribute('style')).toBe(
      mentionStyle,
    );
    expect(harness.container.querySelector('[data-testid="thread-row-unread"]')?.getAttribute('style')).toBe(
      unreadStyle,
    );
  });
  it('viewing a pending decision does not settle it; owner invalidation after handling removes its priority', async () => {
    setup(5);
    await harness.render();
    await act(async () => harness.container.querySelector<HTMLButtonElement>('[data-peek-reason="decision"]')?.click());
    expect(ids()[0]).toEqual(['member-2', 'decision']);
    expect(header()?.getAttribute('data-expanded')).toBe('false');
    pending = false;
    await act(async () => {
      window.dispatchEvent(new Event('cat-cafe:proposal-updated'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(ids().some(([id]) => id === 'member-2')).toBe(false);
  });
  it('keeps a new Group collapsed through shortcut navigation and reload without an existing open preference', async () => {
    setup(5);
    open = undefined;
    await harness.render();
    expect(header()?.getAttribute('data-expanded')).toBe('false');
    await act(async () => harness.container.querySelector<HTMLButtonElement>('[data-peek-reason="decision"]')?.click());
    mockStore.currentThreadId = 'member-2';
    await harness.render();
    expect(header()?.getAttribute('data-expanded')).toBe('false');
    expect(open).toBe(false);
    expect(ids()).toHaveLength(3);
    harness.cleanup();
    harness = createThreadSidebarHarness();
    await harness.render();
    expect(header()?.getAttribute('data-expanded')).toBe('false');
    expect(ids()[0]).toEqual(['member-2', 'decision']);
  });
  it('persists completely hidden shortcuts while retaining the count and recovers the switch on remount', async () => {
    setup(5);
    await harness.render();
    await act(async () => header()?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.click());
    await act(async () => harness.container.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')?.click());
    expect(preference).toEqual({ 'group:g': false });
    expect(ids()).toHaveLength(0);
    expect(header()?.textContent).toContain('5 条要看');
    harness.cleanup();
    harness = createThreadSidebarHarness();
    await harness.render();
    expect(ids()).toHaveLength(0);
    await act(async () => header()?.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')?.click());
    expect(harness.container.querySelector('[role="menuitemcheckbox"]')?.getAttribute('aria-checked')).toBe('false');
  });
  it('has only the header for zero attention and never adds the new rows to Classic', async () => {
    setup(0);
    await harness.render();
    expect(ids()).toHaveLength(0);
    expect(header()?.querySelector('[data-testid="group-count"]')).toBeNull();
    expect(harness.container.querySelector('[data-testid="group-status-line"]')).toBeNull();
    act(() => writeShellPresentation('classic'));
    expect(ids()).toHaveLength(0);
    expect(header()).toBeNull();
  });
  it('keeps an unknown decision read visible instead of hiding it as confirmed zero', async () => {
    setup(0);
    decisionsUnavailable = true;
    await harness.render();
    expect(header()?.querySelector('[data-testid="group-count"]')?.textContent).toBe('…');
    expect(header()?.querySelector('[data-testid="group-count"]')?.getAttribute('aria-label')).toBe('待办尚未确认');
  });
});
