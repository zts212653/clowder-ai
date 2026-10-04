// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollectiveWorkspace } from '../CollectiveWorkspace.js';
import type { ClientSnapshot } from '../client-types.js';
import type { useCollectiveClient } from '../use-collective-client.js';
import { useHostContext } from '../use-host-context.js';

const connectionId = 'con_12345678';
const completedWork = {
  v: 1 as const,
  serviceInstanceId: 'svc_12345678',
  collectiveId: 'col_12345678',
  workId: 'work_12345678',
  sourceEventId: 'evt_source12345',
  sourceLocation: { channelId: 'general' },
  title: 'Return the real result',
  intendedOutcome: 'Return the real result',
  proposedBy: { kind: 'human' as const, humanId: 'human_12345678', displayName: 'You' },
  accountableHumanId: 'human_12345678',
  assignment: {
    humanId: 'human_12345678',
    connectionId,
    catId: 'codex-sol',
    displayName: 'Sol',
    participationRevision: 1,
    assignedAt: '2026-09-13T00:00:00.000Z',
  },
  assignmentEventId: 'evt_assignment123',
  dependencyWorkIds: [],
  lifecycle: 'completed' as const,
  resultEventId: 'evt_result12345',
  resultRevision: 2,
  revision: 4,
  createdAt: '2026-09-13T00:00:00.000Z',
  updatedAt: '2026-09-13T00:01:00.000Z',
  history: [],
  status: 'completed' as const,
};
const snapshot: ClientSnapshot = {
  phase: 'ready',
  meta: {
    serviceInstanceId: completedWork.serviceInstanceId,
    bootstrapNeeded: false,
    onboardingComplete: true,
    clientBuildId: 'test',
  },
  me: {
    human: { humanId: 'human_12345678', displayName: 'You', createdAt: '2026-09-13T00:00:00.000Z' },
    auth: { provider: 'github', handle: 'operator' },
    collectives: [],
  },
  collective: {
    collectiveId: completedWork.collectiveId,
    name: 'Together',
    createdByHumanId: 'human_12345678',
    createdAt: '2026-09-13T00:00:00.000Z',
    role: 'steward',
  },
  providers: [],
  events: [],
  collaboration: {
    serviceInstanceId: completedWork.serviceInstanceId,
    collectiveId: completedWork.collectiveId,
    works: [completedWork],
    roadmaps: [],
    votes: [],
    bindingVotes: [],
    decisions: [],
  },
  participants: [],
  members: { humans: [], cafes: [] },
  connection: 'online',
  delivery: { kind: 'idle' },
};

function Harness({ value = snapshot }: { value?: ClientSnapshot }) {
  const host = useHostContext(true, value, 'general', ['general']);
  return (
    <output
      data-testid="focused-work"
      data-focus={host.focusWork ? JSON.stringify(host.focusWork) : ''}
      data-open={String(host.open)}
    />
  );
}

function ProjectionHarness({
  value,
  channelIds,
}: {
  value: ClientSnapshot;
  channelIds: readonly [string, ...string[]];
}) {
  const host = useHostContext(true, value, channelIds[0], channelIds);
  return (
    <output data-testid="projection-host" data-available={String(host.available)} data-paired={String(host.paired)} />
  );
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  window.history.replaceState({}, '', '/?hostOrigin=http%3A%2F%2Flocalhost%3A3000');
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.history.replaceState({}, '', '/');
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('keeps Host management available while a revoked connection is unpaired', async () => {
  await act(async () => root.render(<ProjectionHarness value={snapshot} channelIds={['general']} />));
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'http://localhost:3000',
        data: {
          type: 'collective:host-context-init',
          bridgeId: 'bridge_12345678',
          serviceInstanceId: completedWork.serviceInstanceId,
          collectiveId: completedWork.collectiveId,
          connectionId,
          humanId: 'human_12345678',
          authorityStatus: 'revoked',
        },
      }),
    );
  });
  const host = container.querySelector('[data-testid="projection-host"]');
  expect(host?.getAttribute('data-available')).toBe('true');
  expect(host?.getAttribute('data-paired')).toBe('false');
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'http://localhost:3000',
        data: {
          type: 'collective:host-context-init',
          bridgeId: 'bridge_repaired1',
          serviceInstanceId: completedWork.serviceInstanceId,
          collectiveId: completedWork.collectiveId,
          connectionId,
          humanId: 'human_12345678',
          authorityStatus: 'connected',
        },
      }),
    );
  });
  expect(host?.getAttribute('data-paired')).toBe('true');
});

