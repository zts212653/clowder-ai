// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollectiveWorkspace } from '../CollectiveWorkspace.js';
import type {
  ClientSnapshot,
  CollectiveEventEnvelope,
  CollectiveRoadmapRecord,
  CollectiveWorkProjection,
} from '../client-types.js';
import { projectCollectiveHome } from '../collective-home-model.js';
import { firstEntryBrowseKey } from '../first-entry/first-entry-model.js';
import { collectiveClientNamespace } from '../human-send-custody.js';
import type { useCollectiveClient } from '../use-collective-client.js';
import { snapshot as baseSnapshot, participant } from './first-entry-fixture.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
  window.history.replaceState({}, '', '/');
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.restoreAllMocks();
});

const source: CollectiveEventEnvelope = {
  serviceInstanceId: participant.serviceInstanceId,
  collectiveId: participant.collectiveId,
  eventId: 'evt_home_source',
  clientEventId: 'home-source',
  sequence: 1,
  actor: { kind: 'human', humanId: participant.humanId, displayName: 'You' },
  target: { kind: 'channel', channelId: '产品方向' },
  location: { channelId: '产品方向' },
  recipient: { kind: 'channel' },
  body: '请把真实共同体首页接到公共工作记录。',
  acceptedAt: '2026-10-03T09:00:00.000Z',
};

it('exposes the shared work library in the normal channel without adding a private Host destination', async () => {
  window.history.replaceState({}, '', '/?channelId=产品方向');
  const existing = client(readySnapshot());
  const shared = {
    api: { list: vi.fn(async () => []) },
    catalogue: [],
    sourceMessage: () => undefined,
    status: 'ready',
    open: vi.fn(),
    close: vi.fn(),
    refresh: vi.fn(),
    beginPublication: vi.fn(),
  };
  await act(async () =>
    root.render(
      <CollectiveWorkspace
        embedded={false}
        client={{ ...existing, artifacts: shared } as unknown as ReturnType<typeof useCollectiveClient>}
      />,
    ),
  );
  const library = [...container.querySelectorAll('button')].find((button) => button.textContent?.startsWith('作品'));
  expect(library).toBeDefined();
  await act(async () => library?.click());
  expect(container.textContent).toContain('还没有共同作品');
});

const result: CollectiveEventEnvelope = {
  ...source,
  eventId: 'evt_home_result',
  clientEventId: 'home-result',
  sequence: 2,
  actor: {
    kind: 'agent',
    human: { humanId: participant.humanId, displayName: 'You' },
    agent: { agentId: participant.catId, displayName: participant.displayName },
    provenance: {
      connectionId: participant.connectionId,
      endpointId: participant.endpointId,
      endpointLabel: participant.endpointLabel,
      catId: participant.catId,
      sessionRef: 'test-home-result',
    },
  },
  target: { kind: 'message', eventId: source.eventId },
  location: { channelId: '产品方向', rootEventId: source.eventId },
  replyToEventId: source.eventId,
  body: '真实首页已经接通，并保留频道和深链接入口。',
  acceptedAt: '2026-10-03T09:20:00.000Z',
};

const resultWork: CollectiveWorkProjection = {
  v: 1,
  serviceInstanceId: participant.serviceInstanceId,
  collectiveId: participant.collectiveId,
  workId: 'work_home_result',
  sourceEventId: source.eventId,
  sourceLocation: { channelId: '产品方向' },
  title: '接通真实共同体首页',
  intendedOutcome: '从世界入口进入首页，具体目标仍直达原处。',
  proposedBy: { kind: 'human', humanId: participant.humanId, displayName: 'You' },
  accountableHumanId: participant.humanId,
  assignment: {
    humanId: participant.humanId,
    connectionId: participant.connectionId,
    catId: participant.catId,
    displayName: participant.displayName,
    participationRevision: participant.participationRevision,
    assignedAt: '2026-10-03T09:01:00.000Z',
  },
  assignmentEventId: 'evt_home_assign',
  dependencyWorkIds: [],
  lifecycle: 'result_ready',
  status: 'result_ready',
  resultEventId: result.eventId,
  resultRevision: 7,
  revision: 4,
  createdAt: '2026-10-03T09:00:00.000Z',
  updatedAt: result.acceptedAt,
  history: [
    {
      revision: 1,
      action: 'proposed',
      actor: { kind: 'human', humanId: participant.humanId, displayName: 'You' },
      at: source.acceptedAt,
      eventId: source.eventId,
    },
    {
      revision: 2,
      action: 'execution_authorized',
      actor: {
        kind: 'agent',
        humanId: participant.humanId,
        humanDisplayName: 'You',
        connectionId: participant.connectionId,
        catId: participant.catId,
        displayName: participant.displayName,
      },
      at: '2026-10-03T09:10:00.000Z',
      eventId: source.eventId,
    },
    {
      revision: 4,
      action: 'result_returned',
      actor: {
        kind: 'agent',
        humanId: participant.humanId,
        humanDisplayName: 'You',
        connectionId: participant.connectionId,
        catId: participant.catId,
        displayName: participant.displayName,
      },
      at: result.acceptedAt,
      eventId: result.eventId,
      resultRevision: 7,
    },
  ],
};

