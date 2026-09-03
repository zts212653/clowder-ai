import type { EntrustedWorkOwnerReadV1 } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ownerReads: [] as EntrustedWorkOwnerReadV1[],
  loading: false,
  error: false,
  refetch: vi.fn(),
}));

vi.mock('@/hooks/useEntrustedWorkProjection', () => ({
  useEntrustedWorkProjection: () => mocks,
}));

import { ProductSchedulePanel, scheduleItemRef } from '../ProductSchedulePanel';

const now = Date.UTC(2026, 7, 31, 12);

function ownerRead(input: {
  id: string;
  titleRef: string;
  timeRole: 'business_deadline' | 'review_by';
  time: number;
  actionable?: boolean;
}): EntrustedWorkOwnerReadV1 {
  const subjectRef = `task:work:${input.id}`;
  return {
    envelope: {
      subjectRef,
      ownerRef: `task:item:${input.id}`,
      sourceRefs: [input.titleRef],
      revision: 3,
      freshness: { state: 'current', observedRevision: 3 },
      visibility: { ownerUserId: 'owner-1', human: true, cat: true },
    },
    preparedArtifact: {
      artifactRef: `artifact:ppt:${input.id}`,
      artifactRevision: '7',
      completenessRef: `artifact:ppt:${input.id}#complete:7`,
      previewRef: `artifact:ppt:${input.id}#preview:7`,
      openInWorkspaceRef: `workspace:artifact:ppt:${input.id}:7`,
    },
    timeRefs: [
      {
        role: input.timeRole,
        subjectRef,
        ownerRef: `task:item:${input.id}`,
        revision: 3,
        value: input.time,
      },
    ],
    attentionReceipts: input.actionable
      ? [
          {
            eligible: true,
            producer: {
              producerId: 'f246.approval',
              ownerRef: `approval:${input.id}`,
              subjectRef: `approval:${input.id}`,
              revision: 5,
            },
            taskRef: { subjectRef, observedRevision: 3 },
            kind: 'judgment',
            reasonCode: 'direction_choice',
            recommendation: 'Use the evidence-first direction',
            salience: 'normal',
            action: { actionRef: `approval:${input.id}#decide`, expectedProducerRevision: 5 },
            reEvaluateActionRef: `approval:${input.id}#reevaluate`,
          },
        ]
      : [],
  };
}

describe('F310 ProductSchedulePanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocks.ownerReads = [];
    mocks.loading = false;
    mocks.error = false;
    mocks.refetch.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('shows quiet and actionable admitted work in business-time order from typed owner reads', async () => {
    mocks.ownerReads = [
      ownerRead({ id: 'quiet', titleRef: 'message:quiet-ppt', timeRole: 'business_deadline', time: now + 86_400_000 }),
      ownerRead({
        id: 'actionable',
        titleRef: 'message:actionable-ppt',
        timeRole: 'review_by',
        time: now + 3_600_000,
        actionable: true,
      }),
    ];

    await act(async () => {
      root.render(<ProductSchedulePanel now={() => now} />);
    });

    const rows = container.querySelectorAll('[data-testid="product-schedule-item"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute('data-owner-ref')).toBe('task:item:actionable');
    expect(rows[0]?.textContent).toContain('请你审阅');
    expect(rows[0]?.textContent).toContain('需要判断');
    expect(rows[1]?.getAttribute('data-owner-ref')).toBe('task:item:quiet');
    expect(rows[1]?.textContent).toContain('业务截止');
    expect(container.textContent).not.toContain('Unadmitted conversation candidate');
  });

  it('opens the exact source-owned prepared Artifact coordinate', async () => {
    const openArtifact = vi.fn();
    mocks.ownerReads = [
      ownerRead({ id: 'quiet', titleRef: 'message:quiet-ppt', timeRole: 'business_deadline', time: now + 86_400_000 }),
    ];
    await act(async () => {
      root.render(
        <ProductSchedulePanel now={() => now} selectedItemRef="task:work:quiet|3" onOpenArtifact={openArtifact} />,
      );
    });

    await act(async () => {
      container
        .querySelector('[data-testid="product-schedule-open-artifact"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(openArtifact).toHaveBeenCalledWith(
      {
        artifactRef: 'artifact:ppt:quiet',
        artifactRevision: '7',
        completenessRef: 'artifact:ppt:quiet#complete:7',
        previewRef: 'artifact:ppt:quiet#preview:7',
        openInWorkspaceRef: 'workspace:artifact:ppt:quiet:7',
      },
      'task:work:quiet|3',
    );
    expect(container.querySelector('[data-testid="product-schedule-item"]')?.getAttribute('data-selected')).toBe(
      'true',
    );
    const [firstOwnerRead] = mocks.ownerReads;
    expect(firstOwnerRead).toBeDefined();
    if (!firstOwnerRead) throw new Error('expected one owner read');
    expect(scheduleItemRef(firstOwnerRead)).toBe('task:work:quiet|3');
  });

  it('keeps the terminal projection bounded at narrow panel widths', async () => {
    await act(async () => {
      root.render(<ProductSchedulePanel now={() => now} />);
    });

    const panel = container.querySelector<HTMLElement>('[data-testid="product-schedule-panel"]');
    expect(panel?.className).toContain('min-w-0');
    expect(panel?.className).toContain('overflow-x-hidden');
  });
});
