// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollectiveWorkCard } from '../CollectiveWorkCard.js';
import type { CollectiveWorkProjection } from '../client-types.js';
import { RoadmapWorkDetails } from '../RoadmapWorkDetails.js';
import { RoadmapWorkNode } from '../RoadmapWorkNode.js';
import { participant, roadmap, work } from './collaboration-cards.fixture.js';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function assignedWork(
  lifecycle: 'committed' | 'in_progress',
  status: CollectiveWorkProjection['status'],
  admission?: 'admitted' | 'rejected',
  reason = 'WORK_DELEGATION_UNAVAILABLE',
): CollectiveWorkProjection & { acceptance: NonNullable<CollectiveWorkProjection['acceptance']> } {
  const acceptance = {
    v: 1 as const,
    workId: work.workId,
    sourceEventId: work.sourceEventId,
    operationRef: 'accept-review',
    grantRef: 'owner-grant',
    grantRevision: 1,
    requestKind: 'guide',
    hostAdmission: {
      state: 'admitted' as const,
      issuer: 'host' as const,
      receiptRef: 'host-admission:first',
      at: work.createdAt,
    },
  };
  return {
    ...work,
    lifecycle,
    status,
    acceptance,
    accountableHumanId: participant.humanId,
    assignmentEventId: 'evt_assignment',
    assignment: {
      humanId: participant.humanId,
      connectionId: participant.connectionId,
      catId: participant.catId,
      displayName: participant.displayName,
      participationRevision: 1,
      assignedAt: work.createdAt,
    },
    executionAuthority: {
      ...acceptance,
      revision: 2,
      assignmentEventId: 'evt_assignment',
      eventId: 'evt_execution',
      participationRevision: 1,
      resultRevision: 1,
      hostAdmission: admission
        ? { state: admission, issuer: 'host', receiptRef: 'host-admission:current', reason, at: work.createdAt }
        : undefined,
    },
  };
}

async function renderWorkCard(current: CollectiveWorkProjection) {
  await act(async () =>
    root.render(
      <CollectiveWorkCard
        work={current}
        works={[current]}
        currentHumanId={participant.humanId}
        sourceOwnerHumanId={participant.humanId}
        canSteward={false}
        participants={[participant]}
        humanNames={{ [participant.humanId]: 'You' }}
        onCommit={vi.fn()}
        onDecline={vi.fn()}
        onAcceptResult={vi.fn()}
        onComplete={vi.fn()}
      />,
    ),
  );
}

async function renderRoadmap(current: CollectiveWorkProjection) {
  await act(async () =>
    root.render(
      <>
        <RoadmapWorkNode
          work={current}
          humanNames={{ [participant.humanId]: 'You' }}
          selected={false}
          onSelect={vi.fn()}
        />
        <RoadmapWorkDetails
          work={current}
          works={[current]}
          view={{ roadmapId: roadmap.roadmapId, lens: 'stage', presentation: 'graph', scope: 'focus' }}
          currentHumanId={participant.humanId}
          humanNames={{ [participant.humanId]: 'You' }}
          canEditDependencies={false}
          onSetDependencies={vi.fn()}
          onClose={vi.fn()}
        />
      </>,
    ),
  );
}

it.each([
  ['committed', 'ready', '可以开始'],
  ['in_progress', 'in_progress', '推进中'],
  ['committed', 'blocked', '等待前置工作'],
  ['in_progress', 'blocked', '等待前置工作'],
] as const)('REVIEW: %s/%s rejected Host admission preserves acceptance without claiming execution', async (lifecycle, status, misleading) => {
  await renderWorkCard(assignedWork(lifecycle, status, 'rejected'));
  expect(container.textContent).not.toContain(misleading);
  expect(container.textContent).not.toContain(`${participant.displayName} 推进`);
  expect(container.textContent).toContain('未获准执行');
  expect(container.textContent).toContain('主人委托已失效或撤回');
  expect(container.textContent).toContain(`${participant.displayName} 已接下 · You 负责`);
});

