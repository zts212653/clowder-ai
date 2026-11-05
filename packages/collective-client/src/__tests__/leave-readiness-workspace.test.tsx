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
import type { MembershipLeaveReadiness } from '../leave-readiness.js';
import type { useCollectiveClient } from '../use-collective-client.js';
import { snapshot as baseSnapshot, participant } from './first-entry-fixture.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();
  window.history.replaceState({}, '', '/?channelId=产品方向');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.restoreAllMocks();
});

const source: CollectiveEventEnvelope = {
  serviceInstanceId: participant.serviceInstanceId,
  collectiveId: participant.collectiveId,
  eventId: 'evt_leave_workspace',
  clientEventId: 'leave-workspace',
  sequence: 1,
  actor: { kind: 'human', humanId: participant.humanId, displayName: 'You' },
  target: { kind: 'channel', channelId: '产品方向' },
  location: { channelId: '产品方向' },
  recipient: { kind: 'channel' },
  body: '请完成离开前的责任。',
  acceptedAt: '2026-10-20T00:00:00.000Z',
};

const work: CollectiveWorkProjection = {
  v: 1,
  serviceInstanceId: participant.serviceInstanceId,
  collectiveId: participant.collectiveId,
  workId: 'work_leave_workspace',
  sourceEventId: source.eventId,
  sourceLocation: source.location as { channelId: string },
  title: '处理离开前责任',
  intendedOutcome: '回到项目计划里的精确任务。',
  proposedBy: { kind: 'human', humanId: participant.humanId, displayName: 'You' },
  accountableHumanId: participant.humanId,
  dependencyWorkIds: [],
  lifecycle: 'committed',
  status: 'ready',
  revision: 1,
  createdAt: source.acceptedAt,
  updatedAt: source.acceptedAt,
  history: [],
};

const project: CollectiveRoadmapRecord = {
  v: 1,
  serviceInstanceId: participant.serviceInstanceId,
  collectiveId: participant.collectiveId,
  roadmapId: 'roadmap_leave_workspace',
  sourceEventId: source.eventId,
  sourceLocation: { channelId: '产品方向' },
  title: '退出前交接',
  purpose: '把尚未完成的责任处理清楚。',
  accountableHumanId: participant.humanId,
  workIds: [work.workId],
  status: 'active',
  revision: 1,
  createdAt: source.acceptedAt,
  updatedAt: source.acceptedAt,
  history: [],
};

function readySnapshot(): ClientSnapshot {
  const collective = baseSnapshot.collective;
  const me = baseSnapshot.me;
  if (!collective || !me) throw new Error('Expected ready fixture');
  const memberCollective = { ...collective, name: '真实共同体', role: 'member' as const };
  return {
    ...baseSnapshot,
    collective: memberCollective,
    me: {
      ...me,
      collectives: [memberCollective],
    },
    events: [source],
    participants: [{ ...participant, channelIds: ['general', '产品方向'] }],
    members: {
      humans: [{ humanId: participant.humanId, displayName: 'You', role: 'member' }],
      cafes: baseSnapshot.members?.cafes ?? [],
    },
    collaboration: {
      serviceInstanceId: participant.serviceInstanceId,
      collectiveId: participant.collectiveId,
      works: [work],
      roadmaps: [project],
      votes: [],
      bindingVotes: [],
      decisions: [],
    },
  };
}

function leaveReadiness(): MembershipLeaveReadiness {
  return {
    serviceInstanceId: participant.serviceInstanceId,
    collectiveId: participant.collectiveId,
    role: 'member',
    membershipRevision: 1,
    governanceHandoffRequired: false,
    canLeave: false,
    responsibilities: {
      works: [
        {
          workId: work.workId,
          title: work.title,
          lifecycle: work.lifecycle,
          status: work.status,
          source: { eventId: work.sourceEventId, location: work.sourceLocation },
          projects: [
            {
              roadmapId: project.roadmapId,
              title: project.title,
              source: { eventId: project.sourceEventId, location: project.sourceLocation },
            },
          ],
        },
      ],
      roadmaps: [],
      artifacts: { items: [], inaccessibleCount: 0 },
    },
  };
}

function client(snapshot: ClientSnapshot) {
  return {
    snapshot,
    selectCollective: vi.fn(),
    createInvite: vi.fn(),
    pairHost: vi.fn(),
    readLeaveReadiness: vi.fn(async () => leaveReadiness()),
    leaveCollective: vi.fn(async () => undefined),
    sendMessage: vi.fn(),
    respondWorkAccountability: vi.fn(async () => undefined),
  } as unknown as ReturnType<typeof useCollectiveClient>;
}

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

it('opens the shared leave checklist from the real menu and returns to the exact project task row', async () => {
  const current = client(readySnapshot());
  await act(async () => root.render(<CollectiveWorkspace embedded={false} client={current} />));

  await act(async () => {
    button('离开共同体…').click();
    await Promise.resolve();
  });
  expect(container.querySelector('[aria-labelledby="leave-dialog-title"]')).not.toBeNull();
  expect(container.textContent).toContain('处理离开前责任');
  expect(current.readLeaveReadiness).toHaveBeenCalledOnce();

  await act(async () => button('去处理 ›').click());

  const row = container.querySelector(`[data-project-plan-work-id="${work.workId}"]`);
  expect(row).not.toBeNull();
  expect(row?.getAttribute('data-selected')).toBe('true');
  expect(new URL(window.location.href).searchParams.get('channelId')).toBe('产品方向');
  expect(container.querySelector('[aria-labelledby="leave-dialog-title"]')).toBeNull();
});
