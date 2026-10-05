import type { EntrustedWorkOwnerReadV1 } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ownerReads: [] as EntrustedWorkOwnerReadV1[],
  loading: false,
  error: false,
  refetch: vi.fn(),
  projection: vi.fn(),
}));

vi.mock('@/hooks/useEntrustedWorkProjection', () => ({
  useEntrustedWorkProjection: (projection: string) => {
    mocks.projection(projection);
    return mocks;
  },
}));

import { ProductSchedulePanel, scheduleItemRef } from '../ProductSchedulePanel';

vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => undefined }) }));

const now = Date.UTC(2026, 7, 31, 12);

function ownerRead(input: {
  id: string;
  titleRef: string;
  timeRole: 'business_deadline' | 'review_by';
  time: number;
  actionable?: boolean;
}): EntrustedWorkOwnerReadV1 {
  const subjectRef = `task:work:${input.id}`;
  const ownerRef = `task:item:${input.id}`;
  const producerRef = `approval:${input.id}`;
  return {
    envelope: {
      subjectRef,
      ownerRef,
      admissionReceiptRef: `task:receipt:${input.id}:3`,
      sourceRefs: [input.titleRef],
      revision: 3,
      freshness: { state: 'current', observedRevision: 3 },
      visibility: { ownerUserId: 'owner-1', human: true, cat: true },
    },
    brief: {
      outcome: {
        state: 'known',
        value: `Prepare ${input.id} outcome`,
        ownerRef,
        revision: 3,
      },
      current: { state: 'doing', ownerRef, revision: 3 },
      verifiedMilestone: input.actionable
        ? { kind: 'needs_judgment', evidenceRef: producerRef, revision: 5 }
        : {
            kind: 'artifact_ready',
            evidenceRef: `artifact:ppt:${input.id}#complete:7`,
            revision: '7',
          },
      nextOwner: input.actionable
        ? {
            kind: 'human',
            ownerRef: 'user:owner-1',
            evidence: [{ producerId: 'f246.approval', ownerRef: producerRef, revision: 5 }],
          }
        : { kind: 'cat', ownerRef: 'cat:codex-sol', evidenceRef: ownerRef, revision: 3 },
      needsMe: input.actionable
        ? { state: 'needed', evidence: [{ producerId: 'f246.approval', ownerRef: producerRef, revision: 5 }] }
        : { state: 'not_needed', evidenceRef: ownerRef, revision: 3 },
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
              ownerRef: producerRef,
              subjectRef: producerRef,
              revision: 5,
            },
            taskRef: { subjectRef, observedRevision: 3 },
            kind: 'judgment',
            reasonCode: 'direction_choice',
            recommendation: 'Use the evidence-first direction',
            salience: 'normal',
            action: { actionRef: `${producerRef}#decide`, expectedProducerRevision: 5 },
            reEvaluateActionRef: `${producerRef}#reevaluate`,
          },
        ]
      : [],
  };
}

