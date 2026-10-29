// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollectiveWorkspace } from '../CollectiveWorkspace.js';
import type { ClientSnapshot, CollectiveEventEnvelope, CollectiveWorkProjection } from '../client-types.js';
import type { useCollectiveClient } from '../use-collective-client.js';
import { snapshot as baseSnapshot, participant } from './first-entry-fixture.js';

const channelId = '产品方向';
const rootEvent: CollectiveEventEnvelope = {
  serviceInstanceId: participant.serviceInstanceId,
  collectiveId: participant.collectiveId,
  eventId: 'evt_topic_root',
  clientEventId: 'topic-root',
  sequence: 1,
  actor: { kind: 'human', humanId: participant.humanId, displayName: 'You' },
  target: { kind: 'channel', channelId },
  location: { channelId },
  recipient: { kind: 'channel' },
  body: '这条根消息有一个持续讨论的话题。',
  acceptedAt: '2026-10-29T06:00:00.000Z',
};
const replies = [
  {
    ...rootEvent,
    eventId: 'evt_topic_reply_1',
    clientEventId: 'topic-reply-1',
    sequence: 2,
    target: { kind: 'message', eventId: rootEvent.eventId },
    location: { channelId, rootEventId: rootEvent.eventId },
    replyToEventId: rootEvent.eventId,
    body: '第一条回复。',
    acceptedAt: '2026-10-29T06:01:00.000Z',
  },
  {
    ...rootEvent,
    eventId: 'evt_topic_reply_2',
    clientEventId: 'topic-reply-2',
    sequence: 3,
    target: { kind: 'message', eventId: rootEvent.eventId },
    location: { channelId, rootEventId: rootEvent.eventId },
    replyToEventId: rootEvent.eventId,
    body: '第二条回复。',
    acceptedAt: '2026-10-29T06:02:00.000Z',
  },
] satisfies readonly [CollectiveEventEnvelope, CollectiveEventEnvelope];

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

function snapshot(activityEventId: string, refresh = 0): ClientSnapshot {
  const collective = baseSnapshot.collective;
  const me = baseSnapshot.me;
  if (!collective || !me) throw new Error('Expected a ready first-entry fixture');
  const events = [rootEvent, ...replies].map((event) => ({ ...event }));
  const work: CollectiveWorkProjection = {
    v: 1,
    serviceInstanceId: participant.serviceInstanceId,
    collectiveId: participant.collectiveId,
    workId: 'work_topic_focus',
    sourceEventId: rootEvent.eventId,
    sourceLocation: { channelId },
    title: `话题刷新保护 ${refresh}`,
    intendedOutcome: '刷新公共事件时不覆盖人刚刚打开的话题。',
    proposedBy: { kind: 'human', humanId: participant.humanId, displayName: 'You' },
    accountableHumanId: participant.humanId,
    dependencyWorkIds: [],
    lifecycle: 'committed',
    status: 'unassigned',
    revision: 1,
    createdAt: rootEvent.acceptedAt,
    updatedAt: replies[1].acceptedAt,
    history: [
      {
        revision: 1,
        action: 'proposed',
        actor: { kind: 'human', humanId: participant.humanId, displayName: 'You' },
        at: rootEvent.acceptedAt,
        eventId: activityEventId,
      },
    ],
  };
  return {
    ...baseSnapshot,
    collective: { ...collective, name: '猫咖共创组' },
    me: { ...me, collectives: [collective] },
    events,
    participants: [{ ...participant, channelIds: ['general', channelId] }],
    collaboration: {
      serviceInstanceId: participant.serviceInstanceId,
      collectiveId: participant.collectiveId,
      works: [work],
      roadmaps: [],
      votes: [],
      bindingVotes: [],
      decisions: [],
    },
  };
}

function client(current: ClientSnapshot) {
  const asyncAction = vi.fn(async () => undefined);
  return {
    snapshot: current,
    switchAccount: vi.fn(),
    selectCollective: vi.fn(),
    createInvite: vi.fn(),
    pairHost: vi.fn(),
    leaveCollective: vi.fn(),
    sendMessage: asyncAction,
    proposeWork: asyncAction,
    commitWork: asyncAction,
    declineWork: asyncAction,
    acceptWorkResult: asyncAction,
    requestWorkRevision: asyncAction,
    completeWork: asyncAction,
    createRoadmap: asyncAction,
    setRoadmapWorks: asyncAction,
    setRoadmapStatus: asyncAction,
    createVote: asyncAction,
    castVote: asyncAction,
    closeVote: asyncAction,
    createBindingVote: asyncAction,
    castBindingVote: asyncAction,
    withdrawBindingVote: asyncAction,
    settleBindingVote: asyncAction,
    setWorkDependencies: asyncAction,
    setReaction: asyncAction,
    respondWorkAccountability: asyncAction,
  } as unknown as ReturnType<typeof useCollectiveClient>;
}

async function render(current: ClientSnapshot) {
  await act(async () => root.render(<CollectiveWorkspace embedded={false} client={client(current)} />));
}

async function openHomeActivity() {
  const activity = container.querySelector<HTMLButtonElement>('[data-testid="collective-home-activity"]');
  if (!activity) throw new Error('Expected one home activity');
  await act(async () => activity.click());
}

it('keeps a Human-opened Topic when the root-message focus survives a later event refresh', async () => {
  await render(snapshot(rootEvent.eventId));
  await openHomeActivity();
  const repliesButton = container.querySelector<HTMLButtonElement>('.reply-vitals');
  expect(repliesButton?.textContent).toContain('2 条回复');

  await act(async () => repliesButton?.click());
  expect(container.querySelector('[aria-label="话题"]')).not.toBeNull();

  await render(snapshot(rootEvent.eventId, 1));

  expect(container.querySelector('[aria-label="话题"]')).not.toBeNull();
});

it('still opens the owning Topic when the initial navigation focus points at a reply', async () => {
  await render(snapshot(replies[1].eventId));
  await openHomeActivity();

  expect(container.querySelector('[aria-label="话题"]')).not.toBeNull();
  expect(container.querySelector('[data-event-id="evt_topic_reply_2"]')?.getAttribute('data-highlighted')).toBe('true');
});