it.each([
  ['committed', 'ready'],
  ['in_progress', 'in_progress'],
  ['committed', 'blocked'],
] as const)('keeps %s/%s awaiting current admission despite the first admitted receipt', async (lifecycle, status) => {
  await renderWorkCard(assignedWork(lifecycle, status));
  expect(container.textContent).toContain('已接下，待家内准入');
  expect(container.textContent).not.toContain('等待前置工作');
  expect(container.textContent).not.toContain('推进');
});

it.each([
  ['committed', 'ready', '已准入，待开始', '已接下'],
  ['committed', 'blocked', '等待前置工作', '已接下'],
  ['in_progress', 'in_progress', '推进中', '推进'],
] as const)('shows actual admitted %s/%s facts without treating admission as progress', async (lifecycle, status, label, action) => {
  await renderWorkCard(assignedWork(lifecycle, status, 'admitted'));
  expect(container.querySelector('header strong')?.textContent).toBe(label);
  expect(container.textContent).toContain(`${participant.displayName} ${action} · You 负责`);
  expect(container.textContent).not.toContain('未获准执行');
});

it.each([
  'admitted',
  'rejected',
  undefined,
] as const)('uses initial acceptance only when current authority is absent (%s)', async (admission) => {
  const initial = assignedWork('committed', 'ready', admission);
  initial.acceptance = { ...initial.acceptance, hostAdmission: initial.executionAuthority?.hostAdmission };
  delete initial.executionAuthority;
  await renderWorkCard(initial);
  expect(container.querySelector('header strong')?.textContent).toBe(
    admission === 'admitted' ? '已准入，待开始' : admission === 'rejected' ? '未获准执行' : '已接下，待家内准入',
  );
  expect(container.textContent).not.toContain('推进');
});

it('does not expose unrecognized Host errors or private paths as refusal reasons', async () => {
  const reason = 'Error: /home/user/owner/profile.json\n    at internalAuthority()';
  await renderWorkCard(assignedWork('committed', 'blocked', 'rejected', reason));
  expect(container.textContent).toContain('家内未批准当前执行');
  expect(container.textContent).not.toContain(reason);
  expect(container.textContent).not.toContain('/home/user');
});

it.each([
  ['committed', 'ready'],
  ['in_progress', 'in_progress'],
  ['in_progress', 'blocked'],
] as const)('prefers live Service unavailability over an admitted %s/%s receipt', async (lifecycle, status) => {
  const current = Object.assign(assignedWork(lifecycle, status, 'admitted'), {
    executionStatus: {
      issuer: 'service' as const,
      revision: 2,
      state: 'unavailable' as const,
      reason: 'WORK_DELEGATION_UNAVAILABLE' as const,
    },
  });
  const historicalReceipt = structuredClone(current.acceptance);
  const currentReceipt = structuredClone(current.executionAuthority?.hostAdmission);
  await renderWorkCard(current);
  expect(container.querySelector('header strong')?.textContent).toBe('当前无法执行');
  expect(container.textContent).toContain('主人委托已失效或撤回');
  expect(container.textContent).toContain(`${participant.displayName} 已接下 · You 负责`);
  expect(container.textContent).not.toContain('等待前置工作');
  expect(container.textContent).not.toContain(`${participant.displayName} 推进`);
  expect(current.acceptance).toEqual(historicalReceipt);
  expect(current.executionAuthority?.hostAdmission).toEqual(currentReceipt);
});

it('does not treat live permission as a replacement for a missing current Host receipt', async () => {
  const current = Object.assign(assignedWork('in_progress', 'blocked'), {
    executionStatus: { issuer: 'service' as const, revision: 2, state: 'permitted' as const },
  });
  await renderWorkCard(current);
  expect(container.querySelector('header strong')?.textContent).toBe('已接下，待家内准入');
  expect(container.textContent).not.toContain(`${participant.displayName} 推进`);
});

it('keeps actual progress when its current Service status and Host receipt both permit it', async () => {
  const current = Object.assign(assignedWork('in_progress', 'in_progress', 'admitted'), {
    executionStatus: { issuer: 'service' as const, revision: 2, state: 'permitted' as const },
  });
  await renderWorkCard(current);
  expect(container.querySelector('header strong')?.textContent).toBe('推进中');
  expect(container.textContent).toContain(`${participant.displayName} 推进 · You 负责`);
});

