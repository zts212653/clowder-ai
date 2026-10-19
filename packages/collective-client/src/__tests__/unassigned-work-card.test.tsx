// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CollectiveWorkCard } from '../CollectiveWorkCard.js';
import type { CollectiveWorkProjection } from '../client-types.js';
import { participant, work } from './collaboration-cards.fixture.js';

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

it('keeps an accepted unassigned task visible and lets a Human explicitly take responsibility', async () => {
  const unassigned = {
    ...work,
    lifecycle: 'committed' as const,
    status: 'unassigned' as const,
    revision: 2,
    accountableHumanId: undefined,
    history: [
      ...work.history,
      {
        revision: 2,
        action: 'committed' as const,
        actor: work.proposedBy,
        at: work.updatedAt,
        note: '已纳入任务，等待负责人接下',
      },
    ],
  } satisfies CollectiveWorkProjection;
  const onCommit = vi.fn();
  await act(async () =>
    root.render(
      <CollectiveWorkCard
        work={unassigned}
        works={[unassigned]}
        currentHumanId={participant.humanId}
        sourceOwnerHumanId={participant.humanId}
        canSteward={false}
        participants={[participant]}
        humanNames={{ [participant.humanId]: 'You' }}
        onCommit={onCommit}
        onDecline={vi.fn()}
        onAcceptResult={vi.fn()}
        onComplete={vi.fn()}
      />,
    ),
  );

  expect(container.textContent).toContain('待指派');
  expect(container.textContent).toContain('未分配 · 等待负责人接下');
  const takeResponsibility = [...container.querySelectorAll('button')].find((item) => item.textContent === '由我负责');
  expect(takeResponsibility).toBeDefined();
  await act(async () => takeResponsibility?.click());
  expect(onCommit).toHaveBeenCalledWith(unassigned);
});
