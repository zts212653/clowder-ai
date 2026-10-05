import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const data = vi.hoisted(() => ({ push: vi.fn(), pinned: [] as string[], pathname: '/thread/current' }));
const openTeamSubject = vi.hoisted(() => vi.fn());
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (
    select: (state: { setWorkspaceMode: () => void; openTeamSubject: typeof openTeamSubject }) => unknown,
  ) => select({ setWorkspaceMode: vi.fn(), openTeamSubject }),
}));
vi.mock('next/navigation', () => ({ usePathname: () => data.pathname, useRouter: () => ({ push: data.push }) }));
vi.mock('@/hooks/useApprovalHub', () => ({ useApprovalHubSync: vi.fn() }));
vi.mock('@/hooks/useCoCreatorConfig', () => ({ useCoCreatorConfig: () => ({ name: 'You', avatar: null }) }));
vi.mock('@/hooks/usePinnedSections', () => ({ usePinnedSections: () => ({ pinned: data.pinned }) }));
vi.mock('@/components/ActivityBar', () => ({ ClapperboardIcon: () => null }));
vi.mock('../use-presentation-rail', () => ({ usePresentationRail: () => ({ visible: false }) }));
vi.mock('../use-unified-attention', () => {
  // A proven complete empty read: both sources available and complete, consistency verified, totalCount 0.
  const source = { status: 'available', startedAt: 1, observedAt: 2, exhaustiveness: 'complete' };
  const view = {
    result: {
      kind: 'ok',
      read: {
        version: 1,
        status: 'available',
        scope: 'owner_all_projects',
        identity: { ownerUserId: 'owner-1' },
        observedAt: 3,
        sources: { approvals: source, needsMe: source },
        readWindow: { startedAt: 1, endedAt: 3, consistency: 'independent_source_reads' },
        consistency: { state: 'verified', reasons: [] },
        items: [],
        totalCount: 0,
        page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: false },
      },
    },
    staleRead: null,
    refetch: () => undefined,
    readsStarted: () => 1,
    resultGeneration: 1,
  };
  return { useUnifiedAttention: () => view };
});
vi.mock('@/components/concierge/ConciergeRailToggle', () => ({
  useConciergeRailToggle: () => ({ visible: false, isOpen: false, label: '', onClick: vi.fn() }),
}));

import { WorldRail } from '../WorldRail';

describe('F322 rail: pins above the mailbox', () => {
  let host: HTMLDivElement;
  let root: Root;
  const render = () => act(() => root.render(<WorldRail />));
  const all = () => [...host.querySelectorAll<HTMLElement>('[data-testid^="rail-pin-"]')];
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    data.pinned = [];
    data.pathname = '/thread/current';
    window.history.replaceState(null, '', '/thread/current');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('a new user has no pins and no empty separator line', () => {
    render();
    expect(all()).toHaveLength(0);
    // the rail's only hairlines are the ones between world and world area when nothing is pinned
    expect(host.querySelectorAll('[aria-hidden="true"].h-px')).toHaveLength(1);
  });

  it('old bare-section pins and new dest: pins both show, named, with unknown ones silently hidden', () => {
    data.pinned = ['notify', 'dest:signals', 'dest:gone', 'retired-section'];
    render();
    expect(all().map((pin) => pin.getAttribute('aria-label'))).toEqual(['通知', '信号']);
    expect(host.querySelectorAll('[aria-hidden="true"].h-px')).toHaveLength(2);
    for (const pin of all()) expect(pin.getAttribute('title')).toBeNull();
  });

  it('pins are placed above the mailbox, separated from it by a hairline', () => {
    data.pinned = ['dest:starry'];
    render();
    const order = [
      ...host.querySelectorAll<HTMLElement>(
        '[data-testid^="rail-pin-"], [aria-hidden="true"].h-px, [data-testid="mailbox-button"]',
      ),
    ].map((el) => el.getAttribute('data-testid') ?? 'hairline');
    // world hairline first, then: pin → hairline → mailbox
    expect(order.slice(-3)).toEqual(['rail-pin-dest-starry', 'hairline', 'mailbox-button']);
  });

  it('the Workspace team pin opens the team panel in the last conversation, not a settings section', async () => {
    data.pinned = ['dest:team-workspace'];
    data.pathname = '/settings';
    window.history.replaceState(null, '', '/settings?from=current');
    render();
    act(() => all()[0]?.click());
    expect(openTeamSubject).toHaveBeenCalledWith(null);
    expect(data.push).toHaveBeenCalledWith('/thread/current');
  });

  it('an old section pin opens that section standalone with the referrer, exactly as before', () => {
    data.pinned = ['notify'];
    render();
    act(() => all()[0]?.click());
    expect(data.push).toHaveBeenCalledWith('/settings?s=notify&standalone=1&from=current');
  });

  it('a dest: pin opens the route that owns it', () => {
    data.pinned = ['dest:signals'];
    render();
    act(() => all()[0]?.click());
    expect(data.push).toHaveBeenCalledWith('/signals?from=current');
  });
});
