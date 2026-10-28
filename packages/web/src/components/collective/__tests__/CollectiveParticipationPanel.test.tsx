import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'http://127.0.0.1:3102' }));

import { apiFetch } from '@/utils/api-client';
import { CollectiveParticipationPanel } from '../CollectiveParticipationPanel';
import type { ParticipationView } from '../use-collective-participation';

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
    expect(container.textContent).toContain('这种接入方式暂时不能参与');
    expect(container.textContent?.indexOf('我的猫')).toBeLessThan(
      container.textContent?.indexOf('这段讨论带回的请求与工作') ?? -1,
    );
  });

  it('retains a local canonical avatar in the home roster', async () => {
    fetchMock.mockImplementation(async () =>
      response({ ...view, cats: [{ ...view.cats[0], avatar: '/api/cats/codex-astra/avatar?bindingRevision=2' }] }),
    );
    await open();
    expect(
      container.querySelector('img[src="http://127.0.0.1:3102/api/cats/codex-astra/avatar?bindingRevision=2"]'),
    ).not.toBeNull();
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
    const roster = container.querySelector('section[aria-label="我的猫"]');
    expect(roster).not.toBeNull();
    expect(roster?.querySelector('img[src="/avatars/codex-sol.png"]')).not.toBeNull();
    expect(roster?.textContent).toContain('缅因猫（Sol）');
    expect(roster?.textContent).toContain('gpt-6-sol');
    expect(roster?.textContent).toContain('这种接入方式暂时不能参与');
    expect(container.textContent?.indexOf('我的猫')).toBeLessThan(
      container.textContent?.indexOf('这段讨论带回的请求与工作') ?? -1,
    );
    expect(container.textContent).not.toContain('管理参与伙伴');
  });

  it('shows one home-roster row per cat and confirms the consequence before disabling collective participation', async () => {
    const rosterView = {
      ...view,
      cats: [
        {
          id: 'codex61-sol',
          displayName: '小太阳',
          nickname: '小太阳',
          breedDisplayName: '缅因猫',
          variantLabel: 'GPT-6.1 Sol',
          avatar: '/avatars/codex61-sol.png',
          defaultModel: 'gpt-6.1-sol',
          configured: true,
          eligible: true,
          supported: true,
        },
        {
          id: 'codex-sol',
          displayName: '小太阳',
          nickname: '小太阳',
          breedDisplayName: '缅因猫',
          variantLabel: 'GPT-5.6 Sol',
          avatar: '/avatars/codex-sol.png',
          defaultModel: 'gpt-5.6-sol',
          configured: true,
          eligible: true,
          supported: true,
        },
        {
          id: 'deepseek',
          displayName: 'DeepSeek',
          defaultModel: 'deepseek-v4-pro',
          configured: true,
          eligible: false,
          supported: true,
        },
        {
          id: 'codex-luna',
          displayName: '小月亮',
          configured: false,
          eligible: false,
          supported: true,
        },
        {
          id: 'channel-excluded',
          displayName: '守门猫',
          nickname: '守门猫',
          configured: true,
          eligible: true,
          supported: true,
        },
      ],
      desiredParticipation: {
        ...view.desiredParticipation,
        channelOverrides: {
          general: { excludedCatIds: ['channel-excluded'] },
          second: { excludedCatIds: ['channel-excluded', 'codex-sol'] },
        },
      },
      channelRoutes: {
        general: {
          ...view.channelRoutes.general,
          participants: {
            'codex61-sol': { displayName: '小太阳' },
            'codex-sol': { displayName: '小太阳' },
          },
        },
        second: {
          ...view.channelRoutes.second,
          participants: { 'codex61-sol': { displayName: '小太阳' } },
        },
      } as ParticipationView['channelRoutes'],
    };
    let current = rosterView;
    fetchMock.mockImplementation(async (_url, init) => {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body));
        current = {
          ...rosterView,
          revision: 3,
          desiredParticipation: body.policy,
          channelRoutes: {
            general: {
              ...rosterView.channelRoutes.general,
              participants: { 'codex61-sol': { displayName: '小太阳' } },
            },
            second: rosterView.channelRoutes.second,
          },
        };
      }
      return response(current);
    });

    await open();
    const roster = container.querySelector('section[aria-label="我的猫"]');
    expect(roster).not.toBeNull();
    expect(roster?.querySelectorAll('[data-testid="collective-cat-row"]')).toHaveLength(5);
    expect(roster?.textContent).toContain('家里 5 只 · 3 只在这里');
    expect(roster?.textContent).not.toContain('一只猫一行');
    expect(roster?.textContent).toContain('@codex61-sol');
    expect(roster?.textContent).toContain('@codex-sol');
    expect(roster?.textContent).toContain('缅因猫 · GPT-6.1 Sol');
    expect(roster?.textContent).toContain('这种接入方式暂时不能参与');
    expect(roster?.textContent).toContain('家里已停用');
    expect(roster?.textContent).toContain('已开启 · 目前没有加入任何频道');
    expect(
      roster?.querySelector<HTMLButtonElement>(
        'button[role="switch"][aria-label="DeepSeek（@deepseek）参与这个共同体"]',
      )?.disabled,
    ).toBe(true);

    const solSwitch = roster?.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="小太阳（@codex-sol）参与这个共同体"]',
    );
    expect(solSwitch?.getAttribute('aria-checked')).toBe('true');
    await act(async () => solSwitch?.click());
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
    expect(roster?.textContent).toContain(
      '关掉以后，小太阳不再收到这个共同体的新请求，也不在这里发言；已经接下的工作照实际情况留在「日程」里。',
    );
    await click('关掉');

    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(put?.[1]?.body))).toEqual({
      expectedRevision: 2,
      channelIds: ['general', 'second'],
      policy: {
        defaultMode: 'include',
        excludedCatIds: ['codex-sol'],
        channelOverrides: {
          general: { excludedCatIds: ['channel-excluded'] },
          second: { excludedCatIds: ['channel-excluded', 'codex-sol'] },
        },
      },
    });
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
    expect(container.textContent).toContain('做完了，还没回复');
    expect(container.querySelector('a[href="/thread/private"]')?.textContent).toContain('在家里查看');
  });

  it('does not mix the retired private-standing grant form into the collective roster', async () => {
    fetchMock.mockImplementation(async (_url, init) => response(init?.method ? {} : view));
    await open();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method).length).toBe(0);
    expect(container.textContent).not.toContain('私人持续委托');
    expect(container.textContent).not.toContain('管理参与伙伴');
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
    expect(container.textContent).toContain('家里现在没有猫留意这类回应请求');
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
    expect(container.textContent).toContain('已回复');
    expect(container.textContent).not.toContain('已进入回应队列');
  });
});
