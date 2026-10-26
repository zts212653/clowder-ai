import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const data = vi.hoisted(() => ({
  push: vi.fn(),
  configLoaded: true,
  configFailed: false,
  enabled: true,
  invocationStatus: 'idle' as 'idle' | 'error',
  surfaceState: 'collapsed',
  inputFocused: false,
  fetchThreadId: vi.fn(async () => 'thread-concierge' as string | null),
  pinned: [] as string[],
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/thread/current', useRouter: () => ({ push: data.push }) }));
vi.mock('@/hooks/useApprovalHub', () => ({ useApprovalHubSync: vi.fn() }));
vi.mock('@/hooks/useCoCreatorConfig', () => ({ useCoCreatorConfig: () => ({ name: 'You', avatar: null }) }));
vi.mock('@/hooks/usePinnedSections', () => ({ usePinnedSections: () => ({ pinned: data.pinned }) }));
vi.mock('@/stores/conciergeStore', () => {
  const useConciergeStore = Object.assign((selector: (state: typeof data) => unknown) => selector(data), {
    getState: () => data,
    setState: (next: Partial<typeof data>) => Object.assign(data, next),
  });
  return { useConciergeStore };
});
vi.mock('@/stores/conciergeDesktopStore', () => ({
  useConciergeDesktopStore: (s: (v: { available: boolean }) => unknown) => s({ available: false }),
  showConciergeDesktop: vi.fn(),
}));
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
        sources: {
          approvals: source,
          needsMe: source,
          structuredChoices: { ...source, coverage: 'pending_f306_structured_choices' },
        },
        readWindow: { startedAt: 1, endedAt: 3, consistency: 'independent_source_reads' },
        consistency: { state: 'verified', reasons: [] },
        items: [],
        totalCount: 0,
        attentionCount: 0,
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

import { WorldRail } from '../WorldRail';

describe('F322 rail names and canonical companion entry', () => {
  let host: HTMLDivElement;
  let root: Root;
  function render() {
    act(() => root.render(<WorldRail />));
  }
  function control(id: string) {
    const found = host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
    if (!found) throw new Error(`Rail control ${id} is missing`);
    return found;
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    Object.assign(data, {
      configLoaded: true,
      configFailed: false,
      enabled: true,
      invocationStatus: 'idle',
      surfaceState: 'collapsed',
      inputFocused: false,
      pinned: [],
    });
    window.history.replaceState({}, '', '/thread/current');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('world, mailbox, concierge, avatar have accessible names without native titles', () => {
    render();
    for (const [id, name] of [
      ['world-cafe', '我的 Café'],
      ['world-collective', '共同体'],
      ['mailbox-button', '待办，暂无'],
      ['concierge-rail-toggle', '打开伴随对话'],
      ['settings-button', '设置与管理'],
    ]) {
      expect(control(id).getAttribute('aria-label')).toBe(name);
      expect(control(id).getAttribute('title')).toBeNull();
    }
    expect(host.querySelector('[title]')).toBeNull();
    expect(control('world-cafe').getAttribute('aria-current')).toBe('page');
    act(() => control('settings-button').click());
    expect(data.push).toHaveBeenCalledWith('/settings?from=current');
  });
  it('hides the companion entry only while config availability is unknown', () => {
    Object.assign(data, { configLoaded: false, configFailed: false, enabled: true });
    render();
    expect(host.querySelector('[data-testid="concierge-rail-toggle"]')).toBeNull();

    Object.assign(data, { configLoaded: true, configFailed: false, enabled: false });
    render();
    expect(host.querySelector('[data-testid="concierge-rail-toggle"]')).not.toBeNull();

    Object.assign(data, { configLoaded: false, configFailed: true });
    render();
    expect(host.querySelector('[data-testid="concierge-rail-toggle"]')).not.toBeNull();
  });
  it('opens the canonical companion conversation and never masquerades as selected', async () => {
    render();
    expect(control('concierge-rail-toggle').getAttribute('data-selected')).toBeNull();
    await act(async () => control('concierge-rail-toggle').click());
    expect(data.fetchThreadId).toHaveBeenCalledWith({ refresh: true });
    expect(window.location.pathname).toBe('/thread/thread-concierge');
    expect(control('concierge-rail-toggle').getAttribute('data-selected')).toBeNull();
  });
  it('old pins retain their destination above the one mailbox; new users start with no pins', () => {
    render();
    expect(host.querySelector('[data-testid^="rail-pin-"]')).toBeNull();
    data.pinned = ['members', 'accounts'];
    render();
    const members = control('rail-pin-members');
    expect(members.querySelector('[data-hub-icon="paw"]')).not.toBeNull();
    expect(members.querySelector('path')?.getAttribute('d')).not.toBe(
      control('world-collective').querySelector('path')?.getAttribute('d'),
    );
    const pin = control('rail-pin-accounts');
    expect(pin.compareDocumentPosition(control('mailbox-button')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => pin.click());
    expect(data.push).toHaveBeenCalledWith('/settings?s=accounts&standalone=1&from=current');
    expect(host.querySelectorAll('[data-testid="mailbox-button"]')).toHaveLength(1);
    expect(pin.getAttribute('title')).toBeNull();
  });
});
