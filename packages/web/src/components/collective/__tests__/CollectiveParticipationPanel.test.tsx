import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { CollectiveParticipationPanel } from '../CollectiveParticipationPanel';

const fetchMock = vi.mocked(apiFetch);
const view = {
  revision: 2,
  published: true,
  reconcileRequired: false,
  cats: [
    { id: 'codex-astra', displayName: 'Astra', configured: true, eligible: true, supported: true },
    { id: 'opus', displayName: 'Opus', configured: true, eligible: false, supported: false },
  ],
  desiredParticipation: { defaultMode: 'include' as const, excludedCatIds: [], channelOverrides: {} },
  observedEligibility: {
    'codex-astra': { displayName: 'Astra', configured: true, eligible: true },
    opus: { displayName: 'Opus', configured: true, eligible: false },
  },
  channelRoutes: {
    general: {
      channelId: 'general',
      threadId: 'public-general',
      participants: { 'codex-astra': { displayName: 'Astra' } },
    },
    second: {
      channelId: 'second',
      threadId: 'public-second',
      participants: { 'codex-astra': { displayName: 'Astra' } },
    },
  },
  standingInterests: {},
  attentionRevision: 0,
  bindings: {},
  threads: [{ id: 'private', title: '私人工作' }],
  requests: [
    {
      messageId: 'request',
      delivery: 'routed',
      event: {
        eventId: 'event',
        body: '请持续处理这项工作',
        actor: { kind: 'human', humanId: 'guest', displayName: 'Guest' },
        location: { channelId: 'general' },
      },
    },
  ],
  tasks: [],
};
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

