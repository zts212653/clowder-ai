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
  pathname: '/thread/current',
  fetchThreadId: vi.fn(async () => 'thread-concierge' as string | null),
  apiFetch: vi.fn(
    async () =>
      new Response(JSON.stringify({ runtimeStatus: 'active', connections: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ),
  pinned: [] as string[],
}));
vi.mock('next/navigation', () => ({ usePathname: () => data.pathname, useRouter: () => ({ push: data.push }) }));
vi.mock('@/utils/api-client', () => ({ apiFetch: data.apiFetch }));
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

import {
  beginWorldDirectoryObservation,
  publishWorldDirectoryObservation,
  resetWorldDirectoryStoreForTests,
} from '../../collective/collective-world-directory-store';
import { WorldRail } from '../WorldRail';

function seedWorlds({
  serviceUrl = 'http://localhost:5201',
  serviceInstanceId = 'svc_aaaaaaaa',
  bridgeId = 'bridge_aaaaaaaa',
  currentCollectiveId,
  memberships,
}: {
  serviceUrl?: string;
  serviceInstanceId?: string;
  bridgeId?: string;
  currentCollectiveId?: string;
  memberships: readonly { collectiveId: string; name: string }[];
}) {
  beginWorldDirectoryObservation({ serviceUrl, bridgeId, expectedServiceInstanceId: serviceInstanceId });
  publishWorldDirectoryObservation({
    serviceUrl,
    bridgeId,
    directory: {
      type: 'collective:client-world-directory',
      bridgeId,
      revision: 1,
      state: 'ready',
      serviceInstanceId,
      humanId: 'human_aaaaaaaa',
      ...(currentCollectiveId ? { currentCollectiveId } : {}),
      memberships: memberships.map((membership) => ({ ...membership, role: 'member' as const })),
    },
  });
}

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
      pathname: '/thread/current',
      pinned: [],
    });
    window.history.replaceState({}, '', '/thread/current');
    window.sessionStorage.clear();
    resetWorldDirectoryStoreForTests();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    resetWorldDirectoryStoreForTests();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('world, mailbox, concierge, avatar have accessible names without native titles', () => {
    render();
    for (const [id, name] of [
      ['world-cafe', '我的 Café'],
      ['world-add', '加入或新建共同体'],
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
    expect(data.push).toHaveBeenCalledWith('/settings?s=you&from=current');
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
      control('world-add').querySelector('path')?.getAttribute('d'),
    );
    const pin = control('rail-pin-accounts');
    expect(pin.compareDocumentPosition(control('mailbox-button')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    act(() => pin.click());
    expect(data.push).toHaveBeenCalledWith('/settings?s=accounts&standalone=1&from=current');
    expect(host.querySelectorAll('[data-testid="mailbox-button"]')).toHaveLength(1);
    expect(pin.getAttribute('title')).toBeNull();
  });

  it('renders verified memberships as distinct worlds and opens an exact target without a connection picker fallback', () => {
    seedWorlds({
      currentCollectiveId: 'col_aaaaaaaa',
      memberships: [
        { collectiveId: 'col_aaaaaaaa', name: '猫咖共创组' },
        { collectiveId: 'col_bbbbbbbb', name: '同名世界' },
      ],
    });
    seedWorlds({
      serviceUrl: 'https://collective.example',
      serviceInstanceId: 'svc_bbbbbbbb',
      bridgeId: 'bridge_bbbbbbbb',
      memberships: [{ collectiveId: 'col_cccccccc', name: '同名世界' }],
    });
    render();

    expect(control('world-svc_aaaaaaaa-col_aaaaaaaa').getAttribute('aria-label')).toBe('猫咖共创组');
    expect(control('world-svc_aaaaaaaa-col_bbbbbbbb').getAttribute('aria-label')).toBe('同名世界');
    expect(control('world-svc_bbbbbbbb-col_cccccccc').getAttribute('aria-label')).toBe('同名世界');
    expect(host.querySelector('[data-testid="world-collective"]')).toBeNull();

    act(() => control('world-svc_bbbbbbbb-col_cccccccc').click());
    expect(data.push).toHaveBeenLastCalledWith(
      '/collective?serviceUrl=https%3A%2F%2Fcollective.example&serviceInstanceId=svc_bbbbbbbb&collectiveId=col_cccccccc',
    );
  });

  it('returns from an exact world URL to the Cafe thread that opened the world', () => {
    seedWorlds({
      memberships: [{ collectiveId: 'col_aaaaaaaa', name: '猫咖共创组' }],
    });
    render();

    act(() => control('world-svc_aaaaaaaa-col_aaaaaaaa').click());
    expect(data.push).toHaveBeenLastCalledWith(
      '/collective?serviceUrl=http%3A%2F%2Flocalhost%3A5201&serviceInstanceId=svc_aaaaaaaa&collectiveId=col_aaaaaaaa',
    );

    data.pathname = '/collective';
    window.history.replaceState(
      {},
      '',
      '/collective?serviceUrl=http%3A%2F%2Flocalhost%3A5201&serviceInstanceId=svc_aaaaaaaa&collectiveId=col_aaaaaaaa',
    );
    render();
    act(() => control('world-cafe').click());

    expect(data.push).toHaveBeenLastCalledWith('/thread/current');
  });

  it('lets the explicit Collective URL own selection while its directory is checking or unavailable', () => {
    seedWorlds({
      currentCollectiveId: 'col_aaaaaaaa',
      memberships: [
        { collectiveId: 'col_aaaaaaaa', name: '一号共同体' },
        { collectiveId: 'col_bbbbbbbb', name: '二号共同体' },
      ],
    });
    data.pathname = '/collective';
    window.history.replaceState(
      {},
      '',
      '/collective?serviceUrl=http%3A%2F%2Flocalhost%3A5201&serviceInstanceId=svc_aaaaaaaa&collectiveId=col_bbbbbbbb',
    );
    beginWorldDirectoryObservation({
      serviceUrl: 'http://localhost:5201',
      bridgeId: 'bridge_bbbbbbbb',
      expectedServiceInstanceId: 'svc_aaaaaaaa',
    });
    render();

    expect(control('world-svc_aaaaaaaa-col_aaaaaaaa').getAttribute('aria-current')).toBeNull();
    expect(control('world-svc_aaaaaaaa-col_bbbbbbbb').getAttribute('aria-current')).toBe('page');

    act(() => {
      publishWorldDirectoryObservation({
        serviceUrl: 'http://localhost:5201',
        bridgeId: 'bridge_bbbbbbbb',
        directory: {
          type: 'collective:client-world-directory',
          bridgeId: 'bridge_bbbbbbbb',
          revision: 1,
          state: 'unavailable',
          code: 'service_unavailable',
          serviceInstanceId: 'svc_aaaaaaaa',
        },
      });
    });
    expect(control('world-svc_aaaaaaaa-col_aaaaaaaa').getAttribute('aria-current')).toBeNull();
    expect(control('world-svc_aaaaaaaa-col_bbbbbbbb').getAttribute('aria-current')).toBe('page');
  });

  it('keeps the rail bounded and exposes every additional world from the overflow control', () => {
    seedWorlds({
      memberships: [
        { collectiveId: 'col_aaaaaaaa', name: '一号共同体' },
        { collectiveId: 'col_bbbbbbbb', name: '二号共同体' },
        { collectiveId: 'col_cccccccc', name: '三号共同体' },
        { collectiveId: 'col_dddddddd', name: '四号共同体' },
      ],
    });
    render();
    expect(control('world-more').getAttribute('aria-expanded')).toBe('false');
    expect(host.querySelector('[data-testid="world-svc_aaaaaaaa-col_dddddddd"]')).toBeNull();

    act(() => control('world-more').click());
    expect(control('world-more').getAttribute('aria-expanded')).toBe('true');
    const overflowWorld = document.querySelector<HTMLButtonElement>(
      '[data-testid="world-overflow-svc_aaaaaaaa-col_dddddddd"]',
    );
    expect(overflowWorld?.textContent).toContain('四号共同体');
    act(() => overflowWorld?.click());
    expect(data.push).toHaveBeenLastCalledWith(
      '/collective?serviceUrl=http%3A%2F%2Flocalhost%3A5201&serviceInstanceId=svc_aaaaaaaa&collectiveId=col_dddddddd',
    );
  });
});
