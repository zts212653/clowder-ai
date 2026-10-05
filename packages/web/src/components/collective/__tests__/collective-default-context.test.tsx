import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { CollectiveLaunchSurface } from '../CollectiveLaunchSurface';
import { requestStatus } from '../CollectiveWorkRequests';

const service = 'http://localhost:5272';
const connection = {
  serviceUrl: service,
  serviceInstanceId: 'svc_12345678',
  collectiveId: 'col_12345678',
  connectionId: 'con_12345678',
  authorizedHumanId: 'human_12345678',
  endpointLabel: 'You’s Café',
  authorityStatus: 'connected',
  liveStatus: 'online',
  lastAckedSequence: 2,
  outbox: { queued: 0, accepted: 0 },
  route: { configured: true },
  inbox: { persisted: 2, pending: 0, routed: 2, failed: 0 },
};
const response = (body: unknown) => new Response(JSON.stringify(body));
const failedRequest = (code: string, named = true) =>
  ({
    event: { recipient: named ? { kind: 'agent' } : undefined },
    failure: { code },
  }) as Parameters<typeof requestStatus>[0];
let workReconciliationResult: unknown;
let currentConnections: (typeof connection)[];
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  window.history.replaceState({}, '', '/collective');
  workReconciliationResult = { result: 'not_admitted' };
  currentConnections = [connection];
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (String(url).endsWith('/work/result/accepted')) return response(workReconciliationResult);
    return response(
      String(url).endsWith('/participation')
        ? {
            revision: 1,
            published: true,
            cats: [],
            bindings: {},
            requests: [],
            tasks: [],
            threads: [{ id: 'secret-thread', title: 'PRIVATE_HOST_ONLY' }],
          }
        : { runtimeStatus: 'active', connections: currentConnections },
    );
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});
const message = async (iframe: HTMLIFrameElement, data: unknown, origin = service, source = iframe.contentWindow) => {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
  });
};
it('identifies a sole revoked connection without losing its Host re-pair context', async () => {
  currentConnections = [{ ...connection, authorityStatus: 'revoked' }];
  await act(async () => root.render(<CollectiveLaunchSurface initialServiceUrl={service} />));
  const iframe = container.querySelector('iframe');
  if (!iframe?.contentWindow) throw new Error('Collective iframe was not mounted');
  const post = vi.spyOn(iframe.contentWindow, 'postMessage');

  await message(iframe, { type: 'collective:context-ready' });

  expect(post.mock.calls.find(([body]) => body.type === 'collective:host-context-init')?.[0]).toMatchObject({
    connectionId: connection.connectionId,
    authorityStatus: 'revoked',
  });
  expect(container.querySelector('[aria-label="我的 Café"]')).toBeNull();
});
it('reports an exactly published zero-cat participation to the current Client bridge', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    response(
      String(url).endsWith('/participation')
        ? {
            revision: 1,
            published: true,
            reconcileRequired: false,
            cats: [],
            bindings: {},
            desiredParticipation: { defaultMode: 'include', excludedCatIds: [], channelOverrides: {} },
            observedEligibility: {},
            channelRoutes: { general: { channelId: 'general', threadId: 'thread_12345678', participants: {} } },
            standingInterests: {},
            attentionRevision: 0,
            requests: [],
            tasks: [],
            threads: [],
          }
        : { runtimeStatus: 'active', connections: [connection] },
    ),
  );
  await act(async () => root.render(<CollectiveLaunchSurface initialServiceUrl={service} />));
  const iframe = container.querySelector('iframe');
  if (!iframe?.contentWindow) throw new Error('Collective iframe was not mounted');
  const post = vi.spyOn(iframe.contentWindow, 'postMessage');
  await message(iframe, { type: 'collective:context-ready' });
  const init = post.mock.calls.find(([body]) => body.type === 'collective:host-context-init')?.[0];
  if (!init) throw new Error('Host bridge was not initialized');
  await message(iframe, {
    type: 'collective:client-context',
    bridgeId: init.bridgeId,
    contextId: 'context_12345678',
    revision: 1,
    serviceInstanceId: connection.serviceInstanceId,
    collectiveId: connection.collectiveId,
    humanId: connection.authorizedHumanId,
    channelId: 'general',
    channelIds: ['general'],
    openCafe: false,
  });
  await vi.waitFor(() => {
    expect(post.mock.calls.find(([body]) => body.type === 'collective:host-participation-ready')?.[0]).toMatchObject({
      bridgeId: init.bridgeId,
      serviceInstanceId: connection.serviceInstanceId,
      collectiveId: connection.collectiveId,
      connectionId: connection.connectionId,
      humanId: connection.authorizedHumanId,
      participationRevision: 1,
      catCount: 0,
    });
  });
});
it.each([
  {
    case: 'completed privately without a public reply',
    request: {
      delivery: 'routed',
      privateThread: { id: 'thread_private', title: 'Collective #general 公共参与' },
      execution: { stage: 'ended' },
    },
    expected: '执行已结束，尚未回到频道',
  },
  {
    case: 'a missing private Thread at delivery',
    request: { delivery: 'route_failed', failure: { code: 'ROUTE_THREAD_UNAVAILABLE' } },
    expected: '点名暂未送达：私人入口已失效，授权仍有效时会在修复后自动补送',
  },
])('shows the exact named request state for $case in the Host activity area', async ({ request, expected }) => {
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    response(
      String(url).endsWith('/participation')
        ? {
            revision: 1,
            published: true,
            reconcileRequired: false,
            cats: [{ id: 'codex-sol', displayName: '缅因猫（Sol）', configured: true, eligible: true }],
            bindings: {},
            desiredParticipation: { defaultMode: 'include', excludedCatIds: [], channelOverrides: {} },
            observedEligibility: {},
            channelRoutes: {
              general: {
                channelId: 'general',
                threadId: 'thread_public',
                participants: { 'codex-sol': { displayName: '缅因猫（Sol）' } },
              },
            },
            standingInterests: {},
            attentionRevision: 0,
            requests: [
              {
                event: {
                  eventId: 'evt_request',
                  location: { channelId: 'general' },
                  recipient: { kind: 'agent', agentId: 'codex-sol' },
                },
                ...request,
              },
            ],
            tasks: [],
            threads: [{ id: 'thread_private', title: 'Collective #general 公共参与' }],
          }
        : { runtimeStatus: 'active', connections: [connection] },
    ),
  );
  await act(async () => root.render(<CollectiveLaunchSurface initialServiceUrl={service} />));
  const iframe = container.querySelector('iframe');
  if (!iframe?.contentWindow) throw new Error('Collective iframe was not mounted');
  const post = vi.spyOn(iframe.contentWindow, 'postMessage');
  await message(iframe, { type: 'collective:context-ready' });
  const init = post.mock.calls.find(([body]) => body.type === 'collective:host-context-init')?.[0];
  if (!init) throw new Error('Host bridge was not initialized');
  await message(iframe, {
    type: 'collective:client-context',
    bridgeId: init.bridgeId,
    contextId: 'context_12345678',
    revision: 1,
    serviceInstanceId: connection.serviceInstanceId,
    collectiveId: connection.collectiveId,
    humanId: connection.authorizedHumanId,
    channelId: 'general',
    channelIds: ['general'],
    openCafe: false,
  });
  await vi.waitFor(() => expect(container.querySelector('[aria-label="家里近况"]')?.textContent).toContain(expected));
});
it('attributes a failed named request to the actual delivery boundary instead of the owner settings', () => {
  expect(requestStatus(failedRequest('ROUTE_THREAD_UNAVAILABLE'))).toBe(
    '点名暂未送达：私人入口已失效，授权仍有效时会在修复后自动补送',
  );
  expect(requestStatus(failedRequest('ECONNREFUSED'))).toBe('点名暂未送达：服务暂不可用，正在重试');
  expect(requestStatus(failedRequest('ROUTE_CAT_UNAVAILABLE'))).toBe('点名暂未送达：猫暂不可用，正在重试');
  expect(requestStatus(failedRequest('ROUTE_QUEUE_FULL'))).toBe('点名暂未送达：猫的队列已满，正在重试');
  expect(requestStatus(failedRequest('PARTICIPATION_REVOKED'))).toBe(
    '点名未送达：这条请求的参与授权已失效，不会自动重发',
  );
  expect(requestStatus(failedRequest('UNEXPECTED_ROUTE_FAILURE'))).toBe('点名未送达：家里的投递遇到问题');
  expect(requestStatus(failedRequest('ROUTE_QUEUE_FULL', false))).toBe('回应请求暂未送达：猫的队列已满，正在重试');
  expect(requestStatus(failedRequest('ROUTE_THREAD_UNAVAILABLE', false))).toBe('回应请求未送达：私人 Thread 不可用');
  expect(requestStatus(failedRequest('PARTICIPATION_REVOKED', false))).toBe('回应请求未送达：这条请求的参与授权不匹配');
});
it('opens the native Café only for the current default Client and clears it on a new frame session', async () => {
  await act(async () => root.render(<CollectiveLaunchSurface initialServiceUrl={service} />));
  const iframe = container.querySelector('iframe');
  if (!iframe?.contentWindow) throw new Error('Collective iframe was not mounted');
  expect(new URL(iframe.src).searchParams.has('experienceGate')).toBe(false);
  expect(container.textContent).not.toContain('带猫加入');
  const post = vi.spyOn(iframe.contentWindow, 'postMessage');
  await message(iframe, { type: 'collective:context-ready' });
  const init = post.mock.calls.find(([body]) => body.type === 'collective:host-context-init')?.[0];
  expect(init).toBeDefined();
  const projection = {
    type: 'collective:client-context',
    bridgeId: init.bridgeId,
    contextId: 'context-12345678',
    revision: 1,
    serviceInstanceId: connection.serviceInstanceId,
    collectiveId: connection.collectiveId,
    humanId: connection.authorizedHumanId,
    channelId: '产品方向',
    channelIds: ['产品方向'],
    openCafe: true,
  };
  await message(iframe, projection, 'https://foreign.invalid');
  await message(iframe, { ...projection, humanId: 'human_other123' });
  await message(iframe, { ...projection, privateThreadId: 'injected' });
  expect(container.querySelector('[aria-label="我的 Café"]')).toBeNull();
  await message(iframe, projection);
  expect(container.querySelector('[aria-label="我的 Café"]')).not.toBeNull();
  expect(container.textContent).toContain('# 产品方向');
  expect(JSON.stringify(post.mock.calls)).not.toContain('secret-thread');
  expect(JSON.stringify(post.mock.calls)).not.toContain('PRIVATE_HOST_ONLY');
  const accepted = {
    type: 'collective:client-work-result-accepted',
    bridgeId: init.bridgeId,
    contextId: projection.contextId,
    contextRevision: projection.revision,
    serviceInstanceId: connection.serviceInstanceId,
    collectiveId: connection.collectiveId,
    connectionId: connection.connectionId,
    humanId: connection.authorizedHumanId,
    workId: 'work_12345678',
    workRevision: 4,
    assignmentEventId: 'evt_assignment123',
    resultEventId: 'evt_result12345',
    resultRevision: 2,
  };
  await message(iframe, { ...accepted, bridgeId: 'bridge_forged1' });
  await message(iframe, accepted, 'https://foreign.invalid');
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/work/result/accepted'))).toBe(false);
  await message(iframe, accepted);
  expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(
    `/api/plugins/collective-connector/${connection.connectionId}/work/result/accepted`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        serviceInstanceId: connection.serviceInstanceId,
        collectiveId: connection.collectiveId,
        connectionId: connection.connectionId,
        workId: 'work_12345678',
        workRevision: 4,
        assignmentEventId: 'evt_assignment123',
        resultEventId: 'evt_result12345',
        resultRevision: 2,
      }),
    },
  );
  await act(async () => Promise.resolve());
  expect(post.mock.calls.some(([body]) => body.type === 'collective:host-work-result-reconciled')).toBe(false);

  workReconciliationResult = { result: 'closed', taskId: 'task_12345678', revision: 2 };
  await message(iframe, accepted);
  await act(async () => Promise.resolve());
  expect(post).toHaveBeenCalledWith(
    {
      type: 'collective:host-work-result-reconciled',
      bridgeId: init.bridgeId,
      contextId: projection.contextId,
      contextRevision: projection.revision,
      workId: 'work_12345678',
      workRevision: 4,
    },
    service,
  );
  await message(iframe, { ...projection, revision: 2, openCafe: false });
  await message(iframe, projection);
  expect(container.querySelector('[aria-label="我的 Café"]')).toBeNull();
  await message(iframe, { ...projection, revision: 3 });
  expect(container.querySelector('[aria-label="我的 Café"]')).not.toBeNull();
  act(() => iframe.dispatchEvent(new Event('load')));
  await message(iframe, { ...projection, revision: 4 });
  expect(container.querySelector('[aria-label="我的 Café"]')).toBeNull();
});