const inaccessibleResultWork: CollectiveWorkProjection = {
  ...resultWork,
  workId: 'work_hidden_result',
  resultEventId: 'evt_hidden_result',
  title: '不可读取的结果不应成为作品卡',
  updatedAt: '2026-10-03T09:21:00.000Z',
  history: [],
};

const responsibilityRequestId = 'accountability_home1234';
const responsibilityWork: CollectiveWorkProjection = {
  v: 1,
  serviceInstanceId: participant.serviceInstanceId,
  collectiveId: participant.collectiveId,
  workId: 'work_responsibility',
  sourceEventId: source.eventId,
  sourceLocation: { channelId: '产品方向' },
  title: '接下 Project Task',
  intendedOutcome: '受邀成员在原项目中明确接受或拒绝。',
  proposedBy: { kind: 'human', humanId: 'human_requester', displayName: 'Requester' },
  accountabilityRequests: [
    {
      accountabilityRequestId: responsibilityRequestId,
      roadmapId: 'roadmap_responsibility',
      targetHumanId: participant.humanId,
      targetDisplayName: 'You',
      requestedByHumanId: 'human_requester',
      requestedByDisplayName: 'Requester',
      requestEventId: 'evt_responsibility',
      requestedAt: '2026-10-03T09:02:00.000Z',
      status: 'pending',
    },
  ],
  dependencyWorkIds: [],
  lifecycle: 'committed',
  status: 'unassigned',
  revision: 2,
  createdAt: '2026-10-03T09:01:00.000Z',
  updatedAt: '2026-10-03T09:02:00.000Z',
  history: [],
};
const responsibilityProject: CollectiveRoadmapRecord = {
  v: 1,
  serviceInstanceId: participant.serviceInstanceId,
  collectiveId: participant.collectiveId,
  roadmapId: 'roadmap_responsibility',
  sourceEventId: source.eventId,
  sourceLocation: { channelId: '产品方向' },
  title: '责任交接项目',
  purpose: '每次责任变化都由本人确认。',
  accountableHumanId: 'human_requester',
  workIds: [responsibilityWork.workId],
  status: 'active',
  revision: 2,
  createdAt: '2026-10-03T09:00:00.000Z',
  updatedAt: '2026-10-03T09:02:00.000Z',
  history: [],
};

function readySnapshot(): ClientSnapshot {
  const collective = baseSnapshot.collective;
  const me = baseSnapshot.me;
  if (!collective || !me) throw new Error('Expected a ready first-entry fixture');
  return {
    ...baseSnapshot,
    collective: { ...collective, name: '猫咖共创组' },
    me: { ...me, collectives: [collective] },
    events: [source, result],
    participants: [{ ...participant, channelIds: ['general', '产品方向'] }],
    collaboration: {
      serviceInstanceId: participant.serviceInstanceId,
      collectiveId: participant.collectiveId,
      works: [resultWork, inaccessibleResultWork],
      roadmaps: [],
      votes: [],
      bindingVotes: [],
      decisions: [],
    },
  };
}

function client(snapshot: ClientSnapshot) {
  return {
    snapshot,
    selectCollective: vi.fn(),
    createInvite: vi.fn(),
    pairHost: vi.fn(),
    leaveCollective: vi.fn(),
    sendMessage: vi.fn(),
    respondWorkAccountability: vi.fn(async () => undefined),
  } as unknown as ReturnType<typeof useCollectiveClient>;
}