it('offers re-pair from the actual workspace when its sole Host connection was revoked', async () => {
  const client = {
    snapshot: { ...snapshot, collaboration: { ...snapshot.collaboration, works: [] } },
    selectCollective: vi.fn(),
    createInvite: vi.fn(),
    pairHost: vi.fn(),
    leaveCollective: vi.fn(),
    sendMessage: vi.fn(),
  } as unknown as ReturnType<typeof useCollectiveClient>;
  await act(async () => root.render(<CollectiveWorkspace embedded client={client} />));
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'http://localhost:3000',
        data: {
          type: 'collective:host-context-init',
          bridgeId: 'bridge_12345678',
          serviceInstanceId: completedWork.serviceInstanceId,
          collectiveId: completedWork.collectiveId,
          connectionId,
          humanId: 'human_12345678',
          authorityStatus: 'revoked',
        },
      }),
    );
  });

  expect(container.textContent).toContain('连接此 Café');
  expect(container.textContent).toContain('共同家园在线 · 这台 Café 还没连接');
  expect(container.textContent).not.toContain('这台 Café 已连接');
});

it('replays exact completed Work evidence to its assigned Host bridge and omits private Task data', async () => {
  vi.useFakeTimers();
  const post = vi.spyOn(window.parent, 'postMessage');
  await act(async () => root.render(<Harness />));
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'http://localhost:3000',
        data: {
          type: 'collective:host-context-init',
          bridgeId: 'bridge_12345678',
          serviceInstanceId: completedWork.serviceInstanceId,
          collectiveId: completedWork.collectiveId,
          connectionId,
          humanId: 'human_12345678',
        },
      }),
    );
  });
  const notice = post.mock.calls.find(([body]) => body.type === 'collective:client-work-result-accepted')?.[0];
  if (!notice) throw new Error('Client did not publish accepted Work evidence');
  expect(notice).toMatchObject({
    bridgeId: 'bridge_12345678',
    serviceInstanceId: completedWork.serviceInstanceId,
    collectiveId: completedWork.collectiveId,
    connectionId,
    workId: completedWork.workId,
    workRevision: completedWork.revision,
    assignmentEventId: completedWork.assignmentEventId,
    resultEventId: completedWork.resultEventId,
    resultRevision: completedWork.resultRevision,
  });
  expect(JSON.stringify(notice)).not.toContain('task');
  const noticeCount = () =>
    post.mock.calls.filter(([body]) => body.type === 'collective:client-work-result-accepted').length;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(noticeCount()).toBe(2);
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'http://localhost:3000',
        data: {
          type: 'collective:host-work-result-reconciled',
          bridgeId: 'bridge_12345678',
          contextId: notice.contextId,
          contextRevision: notice.contextRevision,
          workId: completedWork.workId,
          workRevision: completedWork.revision,
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(noticeCount()).toBe(2);
});

