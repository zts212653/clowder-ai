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
  expiresAt: '2099-08-29T00:00:00.000Z',
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function openCafe(iframe: HTMLIFrameElement) {
  const frame = iframe.contentWindow;
  if (!frame) throw new Error('Expected Collective iframe contentWindow');
  const post = vi.spyOn(frame, 'postMessage');
  await act(async () =>
    window.dispatchEvent(
      new MessageEvent('message', {
        source: iframe.contentWindow,
        origin: 'http://localhost:5201',
        data: { type: 'collective:context-ready' },
      }),
    ),
  );
  const init = post.mock.calls.find(([data]) => data.type === 'collective:host-context-init')?.[0];
  if (!init) throw new Error('Host did not initialize its public context bridge');
  await act(async () =>
    window.dispatchEvent(
      new MessageEvent('message', {
        source: iframe.contentWindow,
        origin: 'http://localhost:5201',
        data: {
          type: 'collective:client-context',
          bridgeId: init.bridgeId,
          contextId: 'context-test-123456',
          revision: 1,
          serviceInstanceId: init.serviceInstanceId,
          collectiveId: init.collectiveId,
          humanId: init.humanId,
          channelId: 'general',
          channelIds: ['general'],
          openCafe: true,
        },
      }),
    ),
  );
  post.mockRestore();
}
async function flush() {
  await act(async () => Promise.resolve());
}

function requiredIframe(container: HTMLElement): HTMLIFrameElement {
  const iframe = container.querySelector('iframe');
  if (!iframe) throw new Error('Expected Collective iframe');
  return iframe;
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
      if (url === '/api/plugins/collective-connector/entry-roster') {
        return response({
          fingerprint: 'a'.repeat(64),
          cats: [
            { id: 'codex-sol', displayName: '缅因猫（Sol）', eligible: true, roleDescription: '一起写代码' },
            { id: 'opus', displayName: '布偶猫', eligible: false },
          ],
        });
      }
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
            collectiveId: 'col_older123',
            connectionId: 'con_old12345',
            authorizedHumanId: 'human_12345678',
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
            authorizedHumanId: 'human_12345678',
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
    expect(container.querySelector('[data-concierge-reserved-rect="collective-message-actions"]')).not.toBeNull();
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

    expect(mockApiFetch.mock.calls.some(([url]) => url === '/api/plugins/collective-connector/pair')).toBe(false);
    expect(container.textContent).toContain('缅因猫（Sol）');
    expect(container.textContent).toContain('一起写代码');
    const solChoice = container.querySelector<HTMLInputElement>('input[aria-label="带入 缅因猫（Sol）"]');
    expect(solChoice?.checked).toBe(true);
    await act(async () => solChoice?.click());
    const confirm = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('确认带入'),
    );
    await act(async () => {
      confirm?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const pairCall = mockApiFetch.mock.calls.find(([url]) => url === '/api/plugins/collective-connector/pair');
    expect(pairCall?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(pairCall?.[1]?.body))).toEqual({
      serviceUrl: 'http://localhost:5201',
      endpointLabel: 'Clowder AI on localhost:3000',
      intent,
      rosterFingerprint: 'a'.repeat(64),
      excludedCatIds: ['codex-sol'],
    });
    expect(new URL(requiredIframe(container).src).searchParams.get('collectiveId')).toBe('col_12345678');

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'http://localhost:5201',
          source: iframe?.contentWindow,
          data: { type: 'collective:pairing-intent', serviceUrl: 'http://localhost:5201', intent },
        }),
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain('已连接当前共同家园');
    expect(
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('确认带入'))
        ?.disabled,
    ).toBe(true);
    expect(mockApiFetch.mock.calls.filter(([url]) => url === '/api/plugins/collective-connector/pair')).toHaveLength(1);
  });

  it('returns to the bring-in review when several old endpoint records were revoked', async () => {
    mockApiFetch.mockImplementation(async (url) =>
      url === '/api/plugins/collective-connector/entry-roster'
        ? response({ fingerprint: 'a'.repeat(64), cats: [{ id: 'codex-sol', displayName: 'Sol', eligible: true }] })
        : response({
            runtimeStatus: 'active',
            connections: ['one', 'two', 'three'].map((id) => ({
              serviceUrl: 'http://localhost:5201',
              serviceInstanceId: 'svc_12345678',
              collectiveId: 'col_12345678',
              connectionId: `con_${id}`,
              endpointId: `ep_${id}`,
              endpointLabel: id,
              authorityStatus: 'revoked',
              liveStatus: 'offline',
              outbox: { queued: 0, accepted: 0 },
              inbox: { persisted: 0, pending: 0, routed: 0, failed: 0 },
            })),
          }),
    );
    await act(async () => root.render(<CollectiveLaunchSurface initialServiceUrl="http://localhost:5201" />));
    await flush();
    expect(container.textContent).not.toContain('进入哪个共同家园？');
    const iframe = container.querySelector('iframe');
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'http://localhost:5201',
          source: iframe?.contentWindow,
          data: { type: 'collective:pairing-intent', serviceUrl: 'http://localhost:5201', intent },
        }),
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain('先看清要带来的伙伴');
    expect(container.textContent).toContain('Sol');
  });

  it('recovers the entry roster after a transient read failure without pairing early', async () => {
    let reads = 0;
    mockApiFetch.mockImplementation(async (url) => {
      if (url === '/api/plugins/collective-connector/entry-roster') {
        reads += 1;
        return reads === 1
          ? response({ error: 'unavailable' }, 503)
          : response({ fingerprint: 'b'.repeat(64), cats: [{ id: 'codex-sol', displayName: 'Sol', eligible: true }] });
      }
      return response({ runtimeStatus: 'active', connections: [] });
    });
    await act(async () => root.render(<CollectiveLaunchSurface initialServiceUrl="http://localhost:5201" />));
    await flush();
    const iframe = container.querySelector('iframe');
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'http://localhost:5201',
          source: iframe?.contentWindow,
          data: { type: 'collective:pairing-intent', serviceUrl: 'http://localhost:5201', intent },
        }),
      );
      await Promise.resolve();
    });
    expect(container.textContent).toContain('暂时无法读取这台 Café');
    const retry = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('重新读取名单'),
    );
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Sol');
    expect(reads).toBe(2);
    expect(mockApiFetch.mock.calls.some(([url]) => url === '/api/plugins/collective-connector/pair')).toBe(false);
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
            authorizedHumanId: 'human_12345678',
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

    await openCafe(requiredIframe(container));
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
            connectionId: 'con_route12345',
            authorizedHumanId: 'human_12345678',
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

    await openCafe(requiredIframe(container));
    expect(container.textContent).toContain('1 条消息还没有进入配置的 Thread');
    expect(container.textContent).toContain('更新消息去向后会自动重试');
    expect(container.textContent).not.toContain('Configured thread is unavailable');
  });
});