function markPairStarted(snapshot: ClientSnapshot) {
  const key = firstEntryBrowseKey({
    serviceInstanceId: snapshot.meta?.serviceInstanceId,
    collectiveId: snapshot.collective?.collectiveId,
    humanId: snapshot.me?.human.humanId,
  });
  if (!key) throw new Error('Expected a first-entry browse key');
  window.localStorage.setItem(key, 'yes');
  window.localStorage.setItem(`${key}:pair-started`, 'yes');
}

async function initializeHost() {
  const post = vi.spyOn(window.parent, 'postMessage');
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'http://localhost:3000',
        data: {
          type: 'collective:host-context-init',
          bridgeId: 'bridge_12345678',
          serviceInstanceId: participant.serviceInstanceId,
          collectiveId: participant.collectiveId,
          connectionId: participant.connectionId,
          humanId: participant.humanId,
          authorityStatus: 'connected',
        },
      }),
    );
  });
  return post.mock.calls.filter(([body]) => body.type === 'collective:client-context').at(-1)?.[0];
}

async function connectHost() {
  const context = await initializeHost();
  if (!context) throw new Error('Expected the current Host context');
  return context;
}

function expectProductTarget(snapshot: ClientSnapshot) {
  expect(new URL(window.location.href).searchParams.get('channelId')).toBe('产品方向');
  const namespace = collectiveClientNamespace(snapshot);
  expect(namespace).not.toBeUndefined();
  expect(window.localStorage.getItem(`collective-channel:${namespace}`)).toBe('产品方向');
}

it('does not present execution authorization as public work progress', () => {
  const projection = projectCollectiveHome([source, result], {
    serviceInstanceId: participant.serviceInstanceId,
    collectiveId: participant.collectiveId,
    works: [resultWork],
    roadmaps: [],
    votes: [],
    bindingVotes: [],
    decisions: [],
  });

  expect(projection.activities.map((activity) => activity.actionLabel)).not.toContain('继续推进');
});

it('opens the collective home without a concrete target and ignores the legacy saved channel', async () => {
  window.localStorage.setItem(
    `collective-channel:${participant.serviceInstanceId}:${participant.collectiveId}:${participant.humanId}`,
    '产品方向',
  );

  await act(async () => root.render(<CollectiveWorkspace embedded={false} client={client(readySnapshot())} />));

  const home = container.querySelector('[data-testid="collective-home"]');
  expect(home).not.toBeNull();
  expect(home?.textContent).toContain('猫咖共创组');
  expect(home?.textContent).toContain('最近动态');
  expect(home?.textContent).toContain('最近作品');
  expect(home?.textContent).toContain('接通真实共同体首页');
  expect(home?.textContent).not.toContain('第 7 轮');
  expect(home?.querySelectorAll('[data-testid="collective-home-work"]')).toHaveLength(0);
  expect(home?.textContent).toContain('作品列表还没有可靠的公开来源');
  expect(home?.textContent).not.toContain(result.body);
  expect(home?.textContent).not.toContain('继续推进');
  expect(home?.textContent).not.toContain('不可读取的结果不应成为作品卡');
  expect(home?.textContent).toContain('只显示当前有权打开的公共记录');
});

it('opens the destination navigation from the collective home on narrow screens', async () => {
  await act(async () => root.render(<CollectiveWorkspace embedded={false} client={client(readySnapshot())} />));

  const navigation = container.querySelector<HTMLButtonElement>('[data-testid="collective-home-navigation"]');
  expect(navigation).not.toBeNull();
  expect(
    container.querySelector('[data-testid="collective-product-shell"]')?.getAttribute('data-navigation-open'),
  ).toBe('false');

  await act(async () => navigation?.click());

  expect(
    container.querySelector('[data-testid="collective-product-shell"]')?.getAttribute('data-navigation-open'),
  ).toBe('true');
});

it('keeps a concrete channel target direct and returns home through the collective title', async () => {
  window.history.replaceState({}, '', '/?channelId=%E4%BA%A7%E5%93%81%E6%96%B9%E5%90%91');
  await act(async () => root.render(<CollectiveWorkspace embedded={false} client={client(readySnapshot())} />));

  expect(container.querySelector('[data-testid="collective-home"]')).toBeNull();
  expect(container.querySelector('[aria-label="# 产品方向"]')).not.toBeNull();

  const homeButton = container.querySelector<HTMLButtonElement>('[aria-label="打开猫咖共创组首页"]');
  expect(homeButton).not.toBeNull();
  await act(async () => homeButton?.click());
  expect(container.querySelector('[data-testid="collective-home"]')).not.toBeNull();
  expect(new URL(window.location.href).searchParams.has('channelId')).toBe(false);
});