it('accepts an exact result-ready Work focus only on the current bridge and public revision', async () => {
  const readyWork = { ...completedWork, lifecycle: 'result_ready' as const, status: 'result_ready' as const };
  const value = {
    ...snapshot,
    collaboration: snapshot.collaboration ? { ...snapshot.collaboration, works: [] } : undefined,
  };
  const post = vi.spyOn(window.parent, 'postMessage');
  await act(async () => root.render(<Harness value={value} />));
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'http://localhost:3000',
        data: {
          type: 'collective:host-context-init',
          bridgeId: 'bridge_12345678',
          serviceInstanceId: readyWork.serviceInstanceId,
          collectiveId: readyWork.collectiveId,
          connectionId,
          humanId: 'human_12345678',
        },
      }),
    );
  });
  const context = post.mock.calls.find(([body]) => body.type === 'collective:client-context')?.[0];
  if (!context) throw new Error('Client did not publish its current Host context');
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'http://localhost:3000',
        data: {
          type: 'collective:host-context-open',
          bridgeId: context.bridgeId,
          contextId: context.contextId,
          revision: context.revision,
        },
      }),
    );
  });
  expect(container.querySelector('[data-testid="focused-work"]')?.getAttribute('data-open')).toBe('true');
  const contextReadyCount = () => post.mock.calls.filter(([body]) => body.type === 'collective:context-ready').length;
  const readyBeforeRefresh = contextReadyCount();
  const currentContext = post.mock.calls.filter(([body]) => body.type === 'collective:client-context').at(-1)?.[0];
  if (!currentContext) throw new Error('Client lost its current Host context before Work focus');
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'http://localhost:3000',
        data: {
          type: 'collective:host-focus-work',
          bridgeId: 'bridge_12345678',
          contextId: currentContext.contextId,
          contextRevision: currentContext.revision,
          workId: readyWork.workId,
          workRevision: readyWork.revision,
          channelId: readyWork.sourceLocation.channelId,
          resultEventId: readyWork.resultEventId,
          resultRevision: readyWork.resultRevision,
        },
      }),
    );
  });
  expect(container.querySelector('[data-testid="focused-work"]')?.getAttribute('data-focus')).toBe('');
  await act(async () =>
    root.render(
      <Harness
        value={{
          ...value,
          collaboration: value.collaboration ? { ...value.collaboration, works: [{ ...readyWork }] } : undefined,
        }}
      />,
    ),
  );
  expect(container.querySelector('[data-testid="focused-work"]')?.getAttribute('data-open')).toBe('true');
  expect(contextReadyCount()).toBe(readyBeforeRefresh);
  expect(container.querySelector('[data-testid="focused-work"]')?.getAttribute('data-focus')).toBe(
    JSON.stringify({
      workId: readyWork.workId,
      channelId: readyWork.sourceLocation.channelId,
      eventId: readyWork.resultEventId,
    }),
  );
});

it('publishes Host channel scope only after the current Collective projection finishes its first read', async () => {
  const post = vi.spyOn(window.parent, 'postMessage');
  const loading: ClientSnapshot = {
    ...snapshot,
    participants: undefined,
    members: undefined,
    collaboration: undefined,
  };
  await act(async () => root.render(<ProjectionHarness value={loading} channelIds={['general']} />));
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'http://localhost:3000',
        data: {
          type: 'collective:host-context-init',
          bridgeId: 'bridge_12345678',
          serviceInstanceId: completedWork.serviceInstanceId,
          collectiveId: completedWork.collectiveId,
          connectionId,
          humanId: 'human_12345678',
        },
      }),
    );
  });
  expect(post.mock.calls.filter(([body]) => body.type === 'collective:client-context')).toHaveLength(0);

  const loaded: ClientSnapshot = {
    ...snapshot,
    members: { humans: [], cafes: [] },
  };
  await act(async () => root.render(<ProjectionHarness value={loaded} channelIds={['general', 'workshop']} />));
  const contexts = post.mock.calls.filter(([body]) => body.type === 'collective:client-context');
  expect(contexts).toHaveLength(1);
  expect(contexts[0]?.[0]).toMatchObject({
    channelId: 'general',
    channelIds: ['general', 'workshop'],
  });
});
