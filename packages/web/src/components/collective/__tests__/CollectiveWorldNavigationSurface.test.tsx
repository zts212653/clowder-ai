import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { CollectiveLaunchSurface } from '../CollectiveLaunchSurface';

const mockApiFetch = vi.mocked(apiFetch);
const explicitTarget = (collectiveId: string) =>
  `/collective?serviceUrl=http%3A%2F%2Flocalhost%3A5201&serviceInstanceId=svc_12345678&collectiveId=${collectiveId}`;

function response(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function connection(collectiveId: string, connectionId = 'con_12345678') {
  return {
    serviceUrl: 'http://localhost:5201',
    serviceInstanceId: 'svc_12345678',
    collectiveId,
    connectionId,
    authorizedHumanId: 'human_12345678',
    endpointId: `ep_${connectionId.slice(4)}`,
    endpointLabel: collectiveId,
    authorityStatus: 'connected',
    liveStatus: 'online',
    lastAckedSequence: 0,
    outbox: { queued: 0, accepted: 0 },
    route: { configured: true, revision: 1 },
    inbox: { persisted: 0, pending: 0, routed: 0, failed: 0 },
  };
}

async function flush() {
  await act(async () => Promise.resolve());
}

describe('Collective world navigation surface', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
    window.history.replaceState({}, '', '/collective');
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.history.replaceState({}, '', '/collective');
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('handshakes a current-Human world directory even before this Café is paired', async () => {
    mockApiFetch.mockResolvedValue(
      response({
        runtimeStatus: 'active',
        connections: [],
        localService: {
          state: 'ready',
          serviceUrl: 'http://localhost:5201',
          dataDirectory: '/tmp/collective-service',
          serviceInstanceId: 'svc_12345678',
        },
      }),
    );
    await act(async () => root.render(<CollectiveLaunchSurface />));
    await flush();
    const iframe = container.querySelector('iframe');
    if (!iframe?.contentWindow) throw new Error('Collective iframe was not mounted');
    const postMessage = vi.spyOn(iframe.contentWindow, 'postMessage');

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'http://localhost:5201',
          source: iframe.contentWindow,
          data: { type: 'collective:world-directory-ready' },
        }),
      );
    });
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'collective:host-world-directory-init',
        expectedServiceInstanceId: 'svc_12345678',
      }),
      'http://localhost:5201',
    );
  });

  it('keeps a missing explicit target visible instead of falling back to a paired world', async () => {
    window.history.replaceState({}, '', explicitTarget('col_target000'));
    mockApiFetch.mockResolvedValue(response({ runtimeStatus: 'active', connections: [connection('col_fallback0')] }));
    await act(async () => root.render(<CollectiveLaunchSurface />));
    await flush();
    const iframe = container.querySelector('iframe');
    if (!iframe?.contentWindow) throw new Error('Collective iframe was not mounted');
    expect(new URL(iframe.src).searchParams.get('collectiveId')).toBe('col_target000');
    const postMessage = vi.spyOn(iframe.contentWindow, 'postMessage');
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'http://localhost:5201',
          source: iframe.contentWindow,
          data: { type: 'collective:world-directory-ready' },
        }),
      );
    });
    const init = postMessage.mock.calls.find(
      ([message]) => message.type === 'collective:host-world-directory-init',
    )?.[0];
    if (!init) throw new Error('Host did not initialize the world-directory bridge');
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'http://localhost:5201',
          source: iframe.contentWindow,
          data: {
            type: 'collective:client-world-directory',
            bridgeId: init.bridgeId,
            revision: 1,
            state: 'ready',
            serviceInstanceId: 'svc_12345678',
            humanId: 'human_12345678',
            currentCollectiveId: 'col_fallback0',
            memberships: [{ collectiveId: 'col_fallback0', name: 'Fallback', role: 'steward' }],
          },
        }),
      );
    });
    expect(container.textContent).toContain('目标共同家园已不可用');
    expect(new URL(iframe.src).searchParams.get('collectiveId')).toBe('col_target000');
  });

  it('refuses an incomplete explicit target instead of opening a paired fallback', async () => {
    window.history.replaceState({}, '', '/collective?collectiveId=col_target000');
    mockApiFetch.mockResolvedValue(response({ runtimeStatus: 'active', connections: [connection('col_fallback0')] }));
    await act(async () => root.render(<CollectiveLaunchSurface />));
    await flush();

    expect(container.textContent).toContain('目标共同家园地址不完整');
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('revalidates an explicit target when browser history changes', async () => {
    window.history.replaceState({}, '', explicitTarget('col_target000'));
    mockApiFetch.mockResolvedValue(
      response({
        runtimeStatus: 'active',
        connections: [connection('col_target000', 'con_target000'), connection('col_target111', 'con_target111')],
      }),
    );
    await act(async () => root.render(<CollectiveLaunchSurface />));
    await flush();
    expect(new URL(container.querySelector('iframe')?.src ?? '').searchParams.get('collectiveId')).toBe(
      'col_target000',
    );

    await act(async () => {
      window.history.pushState({}, '', explicitTarget('col_target111'));
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(new URL(container.querySelector('iframe')?.src ?? '').searchParams.get('collectiveId')).toBe(
      'col_target111',
    );
  });
});