it('opens a channel from a home receipt and records a reloadable channel target', async () => {
  await act(async () => root.render(<CollectiveWorkspace embedded={false} client={client(readySnapshot())} />));
  const activity = container.querySelector<HTMLButtonElement>('[data-testid="collective-home-activity"]');
  expect(activity).not.toBeNull();

  await act(async () => activity?.click());

  expect(container.querySelector('[aria-label="# 产品方向"]')).not.toBeNull();
  expect(new URL(window.location.href).searchParams.get('channelId')).toBe('产品方向');
});

it('leaves the home through an explicit channel destination', async () => {
  await act(async () => root.render(<CollectiveWorkspace embedded={false} client={client(readySnapshot())} />));
  expect(container.querySelector('[data-testid="collective-home"]')).not.toBeNull();

  const productChannel = [...container.querySelectorAll<HTMLButtonElement>('.channel-destination')].find((button) =>
    button.textContent?.includes('产品方向'),
  );
  expect(productChannel).not.toBeUndefined();
  await act(async () => productChannel?.click());

  expect(container.querySelector('[data-testid="collective-home"]')).toBeNull();
  expect(container.querySelector('[aria-label="# 产品方向"]')).not.toBeNull();
  expect(new URL(window.location.href).searchParams.get('channelId')).toBe('产品方向');
});

it('returns home when the active world is chosen without switching worlds', async () => {
  window.history.replaceState({}, '', '/?channelId=%E4%BA%A7%E5%93%81%E6%96%B9%E5%90%91');
  const currentClient = client(readySnapshot());
  await act(async () => root.render(<CollectiveWorkspace embedded={false} client={currentClient} />));
  expect(container.querySelector('[data-testid="collective-home"]')).toBeNull();

  const activeWorld = container.querySelector<HTMLButtonElement>('.rail-button[aria-current="page"]');
  expect(activeWorld).not.toBeNull();
  await act(async () => activeWorld?.click());

  expect(container.querySelector('[data-testid="collective-home"]')).not.toBeNull();
  expect(new URL(window.location.href).searchParams.has('channelId')).toBe(false);
  expect(currentClient.selectCollective).not.toHaveBeenCalled();
});

it('does not carry a channel destination into a newly selected collective', async () => {
  window.history.replaceState({}, '', '/?channelId=%E4%BA%A7%E5%93%81%E6%96%B9%E5%90%91');
  const firstSnapshot = readySnapshot();
  const firstCollective = firstSnapshot.collective;
  const firstMe = firstSnapshot.me;
  if (!firstCollective || !firstMe) throw new Error('Expected a ready Collective snapshot');
  await act(async () => root.render(<CollectiveWorkspace embedded={false} client={client(firstSnapshot)} />));
  expect(container.querySelector('[aria-label="# 产品方向"]')).not.toBeNull();

  const secondCollective = {
    ...firstCollective,
    collectiveId: 'col_secondhome',
    name: '另一座共同体',
  };
  window.history.replaceState({}, '', '/?collectiveId=col_secondhome');
  await act(async () =>
    root.render(
      <CollectiveWorkspace
        embedded={false}
        client={client({
          ...firstSnapshot,
          collective: secondCollective,
          me: { ...firstMe, collectives: [firstCollective, secondCollective] },
          events: [],
          collaboration: undefined,
        })}
      />,
    ),
  );

  expect(container.querySelector('[data-testid="collective-home"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="# 产品方向"]')).toBeNull();
  const secondNamespace = collectiveClientNamespace({ ...firstSnapshot, collective: secondCollective });
  expect(secondNamespace).not.toBeUndefined();
  expect(window.localStorage.getItem(`collective-channel:${secondNamespace}`)).toBe('general');
});

