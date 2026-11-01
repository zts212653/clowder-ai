import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'http://127.0.0.1:3102' }));

import { apiFetch } from '@/utils/api-client';
import { CollectiveParticipationPanel } from '../CollectiveParticipationPanel';
import { projectReplyRecovery } from '../collective-reply-recovery-projection';
import type { ParticipationView } from '../use-collective-participation';

const fetchMock = vi.mocked(apiFetch);
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

const persisted: ParticipationView = {
  revision: 2,
  published: true,
  reconcileRequired: false,
  cats: [{ id: 'codex61-sol', displayName: '小太阳', configured: true, eligible: true, supported: true }],
  desiredParticipation: { defaultMode: 'include', excludedCatIds: [], channelOverrides: {} },
  observedEligibility: {
    'codex61-sol': { displayName: '小太阳', configured: true, eligible: true },
  },
  channelRoutes: {
    general: {
      channelId: 'general',
      threadId: 'public-general',
      participants: { 'codex61-sol': { displayName: '小太阳' } },
    },
  },
  standingInterests: {},
  attentionRevision: 0,
  bindings: {},
  threads: [{ id: 'private', title: 'Collective #general 公共参与' }],
  requests: [
    {
      messageId: 'request',
      delivery: 'routed',
      privateThread: { id: 'private', title: 'Collective #general 公共参与' },
      event: {
        eventId: 'event',
        body: 'hi',
        actor: { kind: 'human', humanId: 'owner-human', displayName: 'You' },
        location: { channelId: 'general' },
        recipient: {
          kind: 'agent',
          humanId: 'owner-human',
          agentId: 'codex61-sol',
          connectionId: 'connection-A',
          participationRevision: 2,
        },
      } as ParticipationView['requests'][number]['event'],
    },
  ],
  tasks: [],
};

function freshView(): ParticipationView {
  return structuredClone(persisted);
}

function recoveryCalls() {
  return fetchMock.mock.calls.filter(([url]) => String(url).includes('/collective-reply-recovery/'));
}

describe('Collective reply recovery projection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    fetchMock.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('offers recovery without synthetic execution after Host readback proves the stored turn', async () => {
    fetchMock.mockImplementation(async (url) =>
      String(url).includes('/collective-reply-recovery/')
        ? response({ status: 'recoverable', sourceMessageId: 'request', responseMessageId: 'response' })
        : response(persisted),
    );
    await act(async () =>
      root.render(
        <CollectiveParticipationPanel connectionId="connection-A" channelId="general" channels={['general']} />,
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/collective-reply-recovery/'))).toBe(true);
    expect(container.textContent).toContain('做完了，还没回复');
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === '补交原回复')).toBe(true);
  });

  it('renders the base participation row while the optional recovery probe is still pending', async () => {
    const stalledProbe = new Promise<Response>(() => {});
    fetchMock.mockImplementation(async (url) =>
      String(url).includes('/collective-reply-recovery/') ? stalledProbe : response(persisted),
    );

    await act(async () => {
      root.render(
        <CollectiveParticipationPanel connectionId="connection-A" channelId="general" channels={['general']} />,
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(recoveryCalls()).toHaveLength(1);
    expect(container.textContent).toContain('已在家里，正在确认猫的状态');
    expect(container.textContent).not.toContain('正在读取这段讨论的工作…');
    expect([...container.querySelectorAll('button')].some((button) => button.textContent === '补交原回复')).toBe(false);
  });

  it('keeps polling participation while an earlier optional recovery probe is still pending', async () => {
    vi.useFakeTimers();
    const next = freshView();
    const additional = structuredClone(next.requests[0]);
    if (!additional) throw new Error('missing request fixture');
    additional.messageId = 'request-next';
    additional.event.eventId = 'event-next';
    additional.event.body = 'NEXT_PARTICIPATION_REQUEST';
    next.requests.push(additional);
    const stalledProbe = new Promise<Response>(() => {});
    let participationReads = 0;
    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes('/collective-reply-recovery/')) return stalledProbe;
      participationReads += 1;
      return response(participationReads === 1 ? persisted : next);
    });

    await act(async () => {
      root.render(
        <CollectiveParticipationPanel connectionId="connection-A" channelId="general" channels={['general']} />,
      );
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(participationReads).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(participationReads).toBe(2);
    expect(container.textContent).toContain('NEXT_PARTICIPATION_REQUEST');
  });

  const rejectedReadbacks: ReadonlyArray<{
    name: string;
    readback: () => Promise<Response>;
  }> = [
    { name: 'a 409 response', readback: async () => response({ code: 'NOT_READY' }, 409) },
    { name: 'a transport error', readback: async () => Promise.reject(new Error('offline')) },
    {
      name: 'a mismatched source id',
      readback: async () =>
        response({ status: 'recoverable', sourceMessageId: 'other', responseMessageId: 'response' }),
    },
    {
      name: 'a missing response id',
      readback: async () => response({ status: 'recoverable', sourceMessageId: 'request' }),
    },
    {
      name: 'a non-recoverable status',
      readback: async () => response({ status: 'pending', sourceMessageId: 'request', responseMessageId: 'response' }),
    },
  ];

  for (const rejected of rejectedReadbacks) {
    it(`does not project recovery from ${rejected.name}`, async () => {
      fetchMock.mockImplementation(rejected.readback);

      const projected = await projectReplyRecovery(freshView());

      expect(recoveryCalls()).toHaveLength(1);
      expect(projected.requests[0]?.recovery).toBeUndefined();
    });
  }

  const ineligibleRequests: ReadonlyArray<{
    name: string;
    mutate: (view: ParticipationView) => void;
  }> = [
    {
      name: 'already has an execution projection',
      mutate: (view) => {
        const request = view.requests[0];
        if (request) request.execution = { stage: 'ended' };
      },
    },
    {
      name: 'already has a public response',
      mutate: (view) => {
        const request = view.requests[0];
        if (request) request.response = structuredClone(request.event);
      },
    },
    {
      name: 'is owned by a Collective Work',
      mutate: (view) => {
        view.tasks = [
          {
            id: 'task',
            title: 'Existing Work',
            threadId: 'private',
            status: 'doing',
            revision: 1,
            closure: 'open',
            sourceRefs: ['message:request'],
          },
        ];
      },
    },
    {
      name: 'has already failed delivery',
      mutate: (view) => {
        const request = view.requests[0];
        if (request) request.failure = { code: 'DELIVERY_FAILED' };
      },
    },
    {
      name: 'was not routed',
      mutate: (view) => {
        const request = view.requests[0];
        if (request) request.delivery = 'failed';
      },
    },
  ];

  for (const ineligible of ineligibleRequests) {
    it(`does not probe a request that ${ineligible.name}`, async () => {
      const view = freshView();
      ineligible.mutate(view);
      fetchMock.mockResolvedValue(
        response({ status: 'recoverable', sourceMessageId: 'request', responseMessageId: 'response' }),
      );

      const projected = await projectReplyRecovery(view);

      expect(recoveryCalls()).toHaveLength(0);
      expect(projected.requests[0]?.recovery).toBeUndefined();
    });
  }
});
