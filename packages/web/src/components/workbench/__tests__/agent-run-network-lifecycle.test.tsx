import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => transport.fetch(...args) }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => undefined }) }));
vi.mock('@/hooks/useIsDesktop', () => ({ useIsDesktop: () => true }));
vi.mock('@/components/listen-mode/ListenModePlayer', () => ({ ListenModePlayer: () => null }));
vi.mock('../F307WorkspaceHomePage', () => ({ F307WorkspaceHomePage: () => <div>Workspace Home</div> }));
vi.mock('../WorkbenchToolsContent', () => ({ WorkbenchToolsContent: () => null }));
vi.mock('@/components/SessionChainPanel', () => ({ SessionChainPanel: () => null }));
vi.mock('@/components/audit/SessionEventsViewer', () => ({ SessionEventsViewer: () => null }));

import { useChatStore } from '@/stores/chatStore';
import { createArtifactWorkPresentationState } from '../artifact-work-presentation';
import { useF307ExperienceWorkbenchStore as store } from '../experience-workbench-store';
import { F307ExperienceWorkbench } from '../F307ExperienceWorkbench';
import { createAgentRunSurface } from '../real-surface-adapters';
import { createInitialWorkbenchState } from '../workbench-model';

const surface = createAgentRunSurface({ invocationId: 'inv-lifecycle', threadId: 'thread-lifecycle' });
const summary = {
  invocationId: 'inv-lifecycle',
  threadId: 'thread-lifecycle',
  sessionId: 'session-lifecycle',
  sessionSeq: 0,
  sessionStatus: 'active',
  catId: 'codex61-sol',
  status: 'running',
  startedAt: 1000,
  eventCount: 0,
  statusEventCount: 0,
  toolUseCount: 0,
  toolResultCount: 0,
  messageCount: 0,
  errorCount: 0,
  toolNames: [],
  keyMessages: [],
};

describe('real Agent Run host network lifecycle', () => {
  let root: Root;
  let container: HTMLDivElement;
  let denied: boolean;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    useChatStore.setState({ currentThreadId: 'thread-lifecycle', catInvocations: {}, activeInvocations: {} });
    store.setState({
      layout: createInitialWorkbenchState([surface]),
      hydrated: true,
      mainAreaAttentionSurfaceId: null,
      focusSurfaceId: null,
      artifactWorkPresentation: createArtifactWorkPresentationState(),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    denied = false;
    transport.fetch.mockReset().mockImplementation(async (url: string) => {
      if (url === '/api/threads/thread-lifecycle/invocations?limit=500') {
        return { ok: true, json: async () => ({ invocations: [summary] }) };
      }
      if (url === '/api/invocations/inv-lifecycle/trajectory?threadId=thread-lifecycle') {
        return denied
          ? { ok: false, status: 403, json: async () => ({ code: 'INVOCATION_FORBIDDEN' }) }
          : { ok: true, json: async () => summary };
      }
      if (url.startsWith('/api/invocations/inv-lifecycle/request-generations?')) {
        return { ok: true, json: async () => ({ ...summary, generations: [], gaps: [] }) };
      }
      if (url === '/api/sessions/session-lifecycle/invocations/inv-lifecycle') {
        return { ok: true, json: async () => ({ ...summary, summary, events: [] }) };
      }
      throw new Error(`Unexpected real-owner request: ${url}`);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    localStorage.clear();
    store.setState({ layout: createInitialWorkbenchState(), hydrated: false });
  });

  async function render(pulse = 0, visible = true) {
    await act(async () =>
      root.render(
        <F307ExperienceWorkbench
          threadId="thread-lifecycle"
          onSelectDevSurface={() => undefined}
          onOpenAppRoute={() => undefined}
          visible={visible}
          worktreeId="worktree-lifecycle"
          openFilePath={null}
          preview={{ path: '/' }}
          statusSurface={<span>{pulse}</span>}
        />,
      ),
    );
    await act(async () => {});
  }

  function resolutions() {
    return transport.fetch.mock.calls.filter(([url]) => String(url).includes('/trajectory?')).length;
  }

  async function pulses(visible = true) {
    // Five real parent renders over one second; this also catches requests from CSS-hidden owners.
    for (let pulse = 1; pulse <= 5; pulse++) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 200)));
      await render(pulse, visible);
    }
  }

  it('does not reread a visible invocation when only its host rerenders', async () => {
    await render();
    expect(resolutions()).toBe(1);
    await pulses();
    expect(resolutions()).toBe(1);
  });

  it('keeps the same logical owner stable when the layout refreshes its descriptor metadata', async () => {
    await render();
    for (let pulse = 1; pulse <= 3; pulse++) {
      await act(async () =>
        store.getState().dispatch({
          type: 'refresh-surface',
          surface: {
            ...surface,
            title: `Live metadata ${pulse}`,
            ownerStateRef: { ...surface.ownerStateRef },
            ...(surface.resultTargetRef ? { resultTargetRef: { ...surface.resultTargetRef } } : {}),
          },
        }),
      );
    }
    expect(resolutions()).toBe(1);
  });

  it('retains the closed descriptor without rereading it from Home, then revalidates on restore', async () => {
    await render();
    await act(async () =>
      store.getState().dispatch({
        type: 'close-surface',
        surfaceId: surface.id,
        entitlement: { kind: 'user', reason: 'close-button' },
      }),
    );
    expect(store.getState().layout.recentlyClosed).toContainEqual(surface);
    const afterClose = transport.fetch.mock.calls.length;
    await pulses();
    expect(transport.fetch.mock.calls.length, 'closed owners must perform no further reads over one second').toBe(
      afterClose,
    );
    denied = true;
    const beforeRestore = resolutions();
    const detailReads = () =>
      transport.fetch.mock.calls.filter(([url]) => String(url).startsWith('/api/sessions/')).length;
    const beforeDenied = detailReads();
    await act(async () =>
      store.getState().dispatch({
        type: 'restore-surface',
        surfaceId: surface.id,
        entitlement: { kind: 'user', reason: 'surface-tab' },
      }),
    );
    expect(resolutions()).toBe(beforeRestore + 1);
    expect(container.textContent).toContain('没有权限查看这轮 invocation');
    expect(detailReads()).toBe(beforeDenied);
    expect(container.textContent).not.toContain('session-lifecycle');
  });

  it('restores a closed descriptor on Home without mounting network readers', async () => {
    store.getState().dispatch({
      type: 'close-surface',
      surfaceId: surface.id,
      entitlement: { kind: 'user', reason: 'close-button' },
    });
    await render();
    await pulses();
    expect(transport.fetch.mock.calls).toHaveLength(0);
  });

  it('pauses readers while the whole workbench is hidden and revalidates when shown', async () => {
    await render(0, false);
    await pulses(false);
    expect(transport.fetch.mock.calls).toHaveLength(0);
    await render(6, true);
    expect(resolutions()).toBe(1);
    await render(7, false);
    const afterHide = transport.fetch.mock.calls.length;
    await pulses(false);
    expect(transport.fetch.mock.calls.length).toBe(afterHide);
    await render(8, true);
    expect(resolutions()).toBe(2);
  });
});