it('lets an exact Host Work focus bypass the home and land on its public result', async () => {
  window.history.replaceState({}, '', '/?hostOrigin=http%3A%2F%2Flocalhost%3A3000');
  const post = vi.spyOn(window.parent, 'postMessage');
  await act(async () => root.render(<CollectiveWorkspace embedded client={client(readySnapshot())} />));
  expect(container.querySelector('[data-testid="collective-home"]')).not.toBeNull();

  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'http://localhost:3000',
        data: {
          type: 'collective:host-context-init',
          bridgeId: 'bridge_12345678',
          serviceInstanceId: participant.serviceInstanceId,
          collectiveId: participant.collectiveId,
          connectionId: participant.connectionId,
          humanId: participant.humanId,
          authorityStatus: 'connected',
        },
      }),
    );
  });
  const context = post.mock.calls.filter(([body]) => body.type === 'collective:client-context').at(-1)?.[0];
  if (!context) throw new Error('Expected the current Host context');

  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'http://localhost:3000',
        data: {
          type: 'collective:host-focus-work',
          bridgeId: context.bridgeId,
          contextId: context.contextId,
          contextRevision: context.revision,
          workId: resultWork.workId,
          workRevision: resultWork.revision,
          channelId: '产品方向',
          resultEventId: result.eventId,
          resultRevision: resultWork.resultRevision,
        },
      }),
    );
  });

  expect(container.querySelector('[data-testid="collective-home"]')).toBeNull();
  expect(container.textContent).toContain(result.body);
  expect(new URL(window.location.href).searchParams.get('channelId')).toBe('产品方向');
});

it('lands a responsibility link on the exact Project Task and its target-Human actions', async () => {
  window.history.replaceState({}, '', '/?hostOrigin=http%3A%2F%2Flocalhost%3A3000');
  const base = readySnapshot();
  const snapshot: ClientSnapshot = {
    ...base,
    collaboration: base.collaboration
      ? { ...base.collaboration, works: [responsibilityWork], roadmaps: [responsibilityProject] }
      : undefined,
  };
  const post = vi.spyOn(window.parent, 'postMessage');
  await act(async () => root.render(<CollectiveWorkspace embedded client={client(snapshot)} />));
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'http://localhost:3000',
        data: {
          type: 'collective:host-context-init',
          bridgeId: 'bridge_12345678',
          serviceInstanceId: participant.serviceInstanceId,
          collectiveId: participant.collectiveId,
          connectionId: participant.connectionId,
          humanId: participant.humanId,
          authorityStatus: 'connected',
        },
      }),
    );
  });
  const context = post.mock.calls.filter(([body]) => body.type === 'collective:client-context').at(-1)?.[0];
  if (!context) throw new Error('Expected the current Host context');
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'http://localhost:3000',
        data: {
          type: 'collective:host-focus-project-work',
          bridgeId: context.bridgeId,
          contextId: context.contextId,
          contextRevision: context.revision,
          workId: responsibilityWork.workId,
          workRevision: responsibilityWork.revision,
          channelId: '产品方向',
          roadmapId: responsibilityProject.roadmapId,
          accountabilityRequestId: responsibilityRequestId,
        },
      }),
    );
  });

  expect(container.querySelector('[data-testid="collective-home"]')).toBeNull();
  expect(container.querySelector('[aria-label="项目 · 责任交接项目"]')).not.toBeNull();
  expect(container.textContent).toContain(responsibilityWork.title);
  expect(container.textContent).toContain('接受负责');
  expect(container.textContent).toContain('暂不接受');
  expect(new URL(window.location.href).searchParams.get('channelId')).toBe('产品方向');
});

it.each([
  ['loading', undefined],
  ['empty', []],
] as const)('keeps an explicit channel while Host participation is %s', async (_phase, participants) => {
  window.history.replaceState(
    {},
    '',
    '/?hostOrigin=http%3A%2F%2Flocalhost%3A3000&channelId=%E4%BA%A7%E5%93%81%E6%96%B9%E5%90%91',
  );
  const snapshot = { ...readySnapshot(), participants };
  await act(async () => root.render(<CollectiveWorkspace embedded client={client(snapshot)} />));

  await initializeHost();

  expectProductTarget(snapshot);
});

it('keeps an explicit channel when a persisted first-entry guide starts late', async () => {
  window.history.replaceState(
    {},
    '',
    '/?hostOrigin=http%3A%2F%2Flocalhost%3A3000&channelId=%E4%BA%A7%E5%93%81%E6%96%B9%E5%90%91',
  );
  const snapshot = readySnapshot();
  markPairStarted(snapshot);
  await act(async () => root.render(<CollectiveWorkspace embedded client={client(snapshot)} />));

  await connectHost();

  expectProductTarget(snapshot);
});

