import type { ActiveExecutionProjection, CollectiveClientContext } from '@cat-cafe/shared';
import type { ComponentProps } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollectiveCafeHost } from '../CollectiveCafeHost';
import { executionForPrivateRequest } from '../CollectivePrivateSlots';
import type { ParticipationView } from '../use-collective-participation';

let view: ParticipationView | undefined;
const mutate = vi.fn();
vi.mock('../use-collective-participation', () => ({
  useCollectiveParticipation: () => ({ view, busy: false, mutate, reload: vi.fn() }),
  useCollectiveAutoReconcile: vi.fn(),
}));
vi.mock('../use-collective-work-policy', () => ({ useCollectiveWorkPolicy: () => ({}) }));

const context: CollectiveClientContext = {
  type: 'collective:client-context',
  bridgeId: 'bridge_12345678',
  contextId: 'context_12345678',
  revision: 1,
  serviceInstanceId: 'svc_12345678',
  collectiveId: 'col_12345678',
  humanId: 'human_12345678',
  channelId: 'general',
  channelIds: ['general'],
  openCafe: false,
};

const baseProps = {
  connection: { connectionId: 'con_12345678', authorityStatus: 'connected' },
  context,
  onClose: vi.fn(),
  onPair: vi.fn(),
  onMutate: vi.fn(),
  connections: [],
  onSelectConnection: vi.fn(),
} as unknown as ComponentProps<typeof CollectiveCafeHost>;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mutate.mockReset();
  view = {
    revision: 1,
    published: true,
    reconcileRequired: false,
    cats: [{ id: 'codex-astra', displayName: '小星星', configured: true, eligible: true, supported: true }],
    desiredParticipation: { defaultMode: 'include', excludedCatIds: [], channelOverrides: {} },
    observedEligibility: {},
    channelRoutes: {
      general: {
        channelId: 'general',
        threadId: 'thread_general',
        participants: { 'codex-astra': { displayName: '小星星' } },
      },
    },
    standingInterests: {},
    attentionRevision: 0,
    bindings: {},
    threads: [],
    requests: [],
    tasks: [],
  };
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('removes the duplicate sidebar activity block and opens the private roster only on request', async () => {
  await act(async () => root.render(<CollectiveCafeHost {...baseProps} />));
  expect(container.querySelector('[aria-label="家里近况"]')).toBeNull();
  expect(container.textContent).not.toContain('猫猫动态');
  expect(container.querySelector('[aria-label="我的猫"]')).toBeNull();

  await act(async () => root.render(<CollectiveCafeHost {...baseProps} context={{ ...context, openCafe: true }} />));
  expect(container.querySelector('[aria-label="我的猫"]')).not.toBeNull();
  expect(container.querySelector('section[aria-label="我的猫"]')).not.toBeNull();
  expect(container.textContent).not.toContain('家里的对话仍然只属于你');
});

it('opens channel listening directly when the channel menu requests that private section', async () => {
  await act(async () =>
    root.render(<CollectiveCafeHost {...baseProps} context={{ ...context, openCafe: true, cafeSection: 'channel' }} />),
  );

  expect(container.querySelector('section[aria-label="# general 的消息回应"]')).not.toBeNull();
  expect(container.querySelector('section[aria-label="我的猫"]')).toBeNull();
});

it.each([
  ['cats', '正在读取我的猫…'],
  ['channel', '正在读取频道设置…'],
  ['permissions', '正在读取已允许的工作…'],
] as const)('keeps the %s section truthful while its first snapshot is loading', async (cafeSection, copy) => {
  view = undefined;
  await act(async () =>
    root.render(<CollectiveCafeHost {...baseProps} context={{ ...context, openCafe: true, cafeSection }} />),
  );

  expect(container.textContent).toContain(copy);
});