it('selects the requested connection and resends exact Work focus for each current context revision', async () => {
  window.history.replaceState(
    {},
    '',
    '/collective?connectionId=con_12345678&workId=work_12345678&workRevision=4&channelId=general&resultEventId=evt_result12345&resultRevision=2',
  );
  await act(async () => root.render(<CollectiveLaunchSurface initialServiceUrl={service} />));
  const iframe = container.querySelector('iframe');
  if (!iframe?.contentWindow) throw new Error('Collective iframe was not mounted');
  const post = vi.spyOn(iframe.contentWindow, 'postMessage');
  await message(iframe, { type: 'collective:context-ready' });
  const init = post.mock.calls.find(([body]) => body.type === 'collective:host-context-init')?.[0];
  if (!init) throw new Error('Host bridge was not initialized');
  const projection = {
    type: 'collective:client-context',
    bridgeId: init.bridgeId,
    contextId: 'context-12345678',
    revision: 1,
    serviceInstanceId: connection.serviceInstanceId,
    collectiveId: connection.collectiveId,
    humanId: connection.authorizedHumanId,
    channelId: 'general',
    channelIds: ['general'],
    openCafe: false,
  };
  await message(iframe, projection);
  expect(post).toHaveBeenCalledWith(
    {
      type: 'collective:host-focus-work',
      bridgeId: init.bridgeId,
      contextId: projection.contextId,
      contextRevision: projection.revision,
      workId: 'work_12345678',
      workRevision: 4,
      channelId: 'general',
      resultEventId: 'evt_result12345',
      resultRevision: 2,
    },
    service,
  );
  await message(iframe, { ...projection, revision: 2 });
  const focusMessages = post.mock.calls.filter(([body]) => body.type === 'collective:host-focus-work');
  expect(focusMessages).toHaveLength(2);
  expect(focusMessages.at(-1)?.[0]).toMatchObject({ contextId: projection.contextId, contextRevision: 2 });
});