it('keeps an exact Host Work focus when the first-entry guide starts after participation loads', async () => {
  window.history.replaceState(
    {},
    '',
    '/?hostOrigin=http%3A%2F%2Flocalhost%3A3000&channelId=%E4%BA%A7%E5%93%81%E6%96%B9%E5%90%91',
  );
  const pending = { ...readySnapshot(), participants: [] };
  markPairStarted(pending);
  await act(async () => root.render(<CollectiveWorkspace embedded client={client(pending)} />));
  const context = await connectHost();

  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window.parent,
        origin: 'http://localhost:3000',
        data: {
          type: 'collective:host-focus-work',
          bridgeId: context.bridgeId,
          contextId: context.contextId,
          contextRevision: context.revision,
          workId: resultWork.workId,
          workRevision: resultWork.revision,
          channelId: '产品方向',
          resultEventId: result.eventId,
          resultRevision: resultWork.resultRevision,
        },
      }),
    );
  });
  expectProductTarget(pending);

  const loaded = readySnapshot();
  await act(async () => root.render(<CollectiveWorkspace embedded client={client(loaded)} />));

  expect(container.textContent).toContain(result.body);
  expectProductTarget(loaded);
});

it.each([
  '我的猫…',
  '已允许的任务…',
  '我的日程…',
  '重新连接…',
])('closes channel navigation when entering %s from its collective menu', async (label) => {
  window.history.replaceState({}, '', '/?channelId=产品方向&hostOrigin=http%3A%2F%2Flocalhost%3A3000');
  const snapshot = readySnapshot();
  markPairStarted(snapshot);
  await act(async () => root.render(<CollectiveWorkspace embedded client={client(snapshot)} />));
  await connectHost();
  await act(async () => container.querySelector<HTMLButtonElement>('.mobile-navigation')?.click());
  expect(container.querySelector('.collective-shell')?.getAttribute('data-navigation-open')).toBe('true');
  const action = [...container.querySelectorAll<HTMLButtonElement>('.collective-menu button')].find((button) =>
    button.textContent?.startsWith(label),
  );
  expect(action).toBeDefined();
  await act(async () => action?.click());
  expect(container.querySelector('.collective-shell')?.getAttribute('data-navigation-open')).toBe('false');
  if (label === '我的猫…') expect(container.querySelector('.members-page [data-host-ui-slot="roster"]')).not.toBeNull();
});

it('opens the one member destination for a current Host request and rejects foreign or stale requests', async () => {
  window.history.replaceState({}, '', '/?channelId=产品方向&hostOrigin=http%3A%2F%2Flocalhost%3A3000');
  const snapshot = readySnapshot();
  markPairStarted(snapshot);
  await act(async () => root.render(<CollectiveWorkspace embedded client={client(snapshot)} />));
  const context = await connectHost();
  const data = {
    type: 'collective:host-member-list-open',
    bridgeId: context.bridgeId,
    contextId: context.contextId,
    revision: context.revision,
  };
  const send = (message = data, origin = 'http://localhost:3000') =>
    act(async () =>
      window.dispatchEvent(new MessageEvent('message', { data: message, origin, source: window.parent })),
    );
  await send(data, 'https://foreign.example');
  await send({ ...data, revision: data.revision + 1 });
  expect(container.querySelector('.members-page')).toBeNull();
  await send();
  expect(container.querySelector('.members-page [data-host-ui-slot="roster"]')).not.toBeNull();
});

it('removes the covered channel from interaction while the full member page is open and restores the channel on return', async () => {
  window.history.replaceState({}, '', '/?channelId=产品方向');
  const snapshot = readySnapshot();
  await act(async () => root.render(<CollectiveWorkspace embedded={false} client={client(snapshot)} />));
  const scene = container.querySelector<HTMLElement>('.channel-scene');
  expect(scene?.hidden).toBe(false);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="查看成员"]')?.click());
  expect(container.querySelector('.members-page')).not.toBeNull();
  expect(scene?.hidden).toBe(true);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="关闭成员资料"]')?.click());
  expect(scene?.hidden).toBe(false);
  expect(container.querySelector('.members-page')).toBeNull();
});
