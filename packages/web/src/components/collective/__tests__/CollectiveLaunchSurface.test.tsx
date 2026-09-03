import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { CollectiveLaunchSurface } from '../CollectiveLaunchSurface';

const mockApiFetch = vi.mocked(apiFetch);
const intent = {
  serviceInstanceId: 'svc_12345678',
  collectiveId: 'col_12345678',
  pairingIntentId: 'pair_12345678',
  hostOrigin: 'http://localhost:3000',
  nonce: 'n'.repeat(32),
  expiresAt: '2026-08-29T00:00:00.000Z',
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function flush() {
  await act(async () => Promise.resolve());
}

describe('CollectiveLaunchSurface', () => {
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
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('shows the official plugin activation boundary instead of inventing a fallback client', async () => {
    mockApiFetch.mockResolvedValue(response({ runtimeStatus: 'inactive', connections: [] }));
    await act(async () => root.render(<CollectiveLaunchSurface initialServiceUrl="http://localhost:5201" />));
    await flush();

    expect(container.textContent).toContain('先安装并启用 Collective Connector');
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('a[href="/settings?s=plugins"]')).not.toBeNull();
  });

  it('embeds the canonical Service client and accepts pairing only from that exact frame and origin', async () => {
    let paired = false;
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugins/collective-connector' && !paired) {
        return response({ runtimeStatus: 'active', connections: [] });
      }
      if (url === '/api/plugins/collective-connector/pair' && init?.method === 'POST') {
        paired = true;
        return response({ connectionId: 'con_12345678' });
      }
      return response({
        runtimeStatus: 'active',
        connections: [
          {
            serviceUrl: 'http://localhost:5201',
            serviceInstanceId: 'svc_12345678',
            collectiveId: 'col_12345678',
            connectionId: 'con_old12345',
            endpointId: 'ep_old123456',
            endpointLabel: 'Older Clowder AI',
            authorityStatus: 'connected',
            liveStatus: 'offline',
            lastAckedSequence: 2,
            outbox: { queued: 0, accepted: 0 },
            route: { configured: false },
            inbox: { persisted: 2, pending: 2, routed: 0, failed: 0 },
          },
          {
            serviceUrl: 'http://localhost:5201',
            serviceInstanceId: 'svc_12345678',
            collectiveId: 'col_12345678',
            connectionId: 'con_12345678',
            endpointId: 'ep_12345678',
            endpointLabel: 'Clowder AI',
            authorityStatus: 'connected',
            liveStatus: 'online',
            lastAckedSequence: 0,
            outbox: { queued: 0, accepted: 0 },
            route: { configured: false },
            inbox: { persisted: 0, pending: 0, routed: 0, failed: 0 },
          },
        ],
      });
    });

    await act(async () => root.render(<CollectiveLaunchSurface initialServiceUrl="http://localhost:5201" />));
    await flush();
    const iframe = container.querySelector('iframe');
    expect(iframe?.src).toBe('http://localhost:5201/?hostOrigin=http%3A%2F%2Flocalhost%3A3000');
    expect(iframe?.title).toBe('Collective');
    expect(iframe?.getAttribute('sandbox')).toContain('allow-popups-to-escape-sandbox');
    expect(container.textContent).not.toContain('canonical client');
    expect(container.textContent).not.toContain('ACK #');

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'http://malicious.invalid',
          source: iframe?.contentWindow,
          data: { type: 'collective:pairing-intent', serviceUrl: 'http://localhost:5201', intent },
        }),
      );
      await Promise.resolve();
    });
    expect(mockApiFetch.mock.calls.some(([url]) => url === '/api/plugins/collective-connector/pair')).toBe(false);

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'http://localhost:5201',
          source: iframe?.contentWindow,
          data: { type: 'collective:pairing-intent', serviceUrl: 'http://localhost:5201', intent },
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const pairCall = mockApiFetch.mock.calls.find(([url]) => url === '/api/plugins/collective-connector/pair');
    expect(pairCall?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(pairCall?.[1]?.body))).toEqual({
      serviceUrl: 'http://localhost:5201',
      endpointLabel: 'Clowder AI on localhost:3000',
      intent,
    });
    expect(container.textContent).toContain('Café 连接在线');
  });

  it('enables re-pair only after the exact iframe reports a restored steward session', async () => {
    mockApiFetch.mockResolvedValue(
      response({
        runtimeStatus: 'active',
        connections: [
          {
            serviceUrl: 'http://localhost:5201',
            serviceInstanceId: 'svc_12345678',
            collectiveId: 'col_12345678',
            connectionId: 'con_revoked1',
            endpointId: 'ep_revoked12',
            endpointLabel: 'Retired Clowder AI',
            authorityStatus: 'revoked',
            liveStatus: 'offline',
            lastAckedSequence: 7,
            outbox: { queued: 0, accepted: 2 },
            route: { configured: true, revision: 1 },
            inbox: { persisted: 7, pending: 0, routed: 7, failed: 0 },
          },
        ],
      }),
    );

    await act(async () => root.render(<CollectiveLaunchSurface />));
    await flush();

    expect(container.textContent).toContain('Café 连接已撤销');
    expect(container.textContent).toContain('准备中…');
    expect(container.textContent).not.toContain('重连');
    expect(container.textContent).not.toContain('撤销连接');
    expect(container.textContent).not.toContain('credential');
    expect(container.querySelector('iframe')?.src).toBe(
      'http://localhost:5201/?hostOrigin=http%3A%2F%2Flocalhost%3A3000',
    );

    const iframe = container.querySelector('iframe');
    if (!iframe?.contentWindow) throw new Error('Collective iframe was not mounted');
    const postMessage = vi.spyOn(iframe.contentWindow, 'postMessage');
    const rePair = Array.from(container.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === '重新配对',
    );
    expect(rePair).toBeDefined();
    expect(rePair?.disabled).toBe(true);
    act(() => rePair?.click());
    expect(postMessage).not.toHaveBeenCalled();

    act(() => iframe?.dispatchEvent(new Event('load')));
    expect(postMessage).toHaveBeenCalledWith({ type: 'collective:request-pairing-status' }, 'http://localhost:5201');
    expect(postMessage).not.toHaveBeenCalledWith({ type: 'collective:request-pairing' }, 'http://localhost:5201');

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'http://malicious.invalid',
          source: iframe?.contentWindow,
          data: { type: 'collective:pairing-ready', serviceUrl: 'http://localhost:5201' },
        }),
      );
      await Promise.resolve();
    });
    expect(rePair?.disabled).toBe(true);

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'http://localhost:5201',
          source: iframe?.contentWindow,
          data: { type: 'collective:pairing-ready', serviceUrl: 'http://localhost:5201' },
        }),
      );
      await Promise.resolve();
    });
    expect(rePair?.disabled).toBe(false);
    act(() => rePair?.click());

    expect(postMessage).toHaveBeenCalledWith({ type: 'collective:request-pairing' }, 'http://localhost:5201');

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'http://localhost:5201',
          source: iframe?.contentWindow,
          data: {
            type: 'collective:pairing-error',
            serviceUrl: 'http://localhost:5201',
            code: 'session_required',
          },
        }),
      );
      await Promise.resolve();
    });
    expect(rePair?.disabled).toBe(true);
    expect(container.textContent).toContain('先在 Collective 登录');
  });

  it('shows Host route custody honestly when Service ACK is ahead of Thread delivery', async () => {
    mockApiFetch.mockResolvedValue(
      response({
        runtimeStatus: 'active',
        connections: [
          {
            serviceUrl: 'http://localhost:5201',
            serviceInstanceId: 'svc_12345678',
            collectiveId: 'col_12345678',
            connectionId: 'con_route1',
            endpointId: 'ep_route1',
            endpointLabel: 'Clowder AI',
            authorityStatus: 'connected',
            liveStatus: 'online',
            lastAckedSequence: 4,
            outbox: { queued: 0, accepted: 1 },
            route: { configured: true, revision: 2 },
            inbox: {
              persisted: 4,
              pending: 0,
              routed: 3,
              failed: 1,
              latestFailure: { code: 'ROUTE_THREAD_UNAVAILABLE', message: 'Configured thread is unavailable' },
            },
          },
        ],
      }),
    );

    await act(async () => root.render(<CollectiveLaunchSurface />));
    await flush();

    expect(container.textContent).toContain('1 条消息还没有进入配置的 Thread');
    expect(container.textContent).toContain('更新消息去向后会自动重试');
    expect(container.textContent).not.toContain('Configured thread is unavailable');
  });
});
