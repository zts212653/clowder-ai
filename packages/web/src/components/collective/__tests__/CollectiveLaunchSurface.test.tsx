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

function experienceConnection(connectionId: string, serviceUrl: string) {
  return {
    serviceUrl,
    canonicalClientAnchor: {
      kind: 'collective-client' as const,
      serviceUrl,
      clientBuildId: 'collective-client-v2',
      serviceInstanceId: 'svc_f290_candidate',
      collectiveId: 'col_f290_assembly_candidate',
      connectionId,
    },
    serviceInstanceId: 'svc_f290_candidate',
    collectiveId: 'col_f290_assembly_candidate',
    connectionId,
    endpointId: `ep_${connectionId.slice(4)}`,
    endpointLabel: `Café ${connectionId.slice(-1)}`,
    authorityStatus: 'connected' as const,
    liveStatus: 'online' as const,
    lastAckedSequence: 0,
    outbox: { queued: 0, accepted: 0 },
    route: { configured: true },
    inbox: { persisted: 0, pending: 0, routed: 0, failed: 0 },
  };
}

async function dispatchExperienceMessage(iframe: HTMLIFrameElement, origin: string, data: Record<string, unknown>) {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { origin, source: iframe.contentWindow, data }));
    await Promise.resolve();
  });
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

  it('shows the official plugin activation boundary instead of inventing a fallback client', async () => {
    mockApiFetch.mockResolvedValue(response({ runtimeStatus: 'inactive', connections: [] }));
    await act(async () => root.render(<CollectiveLaunchSurface initialServiceUrl="http://localhost:5201" />));
    await flush();

    expect(container.textContent).toContain('先安装并启用 Collective Connector');
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('a[href="/settings?s=plugins"]')).not.toBeNull();
  });

  it('creates the independent local Service without a terminal and opens its one-time bootstrap in the canonical Client', async () => {
    mockApiFetch.mockImplementation(async (url, init) => {
      if (url === '/api/plugins/collective-connector/service/provision' && init?.method === 'POST') {
        return response({
          service: {
            state: 'setup_required',
            serviceUrl: 'http://127.0.0.1:5201',
            dataDirectory: '/home/user/.cat-cafe/collective-service',
            serviceInstanceId: 'svc_local',
            setupStep: 'github_app',
          },
          launchUrl: 'http://127.0.0.1:5201/#bootstrap=one-time-secret',
        });
      }
      return response({
        runtimeStatus: 'active',
        connections: [],
        localService: {
          state: 'not_created',
          serviceUrl: 'http://127.0.0.1:5201',
          dataDirectory: '/home/user/.cat-cafe/collective-service',
        },
      });
    });

    await act(async () => root.render(<CollectiveLaunchSurface />));
    await flush();

    expect(container.textContent).toContain('部署新 Service');
    expect(container.textContent).toContain('不需要打开终端或复制 secret');
    expect(container.textContent).toContain('/home/user/.cat-cafe/collective-service');
    const deploy = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('部署新 Service'),
    );
    expect(deploy).toBeDefined();
    await act(async () => {
      deploy?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockApiFetch).toHaveBeenCalledWith('/api/plugins/collective-connector/service/provision', {
      method: 'POST',
    });
    expect(container.querySelector('iframe')?.src).toBe(
      'http://127.0.0.1:5201/?hostOrigin=http%3A%2F%2Flocalhost%3A3000#bootstrap=one-time-secret',
    );
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
      'http://localhost:5201/?hostOrigin=http%3A%2F%2Flocalhost%3A3000&collectiveId=col_12345678',
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

  it('keeps a private Work panel open until the exact Client result receipt arrives', async () => {
    const serviceUrl = 'http://localhost:5201';
    window.history.replaceState({}, '', '/collective?experienceGate=f290-assembly');
    mockApiFetch.mockResolvedValue(
      response({ runtimeStatus: 'active', connections: [experienceConnection('con_f290_one', serviceUrl)] }),
    );
    await act(async () => root.render(<CollectiveLaunchSurface initialServiceUrl={serviceUrl} />));
    await flush();

    const iframe = container.querySelector('iframe');
    if (!iframe?.contentWindow) throw new Error('Collective iframe was not mounted');
    await dispatchExperienceMessage(iframe, serviceUrl, {
      type: 'collective:f290-experience-open-work',
      workRef: 'work_demo_product-brief',
    });
    const postMessage = vi.spyOn(iframe.contentWindow, 'postMessage');
    const returnResult = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('将公开结果带回原 Channel'),
    );
    expect(returnResult).toBeDefined();
    act(() => returnResult?.click());

    expect(postMessage).toHaveBeenCalledWith(
      { type: 'collective:f290-experience-result-ready', workRef: 'work_demo_product-brief' },
      serviceUrl,
    );
    expect(container.querySelector('[data-testid="f290-host-cafe-panel"]')).not.toBeNull();
    expect(returnResult?.disabled).toBe(true);

    await dispatchExperienceMessage(iframe, serviceUrl, {
      type: 'collective:f290-experience-result-accepted',
      workRef: 'work_demo_unknown',
    });
    expect(container.querySelector('[data-testid="f290-host-cafe-panel"]')).not.toBeNull();
    expect(returnResult?.disabled).toBe(true);

    await dispatchExperienceMessage(iframe, serviceUrl, {
      type: 'collective:f290-experience-result-rejected',
      workRef: 'work_demo_product-brief',
      reason: 'participation_revoked',
    });
    expect(container.textContent).toContain('参与已撤回；未回传公开结果。');
    expect(container.querySelector('[data-testid="f290-host-cafe-panel"]')).not.toBeNull();
    expect(returnResult?.disabled).toBe(false);

    await dispatchExperienceMessage(iframe, serviceUrl, {
      type: 'collective:f290-experience-result-accepted',
      workRef: 'work_demo_product-brief',
    });
    expect(container.querySelector('[data-testid="f290-host-cafe-panel"]')).not.toBeNull();

    act(() => returnResult?.click());
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(returnResult?.disabled).toBe(true);
    expect(container.textContent).not.toContain('参与已撤回；未回传公开结果。');

    await dispatchExperienceMessage(iframe, serviceUrl, {
      type: 'collective:f290-experience-result-accepted',
      workRef: 'work_demo_product-brief',
    });
    expect(container.querySelector('[data-testid="f290-host-cafe-panel"]')).toBeNull();
  });

  it('clears a prior Work when the Client asks for the Café overview', async () => {
    const serviceUrl = 'http://localhost:5201';
    window.history.replaceState({}, '', '/collective?experienceGate=f290-assembly');
    mockApiFetch.mockResolvedValue(
      response({ runtimeStatus: 'active', connections: [experienceConnection('con_f290_one', serviceUrl)] }),
    );
    await act(async () => root.render(<CollectiveLaunchSurface initialServiceUrl={serviceUrl} />));
    await flush();

    const iframe = container.querySelector('iframe');
    if (!iframe?.contentWindow) throw new Error('Collective iframe was not mounted');
    await dispatchExperienceMessage(iframe, serviceUrl, {
      type: 'collective:f290-experience-open-work',
      workRef: 'work_demo_product-brief',
    });
    await dispatchExperienceMessage(iframe, serviceUrl, { type: 'collective:f290-experience-open-cafe' });

    expect(container.querySelector('[data-testid="f290-host-cafe-panel"]')).not.toBeNull();
    expect(container.textContent).not.toContain('当前在 共同空间首页 的 Host 私人现场。');
    expect(
      Array.from(container.querySelectorAll('button')).some((button) =>
        button.textContent?.includes('将公开结果带回原 Channel'),
      ),
    ).toBe(false);
  });

  it('closes an F290 Host panel before switching to another Café connection', async () => {
    const firstServiceUrl = 'http://localhost:5201';
    const secondServiceUrl = 'http://localhost:5202';
    const first = experienceConnection('con_f290_one', firstServiceUrl);
    const second = experienceConnection('con_f290_two', secondServiceUrl);
    window.history.replaceState({}, '', '/collective?experienceGate=f290-assembly');
    mockApiFetch.mockResolvedValue(response({ runtimeStatus: 'active', connections: [first, second] }));
    await act(async () => root.render(<CollectiveLaunchSurface initialServiceUrl={firstServiceUrl} />));
    await flush();

    const selector = container.querySelector('select[aria-label="选择 Café 连接"]');
    if (!(selector instanceof HTMLSelectElement)) throw new Error('Connection selector was not mounted');
    await act(async () => {
      selector.value = first.connectionId;
      selector.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    await flush();
    const iframe = container.querySelector('iframe');
    if (!iframe?.contentWindow) throw new Error('Collective iframe was not mounted');
    await dispatchExperienceMessage(iframe, firstServiceUrl, {
      type: 'collective:f290-experience-open-work',
      workRef: 'work_demo_product-brief',
    });
    expect(container.querySelector('[data-testid="f290-host-cafe-panel"]')).not.toBeNull();

    await act(async () => {
      selector.value = second.connectionId;
      selector.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="f290-host-cafe-panel"]')).toBeNull();
  });
});