describe('F310 ProductSchedulePanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  it('keeps an admission goal in details when no owner progress has been recorded', async () => {
    const work = ownerRead({ id: 'legacy-work', titleRef: 'message:source', timeRole: 'review_by', time: now });
    work.work = {
      title: '原来的开发责任',
      ownerCatId: 'codex-sol',
      threadId: 'thread-original',
      admittedAt: now,
      ownerNote: '原始托付说明',
    };
    mocks.ownerReads = [work];
    await act(async () => root.render(<ProductSchedulePanel now={() => now} />));
    const item = container.querySelector('[data-testid="product-schedule-item"]');
    expect(item?.querySelector('[data-testid="work-owner-note"]')?.textContent).toBe('尚无进展说明');
    expect(item?.querySelector('details')?.textContent).toContain('Prepare legacy-work outcome');
    expect(item?.querySelector('details')?.textContent).toContain('原始托付说明');
  });

  it('keeps owner facts and original-thread return outside details, with week/month views', async () => {
    const work = ownerRead({ id: 'native-work', titleRef: 'message:source', timeRole: 'review_by', time: now });
    work.timeRefs = [];
    work.work = {
      title: '工作日历与可见交付',
      ownerCatId: 'codex-sol',
      threadId: 'thread-original',
      admittedAt: now - 86_400_000,
      ownerNote: '等待已登记的审阅结果',
      progress: {
        summary: '页面已完成，正在复核',
        nextStep: '处理审阅结论',
        blockerReason: '等待已登记的审阅结果',
        sourceRef: 'message:progress',
      },
    };
    work.brief.current.state = 'blocked';
    mocks.ownerReads = [work];
    await act(async () => root.render(<ProductSchedulePanel now={() => now} />));
    const item = container.querySelector('[data-testid="product-schedule-item"]');
    expect(item?.querySelector('h3')?.textContent).toBe('工作日历与可见交付');
    expect(item?.querySelector('[data-testid="work-owner"]')?.closest('details')).toBeNull();
    expect(item?.querySelector('[data-testid="work-owner"]')?.textContent).toContain('codex-sol');
    const origin = item?.querySelector('a[href="/thread/thread-original"]');
    expect(origin).not.toBeNull();
    expect(origin?.closest('details')).toBeNull();
    expect(item?.querySelector('[data-testid="work-owner-note"]')?.textContent).toContain('等待已登记的审阅结果');
    expect(item?.querySelector('[data-testid="work-owner-note"]')?.textContent).toContain('处理审阅结论');
    expect(item?.textContent).toContain('接下');
    expect(item?.textContent).toContain('截止未定');
    expect(container.querySelector('[aria-label="本周安排"]')).not.toBeNull();
    const month = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '月');
    expect(month).toBeDefined();
    await act(async () => month?.click());
    const day = container.querySelector<HTMLButtonElement>('[data-calendar-date]');
    expect(day).not.toBeNull();
    await act(async () => day?.click());
    expect(container.querySelector('[data-subject-ref="task:work:native-work"]')).not.toBeNull();
  });

  it('keeps an accepted undated development visible without manufacturing a due date', async () => {
    const work = ownerRead({
      id: 'calendar-development',
      titleRef: 'message:calendar',
      timeRole: 'review_by',
      time: now,
    });
    work.timeRefs = [];
    work.preparedArtifact = undefined;
    work.brief.current.state = 'blocked';
    mocks.ownerReads = [work];
    await act(async () => {
      root.render(<ProductSchedulePanel now={() => now} />);
    });
    const item = container.querySelector('[data-subject-ref="task:work:calendar-development"]');
    expect(item).not.toBeNull();
    expect(item?.textContent).toContain('截止未定');
    expect(item?.textContent).toContain('已阻塞');
    expect(item?.textContent).not.toContain('安静进行中');
    expect(container.querySelector('[aria-label="工作日历"]')).not.toBeNull();
    expect(work.timeRefs).toEqual([]);
  });

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocks.ownerReads = [];
    mocks.loading = false;
    mocks.error = false;
    mocks.refetch.mockReset();
    mocks.projection.mockReset();
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
    expect(rows[0]?.textContent).toContain('需要你判断');
    expect(rows[0]?.textContent).toContain('Prepare actionable outcome');
    expect(rows[0]?.textContent).toContain('已到需要你判断的节点');
    expect(rows[0]?.textContent).toContain('You');
    expect(rows[0]?.textContent).toContain('现在需要你');
    // Technical coordinates stay in the innermost details, not in the brief's Artifact field.
    expect(rows[0]?.textContent).not.toContain('Artifact r7');
    expect(rows[0]?.querySelector('[data-testid="entrusted-work-brief-artifact"]')?.textContent).toBe('准备好的作品');
    expect(rows[0]?.querySelector('[data-testid="entrusted-work-brief"] details')?.textContent).toContain(
      'artifact:ppt:actionable',
    );
    expect(rows[1]?.getAttribute('data-owner-ref')).toBe('task:item:quiet');
    expect(rows[1]?.textContent).toContain('截止');
    expect(rows[1]?.textContent).toContain('codex-sol');
    expect(rows[1]?.textContent).toContain('现在不需要你');
    expect(rows[1]?.querySelector('[data-testid="entrusted-work-brief-artifact"]')?.textContent).toBe('准备好的作品');
    expect(rows[1]?.querySelector('[data-testid="entrusted-work-brief"] details')?.textContent).toContain(
      'artifact:ppt:quiet',
    );
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
      undefined, // an F232 artifact has no review title to carry into the tab
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

  it('shows unknown instead of inventing outcome, milestone, owner, or Artifact truth', async () => {
    const unknown = ownerRead({
      id: 'unknown',
      titleRef: 'message:unknown',
      timeRole: 'review_by',
      time: now + 3_600_000,
    });
    mocks.ownerReads = [
      {
        ...unknown,
        brief: {
          ...unknown.brief,
          outcome: { state: 'unknown' },
          verifiedMilestone: { kind: 'unknown' },
          nextOwner: { kind: 'unknown' },
        },
        preparedArtifact: undefined,
      },
    ];

    await act(async () => {
      root.render(<ProductSchedulePanel now={() => now} />);
    });

    const item = container.querySelector('[data-testid="product-schedule-item"]');
    expect(item?.textContent?.match(/unknown/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('restores completed history on exact Artifact return without showing overdue or asking for a new review', async () => {
    const work = ownerRead({
      id: 'finished',
      titleRef: 'message:done',
      timeRole: 'business_deadline',
      time: now - 86_400_000,
    });
    work.brief.current.state = 'done';
    work.brief.nextOwner = { kind: 'unknown' };
    work.brief.verifiedMilestone = { kind: 'work_completed', evidenceRef: work.envelope.ownerRef, revision: 3 };
    work.completion = { recordedAt: now - 3600, evidenceRefs: ['message:accepted'] };
    mocks.ownerReads = [work];
    await act(async () =>
      root.render(
        <ProductSchedulePanel now={() => now} selectedItemRef={scheduleItemRef(work)} onOpenReview={vi.fn()} />,
      ),
    );
    expect(mocks.projection).toHaveBeenLastCalledWith('completed');
    expect(container.querySelector('fieldset[aria-label="筛选工作"]')).toBeNull();
    const item = container.querySelector('[data-testid="product-schedule-item"]');
    expect(item?.getAttribute('data-selected')).toBe('true');
    expect(item?.textContent).toContain('已完成');
    expect(item?.textContent).not.toContain('已逾期');
    expect(item?.textContent).toContain('打开成果');
    expect(item?.textContent).toContain('message:accepted');
  });
});
