import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const data = vi.hoisted(() => ({
  push: vi.fn(),
  configLoaded: true,
  configFailed: false,
  enabled: true,
  muted: false,
  surfaceState: 'collapsed',
  setSurfaceState: vi.fn(),
  setMuted: vi.fn(),
  pinned: [] as string[],
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/thread/current', useRouter: () => ({ push: data.push }) }));
vi.mock('@/hooks/useApprovalHub', () => ({ useApprovalHubSync: vi.fn() }));
vi.mock('@/hooks/useCoCreatorConfig', () => ({ useCoCreatorConfig: () => ({ name: 'You', avatar: null }) }));
vi.mock('@/hooks/usePinnedSections', () => ({ usePinnedSections: () => ({ pinned: data.pinned }) }));
vi.mock('@/stores/conciergeStore', () => ({ useConciergeStore: (s: (v: typeof data) => unknown) => s(data) }));
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

import { WorldRail } from '../WorldRail';

describe('F322 rail names and original concierge gate', () => {
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
      muted: false,
      surfaceState: 'collapsed',
      pinned: [],
    });
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
      ['concierge-rail-toggle', '打开猫猫球'],
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
  it.each([
    [false, false, true],
    [true, false, false],
  ] as const)('hides concierge for loaded=%s failed=%s enabled=%s', (loaded, failed, enabled) => {
    Object.assign(data, { configLoaded: loaded, configFailed: failed, enabled });
    render();
    expect(host.querySelector('[data-testid="concierge-rail-toggle"]')).toBeNull();
  });
  it('muted recall uses the original action and does not masquerade as open', async () => {
    data.muted = true;
    render();
    expect(control('concierge-rail-toggle').getAttribute('data-selected')).toBeNull();
    await act(async () => control('concierge-rail-toggle').click());
    expect(data.setMuted).toHaveBeenCalledWith(false);
    expect(data.setSurfaceState).toHaveBeenCalledWith('toolbar');
  });
  it('old pins retain their destination above the one mailbox; new users start with no pins', () => {
    render();
    expect(host.querySelector('[data-testid^="rail-pin-"]')).toBeNull();
    data.pinned = ['accounts'];
    render();
    const pin = control('rail-pin-accounts');
    expect(pin.compareDocumentPosition(control('mailbox-button')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => pin.click());
    expect(data.push).toHaveBeenCalledWith('/settings?s=accounts&standalone=1&from=current');
    expect(host.querySelectorAll('[data-testid="mailbox-button"]')).toHaveLength(1);
    expect(pin.getAttribute('title')).toBeNull();
  });
});