it('hosts the private roster at a current public slot and fences stale and foreign placements', async () => {
  const iframe = document.createElement('iframe');
  container.appendChild(iframe);
  const iframeRef = { current: iframe };
  const props = {
    ...baseProps,
    iframeRef,
    connection: {
      ...baseProps.connection,
      serviceUrl: 'https://collective.example',
      serviceInstanceId: context.serviceInstanceId,
      collectiveId: context.collectiveId,
      authorizedHumanId: context.humanId,
    },
  };
  const placement = {
    type: 'collective:client-ui-placement',
    bridgeId: context.bridgeId,
    contextId: context.contextId,
    contextRevision: 1,
    humanId: context.humanId,
    serviceInstanceId: context.serviceInstanceId,
    collectiveId: context.collectiveId,
    channelId: context.channelId,
    slots: [{ kind: 'roster', x: 300, y: 80, width: 600, height: 360 }],
  };
  const send = async (
    data: unknown = placement,
    origin = 'https://collective.example',
    source: MessageEventSource | null = iframe.contentWindow,
  ) => {
    await act(async () => window.dispatchEvent(new MessageEvent('message', { data, origin, source })));
  };
  await act(async () => root.render(<CollectiveCafeHost {...props} />));
  await send(placement, 'https://foreign.example');
  await send(placement, 'https://collective.example', window);
  await send({ ...placement, channelId: 'another-channel' });
  await send({ ...placement, humanId: 'human_another' });
  await send({ ...placement, slots: [{ ...placement.slots[0], width: -1 }] });
  await send({ ...placement, slots: [{ ...placement.slots[0], threadId: 'private-thread' }] });
  expect(container.querySelector('[aria-label="我的猫 · 仅自己可见"]')).toBeNull();
  await send();
  expect(container.querySelector('[aria-label="我的猫 · 仅自己可见"]')?.textContent).toContain('小星星');
  expect(container.querySelector('[aria-label="我的猫分区"]')).toBeNull();
  await act(async () => root.render(<CollectiveCafeHost {...props} context={{ ...context, revision: 2 }} />));
  expect(container.querySelector('[aria-label="我的猫 · 仅自己可见"]')).toBeNull();
  await send();
  expect(container.querySelector('[aria-label="我的猫 · 仅自己可见"]')).toBeNull();
  iframe.remove();
});

it('routes the empty listening roster to the Client member page', async () => {
  if (!view) throw new Error('Expected loaded participation');
  view.channelRoutes.general.participants = {};
  const onOpenMembers = vi.fn();
  await act(async () =>
    root.render(
      <CollectiveCafeHost
        {...baseProps}
        onOpenMembers={onOpenMembers}
        context={{ ...context, openCafe: true, cafeSection: 'channel' }}
      />,
    ),
  );
  const select = [...container.querySelectorAll('button')].find((button) => button.textContent === '选择猫…');
  expect(select).toBeDefined();
  await act(async () => select?.click());
  expect(onOpenMembers).toHaveBeenCalledOnce();
  expect(container.querySelector('section[aria-label="我的猫"]')).toBeNull();
});

it('never attaches another invocation in the same private thread to this request cancellation', () => {
  const request: ParticipationView['requests'][number] = {
    event: {
      ...context,
      eventId: 'evt_request',
      clientEventId: 'request',
      sequence: 1,
      actor: { kind: 'human', humanId: context.humanId, displayName: 'You' },
      target: { kind: 'channel', channelId: 'general' },
      location: { channelId: 'general' },
      recipient: {
        kind: 'agent',
        humanId: context.humanId,
        connectionId: 'con_12345678',
        agentId: 'codex-astra',
        participationRevision: 1,
      },
      body: 'exact source request',
      acceptedAt: '2026-10-18T02:00:00.000Z',
    },
    delivery: 'routed',
    privateThread: { id: 'thread_private' },
    execution: { stage: 'started', invocationId: 'child_exact' },
  };
  const execution: ActiveExecutionProjection = {
    kind: 'live_invocation',
    executionId: 'parent_exact',
    turnInvocationId: 'another_child',
    threadId: 'thread_private',
    threadTitle: null,
    catId: 'codex-astra',
    startedAt: 1,
    cancelability: {
      state: 'cancelable',
      target: {
        kind: 'live_invocation',
        threadId: 'thread_private',
        catId: 'codex-astra',
        executionId: 'parent_exact',
      },
    },
  };
  expect(executionForPrivateRequest(request, [execution])).toBeUndefined();
  const exact = { ...execution, turnInvocationId: 'child_exact' };
  expect(executionForPrivateRequest(request, [exact])).toBe(exact);
  expect(executionForPrivateRequest({ ...request, execution: { stage: 'started' } }, [exact])).toBeUndefined();
  expect(executionForPrivateRequest({ ...request, privateThread: { id: 'another-thread' } }, [exact])).toBeUndefined();
  expect(executionForPrivateRequest(request, [{ ...exact, catId: 'another-cat' }])).toBeUndefined();
});