describe('Collective owner participation interactions', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fetchMock.mockReset();
    localStorage.clear();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  const click = async (text: string) => {
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.startsWith(text));
    expect(button, text).toBeDefined();
    await act(async () => button?.click());
  };
  const checkbox = async (label: string) => {
    const field = [...container.querySelectorAll('label')]
      .find((item) => item.textContent?.includes(label))
      ?.querySelector('input');
    expect(field, label).toBeDefined();
    await act(async () => field?.click());
  };
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  const open = async () => {
    await act(async () =>
      root.render(
        <CollectiveParticipationPanel
          connectionId="connection-A"
          channelId="general"
          channels={['general', 'second']}
        />,
      ),
    );
    expect(fetchMock).toHaveBeenCalled();
  };

  it('automatically reconciles every eligible Cat without an individual join click or private grant', async () => {
    let reconciled = false;
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/participation/reconcile') && init?.method === 'POST') {
        reconciled = true;
        return response({ revision: 1, published: true });
      }
      return response(
        reconciled
          ? { ...view, revision: 1 }
          : {
              ...view,
              revision: 0,
              published: false,
              reconcileRequired: true,
              observedEligibility: {},
              channelRoutes: {},
            },
      );
    });
    await open();
    await settle();
    const mutation = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith('/participation/reconcile') && init?.method === 'POST',
    );
    expect(JSON.parse(String(mutation?.[1]?.body))).toEqual({
      channelIds: ['general', 'second'],
      expectedRevision: 0,
    });
    expect(String(mutation?.[1]?.body)).not.toContain('standingWork');
    expect(String(mutation?.[1]?.body)).not.toContain('catId');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/work/'))).toBe(false);
    expect(container.textContent).not.toContain('带它加入');
    expect(container.textContent).toContain('Opus');
    expect(container.textContent).toContain('暂时无法公共参与');
    expect(container.textContent?.indexOf('这段讨论带回的请求与工作')).toBeLessThan(
      container.textContent?.indexOf('管理参与伙伴') ?? -1,
    );
  });

  it('shows registered identities and the next action before Work, while keeping exclusions visible', async () => {
    fetchMock.mockImplementation(async () =>
      response({
        ...view,
        cats: [
          {
            id: 'codex-sol',
            displayName: '缅因猫（Sol）',
            avatar: '/avatars/codex-sol.png',
            roleDescription: '处理复杂实现',
            defaultModel: 'gpt-6-sol',
            configured: true,
            eligible: true,
            supported: true,
          },
          {
            id: 'codex',
            displayName: '缅因猫（砚砚）',
            avatar: '/avatars/codex.png',
            roleDescription: '代码审查与定位',
            defaultModel: 'gpt-5.3-codex',
            configured: true,
            eligible: false,
            supported: false,
          },
        ],
        channelRoutes: {
          ...view.channelRoutes,
          general: { ...view.channelRoutes.general, participants: { 'codex-sol': { displayName: '缅因猫（Sol）' } } },
          second: { ...view.channelRoutes.second, participants: { 'codex-sol': { displayName: '缅因猫（Sol）' } } },
        },
      }),
    );
    await open();
    const roster = container.querySelector('section[aria-label="本频道的伙伴"]');
    expect(roster).not.toBeNull();
    expect(roster?.querySelector('img[src="/avatars/codex-sol.png"]')).not.toBeNull();
    expect(roster?.textContent).toContain('缅因猫（Sol）');
    expect(roster?.textContent).toContain('处理复杂实现');
    expect(roster?.textContent).toContain('gpt-6-sol');
    expect(roster?.textContent).toContain('暂时无法公共参与');
    expect(container.textContent?.indexOf('本频道的伙伴')).toBeLessThan(
      container.textContent?.indexOf('这段讨论带回的请求与工作') ?? -1,
    );
    expect(container.textContent).toContain('管理参与伙伴');
  });

  it('retains one resume operation through response loss and remount, without double-click execution', async () => {
    const current = {
      ...view,
      tasks: [
        {
          id: 'work',
          title: '原工作',
          threadId: 'private',
          status: 'doing',
          revision: 3,
          closure: 'open',
          sourceRefs: ['message:request'],
        },
      ],
    };
    let requests = 0;
    const payloads: Record<string, unknown>[] = [];
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/work/resume')) {
        payloads.push(JSON.parse(String(init?.body)));
        requests++;
        if (requests === 1) throw new Error('response lost');
        return response({ disposition: 'already_queued' });
      }
      return response(current);
    });
    await open();
    const resume = [...container.querySelectorAll('button')].find((button) => button.textContent === '继续执行');
    expect(resume).toBeDefined();
    await act(async () => {
      resume?.click();
      resume?.click();
    });
    expect(payloads).toHaveLength(1);
    expect(container.textContent).toContain('response lost');
    await act(async () =>
      root.render(
        <CollectiveParticipationPanel
          key="remounted"
          connectionId="connection-A"
          channelId="general"
          channels={['general', 'second']}
        />,
      ),
    );
    await click('继续执行');
    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.requestId).toBe(payloads[1]?.requestId);
    expect(localStorage.getItem('collective-work-resume:connection-A:work:3')).toBeNull();
    expect(container.textContent).toContain('已恢复原执行记录');
    expect(container.querySelector('a[href="/thread/private"]')).not.toBeNull();
    expect(container.textContent).not.toContain('工作已完成');
  });

  it('writes a current-Channel exception without changing another Channel or global policy', async () => {
    let current: unknown = view;
    fetchMock.mockImplementation(async (_url, init) => {
      if (init?.method === 'PUT') {
        current = {
          ...view,
          revision: 3,
          desiredParticipation: {
            ...view.desiredParticipation,
            channelOverrides: { general: { excludedCatIds: ['codex-astra'] } },
          },
          channelRoutes: {
            ...view.channelRoutes,
            general: { ...view.channelRoutes.general, participants: {} },
          },
        };
        return response({ revision: 3, published: true });
      }
      return response(current);
    });
    await open();
    await checkbox('Astra 参与 # general');
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(put?.[0]).toBe('/api/plugins/collective-connector/connection-A/participation/policy');
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      expectedRevision: 2,
      channelIds: ['general', 'second'],
      policy: {
        defaultMode: 'include',
        excludedCatIds: [],
        channelOverrides: { general: { excludedCatIds: ['codex-astra'] } },
      },
    });
    expect(JSON.parse(String(put?.[1]?.body)).policy.channelOverrides.second).toBeUndefined();
  });

  it('shows only requests and Work whose source belongs to the selected channel', async () => {
    const other = {
      ...view.requests[0],
      messageId: 'elsewhere',
      event: {
        ...view.requests[0]?.event,
        eventId: 'event-other',
        body: 'OTHER_CHANNEL_PRIVATE_REQUEST',
        location: { channelId: 'second' },
      },
    };
    fetchMock.mockImplementation(async () =>
      response({
        ...view,
        requests: [...view.requests, other],
        tasks: [
          {
            id: 'elsewhere-work',
            title: 'Other Work',
            threadId: 'private-other',
            closure: 'open',
            sourceRefs: ['message:elsewhere'],
          },
        ],
      }),
    );
    await open();
    expect(container.textContent).toContain('请持续处理这项工作');
    expect(container.textContent).not.toContain('OTHER_CHANNEL_PRIVATE_REQUEST');
    expect(container.querySelector('a[href="/thread/private-other"]')).toBeNull();
  });

  it('shows when a named cat finished privately without a public reply and links the owner Thread', async () => {
    fetchMock.mockImplementation(async () =>
      response({
        ...view,
        requests: [
          {
            ...view.requests[0],
            privateThread: { id: 'private', title: 'Collective #general 公共参与' },
            execution: { stage: 'ended' },
          },
        ],
      }),
    );
    await open();
    expect(container.textContent).toContain('执行已结束，尚未回到频道');
    expect(container.querySelector('a[href="/thread/private"]')?.textContent).toContain('Collective #general 公共参与');
  });

  it('keeps private standing authority behind a separate explicit action', async () => {
    fetchMock.mockImplementation(async (_url, init) => response(init?.method ? {} : view));
    await open();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method).length).toBe(0);
    const management = [...container.querySelectorAll('details')].find((item) =>
      item.querySelector('summary')?.textContent?.includes('管理参与伙伴'),
    );
    expect(management).toBeDefined();
    expect(management?.open).toBe(false);
    if (management) management.open = true;
    await click('设置 Astra 的私人持续委托');
    await checkbox('允许指定成员');
    await checkbox('Guest');
    await click('保存私人授权');
    const put = fetchMock.mock.calls.find(
      ([url, init]) => String(url).endsWith('/participation') && init?.method === 'PUT',
    );
    expect(JSON.parse(String(put?.[1]?.body)).standingWork).toEqual({
      requestingHumanIds: ['guest'],
      expiresAt: null,
    });
  });

  it('shows Host attention custody without offering an unclaimed response request as private Work', async () => {
    fetchMock.mockImplementation(async () =>
      response({
        ...view,
        requests: [
          {
            ...view.requests[0],
            event: {
              ...view.requests[0]?.event,
              attentionRequest: 'response_requested',
              body: '这件事谁家在做？',
            },
            attention: { request: 'response_requested', state: 'unclaimed' },
          },
        ],
      }),
    );
    await open();
    expect(container.textContent).toContain('家里当前没有伙伴值守这类回应请求');
    expect(container.textContent).not.toContain('交给它持续处理');
  });

  it('replaces a queued attention label with the public response fact', async () => {
    fetchMock.mockImplementation(async () =>
      response({
        ...view,
        requests: [
          {
            ...view.requests[0],
            event: {
              ...view.requests[0]?.event,
              attentionRequest: 'response_requested',
              body: '这件事谁家在做？',
            },
            attention: {
              request: 'response_requested',
              state: 'wake_queued',
              catId: 'codex-astra',
              interestRevision: 1,
            },
            response: { eventId: 'reply', body: '我家在跟进。' },
          },
        ],
      }),
    );
    await open();
    expect(container.textContent).toContain('已有回应；回应已回到共同现场');
    expect(container.textContent).not.toContain('已进入回应队列');
  });
});
