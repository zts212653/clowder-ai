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
  cats: [
    { id: 'codex-astra', displayName: 'Astra', supported: true },
    { id: 'opus', displayName: 'Opus', supported: false },
  ],
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
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent === text);
    expect(button, text).toBeDefined();
    await act(async () => button!.click());
  };
  const select = async (label: string, value: string) => {
    const field = [...container.querySelectorAll('label')]
      .find((item) => item.textContent?.includes(label))
      ?.querySelector('select');
    expect(field, label).toBeDefined();
    await act(async () => {
      field!.value = value;
      field!.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };
  const open = async () => {
    await act(async () => root.render(<CollectiveParticipationPanel connectionId="connection-A" />));
    expect(fetchMock).not.toHaveBeenCalled();
    await click('带猫加入');
  };

  it('joins a supported named cat publicly and grants private execution only by a separate explicit choice', async () => {
    fetchMock.mockImplementation(async (_url, init) => response(init?.method ? {} : view));
    await open();
    expect(container.querySelector('option[value="opus"]')?.hasAttribute('disabled')).toBe(true);
    await select('带哪只猫', 'codex-astra');
    await click('带它加入');
    const first = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(first?.[0]).toBe('/api/plugins/collective-connector/connection-A/participation');
    expect(JSON.parse(String(first?.[1]?.body))).toEqual({
      catId: 'codex-astra',
      channelIds: ['general'],
      enabled: true,
      expectedRevision: 2,
    });
    await select('接受谁的持续委托', 'guest');
    await select('私人工作放在哪里', 'private');
    await click('带它加入');
    const calls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(calls[1]?.[1]?.body)).standingWork).toEqual({
      requestingHumanIds: ['guest'],
      threadId: 'private',
      expiresAt: null,
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/work/'))).toBe(false);
    expect(container.textContent).toContain('参与设置已发布');
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
    const resume = [...container.querySelectorAll('button')].find((button) => button.textContent === '继续执行')!;
    await act(async () => {
      resume.click();
      resume.click();
    });
    expect(payloads).toHaveLength(1);
    expect(container.textContent).toContain('response lost');
    await act(async () => root.render(<CollectiveParticipationPanel key="remounted" connectionId="connection-A" />));
    await click('带猫加入');
    await click('继续执行');
    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.requestId).toBe(payloads[1]?.requestId);
    expect(localStorage.getItem('collective-work-resume:connection-A:work:3')).toBeNull();
    expect(container.textContent).toContain('已恢复原执行记录');
    expect(container.querySelector('a[href="/thread/private"]')).not.toBeNull();
    expect(container.textContent).not.toContain('工作已完成');
  });
});