it.each([
  ['PARTICIPATION_REVOKED', '猫的公共参与已撤回'],
  ['WORK_SOURCE_UNAVAILABLE', '来源消息或相关成员已不可用'],
  ['CONNECTION_REVOKED', '所属 Café 的连接已撤回'],
  ['MEMBERSHIP_REVOKED', '相关成员已退出或被移除'],
  ['WORK_ADMISSION_NOT_CURRENT', '当前执行的家内准入已失效'],
  [undefined, '当前执行权限不可用'],
] as const)('explains current Service unavailability without reporting it as a dependency (%s)', async (reason, message) => {
  const current = Object.assign(assignedWork('in_progress', 'blocked', 'admitted'), {
    executionStatus: { issuer: 'service' as const, revision: 2, state: 'unavailable' as const, reason },
  });
  await renderWorkCard(current);
  expect(container.querySelector('header strong')?.textContent).toBe('当前无法执行');
  expect(container.textContent).toContain(message);
  expect(container.textContent).not.toContain('等待前置工作');
});

it('binds the live check to initial execution while keeping its admitted acceptance immutable', async () => {
  const current = Object.assign(assignedWork('in_progress', 'blocked', 'admitted'), {
    executionStatus: {
      issuer: 'service' as const,
      revision: 1,
      state: 'unavailable' as const,
      reason: 'WORK_DELEGATION_UNAVAILABLE' as const,
    },
  });
  delete current.executionAuthority;
  await renderWorkCard(current);
  expect(container.querySelector('header strong')?.textContent).toBe('当前无法执行');
  expect(current.acceptance.hostAdmission?.state).toBe('admitted');
});

it('does not apply a stale unavailable check to a permitted successor execution', async () => {
  const current = Object.assign(assignedWork('in_progress', 'in_progress', 'admitted'), {
    executionStatus: {
      issuer: 'service' as const,
      revision: 1,
      state: 'unavailable' as const,
      reason: 'WORK_DELEGATION_UNAVAILABLE' as const,
    },
  });
  await renderWorkCard(current);
  expect(container.querySelector('header strong')?.textContent).toBe('推进中');
});

it.each([
  ['rejected', '未获准执行', '已接下'],
  [undefined, '已接下，待家内准入', '已接下'],
  ['admitted', '推进中', '推进'],
] as const)('uses the same current admission facts in Roadmap node and details (%s)', async (admission, label, action) => {
  const current = assignedWork('in_progress', admission === 'admitted' ? 'in_progress' : 'blocked', admission);
  await renderRoadmap(current);
  expect(container.querySelector('.roadmap-work-node-status')?.textContent).toBe(label);
  expect(container.querySelector('.roadmap-work-details header span')?.textContent).toBe(label);
  expect(container.querySelector('.roadmap-work-node small')?.textContent).toContain(
    `${participant.displayName} ${action}`,
  );
  expect(container.querySelector('.roadmap-work-details dl')?.textContent).toContain(
    `${participant.displayName} ${action}`,
  );
  if (admission === 'rejected') expect(container.textContent).toContain('主人委托已失效或撤回');
});

it('does not claim current Roadmap progress after live Service permission is withdrawn', async () => {
  const current = Object.assign(assignedWork('in_progress', 'blocked', 'admitted'), {
    executionStatus: {
      issuer: 'service' as const,
      revision: 2,
      state: 'unavailable' as const,
      reason: 'WORK_DELEGATION_UNAVAILABLE' as const,
    },
  });
  await renderRoadmap(current);
  expect(container.querySelector('.roadmap-work-node-status')?.textContent).toBe('当前无法执行');
  expect(container.querySelector('.roadmap-work-details header span')?.textContent).toBe('当前无法执行');
  expect(container.textContent).toContain('主人委托已失效或撤回');
  expect(container.textContent).toContain(`${participant.displayName} 已接下`);
  expect(container.textContent).not.toContain(`${participant.displayName} 推进`);
  expect(container.textContent).not.toContain('等待前置工作');
});
