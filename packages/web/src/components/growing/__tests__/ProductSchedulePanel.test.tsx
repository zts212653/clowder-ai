import type { EntrustedWorkOwnerReadV1 } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';

const mocks = vi.hoisted(() => ({
  ownerReads: [] as EntrustedWorkOwnerReadV1[],
  loading: false,
  error: false,
  partial: false,
  refetch: vi.fn(),
  projection: vi.fn(),
  resizeReading: null as (() => void) | null,
  preferences: {
    ownerUserId: 'owner-1',
    revision: 0,
    entries: [] as { coordinate: { kind: 'schedule'; subjectRef: string }; ignoredAt: number }[],
  },
  preferencesUnavailable: false,
  api: vi.fn(),
}));

vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => mocks.api(...args) }));

vi.mock('@/hooks/useEntrustedWorkProjection', () => ({
  useEntrustedWorkProjection: (projection: string) => {
    mocks.projection(projection);
    return {
      ...mocks,
      ownerReads: mocks.ownerReads.filter((work) => Boolean(work.completion) === (projection === 'completed')),
    };
  },
}));

import { type PreparedArtifactCoordinate, ProductSchedulePanel, scheduleItemRef } from '../ProductSchedulePanel';
import { workCalendarDates } from '../work-calendar';

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
  function questionWork() {
    const read = ownerRead({ id: 'ask-progress', titleRef: 'message:original', timeRole: 'review_by', time: now });
    read.work = {
      title: '核对这次交付',
      ownerCatId: 'codex61-sol',
      threadId: 'thread-original',
      admittedAt: now,
      ownerNote: '原托付',
    };
    mocks.ownerReads = [read];
    return read;
  }

  async function askProgress() {
    await act(async () => root.render(<ProductSchedulePanel now={() => now} />));
    const button = container.querySelector<HTMLButtonElement>('[data-testid="schedule-ask-progress"]');
    expect(button).not.toBeNull();
    await act(async () => button?.click());
  }

  it('opens the exact Work conversation with an unsent question, without changing Work or sending a message', async () => {
    const read = questionWork();
    const original = structuredClone(read);
    await askProgress();
    expect(window.location.pathname).toBe('/thread/thread-original');
    expect(useChatStore.getState().pendingChatInsert).toMatchObject({
      threadId: 'thread-original',
      text: '请说说「核对这次交付」目前的进展。',
      waitForDraft: true,
      preserveSelection: true,
    });
    expect(mocks.api.mock.calls.filter(([, init]) => init?.method)).toEqual([]);
    expect(read).toEqual(original);
  });

  it('does not replace a pending authoritative draft ACK with a progress question', async () => {
    questionWork();
    const ack = { threadId: 'source-chat', text: 'Original ACK', authoritative: true, serverRevision: 11 };
    useChatStore.getState().setPendingChatInsert(ack);
    await askProgress();
    expect(useChatStore.getState().pendingChatInsert).toBe(ack);
    expect(window.location.pathname).toBe('/thread/source-chat');
  });

  it('keeps the current conversation when the Work source cannot be read', async () => {
    questionWork();
    const previous = mocks.api.getMockImplementation();
    mocks.api.mockImplementation((path: string, init?: RequestInit) =>
      path === '/api/threads/thread-original'
        ? Promise.resolve(new Response(null, { status: 404 }))
        : previous?.(path, init),
    );
    await askProgress();
    expect(window.location.pathname).toBe('/thread/source-chat');
    expect(useChatStore.getState().pendingChatInsert).toBeNull();
    expect(useToastStore.getState().toasts.at(-1)?.message).toContain('原对话');
  });

  it('does not queue a question after the person moved to another conversation during its source read', async () => {
    questionWork();
    let settle: (response: Response) => void = () => {};
    const previous = mocks.api.getMockImplementation();
    mocks.api.mockImplementation((path: string, init?: RequestInit) =>
      path === '/api/threads/thread-original'
        ? new Promise<Response>((resolve) => {
            settle = resolve;
          })
        : previous?.(path, init),
    );
    await askProgress();
    useChatStore.setState({ currentThreadId: 'another-chat' });
    window.history.replaceState({}, '', '/thread/another-chat');
    await act(async () => settle(Response.json({ id: 'thread-original', createdBy: 'owner-1' })));
    expect(window.location.pathname).toBe('/thread/another-chat');
    expect(useChatStore.getState().pendingChatInsert).toBeNull();
  });

  it('ignores only the personal schedule view, keeps the true total and restores it from the ignored entry', async () => {
    const first = ownerRead({ id: 'ignore-first', titleRef: 'message:first', timeRole: 'review_by', time: now });
    const second = ownerRead({ id: 'keep-second', titleRef: 'message:second', timeRole: 'review_by', time: now });
    mocks.ownerReads = [first, second];
    await act(async () => root.render(<ProductSchedulePanel now={() => now} />));
    const button = container.querySelector<HTMLButtonElement>(
      '[data-subject-ref="task:work:ignore-first"] [data-testid="schedule-ignore"]',
    );
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    expect(container.querySelector('[data-subject-ref="task:work:ignore-first"]')).toBeNull();
    expect(container.querySelector('[data-testid="schedule-personal-counts"]')?.textContent).toBe(
      '共 2 件 · 当前筛选显示 1 件 · 已忽略 1 件',
    );
    expect(mocks.ownerReads).toEqual([first, second]);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="schedule-open-ignored"]')?.click());
    const restore = container.querySelector<HTMLButtonElement>(
      '[data-subject-ref="task:work:ignore-first"] [data-testid="schedule-restore"]',
    );
    expect(restore).not.toBeNull();
    await act(async () => restore?.click());
    expect(mocks.preferences.entries).toEqual([]);
    expect(
      mocks.api.mock.calls
        .filter(([, init]) => init?.method === 'PATCH')
        .every(([path]) => path === '/api/config/ignored-items'),
    ).toBe(true);
  });

  it('does not carry one owner’s recent undo into a newly confirmed owner’s view', async () => {
    const first = questionWork();
    await act(async () => root.render(<ProductSchedulePanel now={() => now} />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="schedule-ignore"]')?.click());
    const undo = () =>
      [...container.querySelectorAll('button')].find((button) => button.textContent === '撤销刚才的忽略');
    expect(undo()).toBeDefined();
    const changed = structuredClone(first);
    changed.envelope.visibility.ownerUserId = 'owner-2';
    changed.envelope.subjectRef = 'task:work:new-owner';
    mocks.ownerReads = [changed];
    mocks.preferences = { ownerUserId: 'owner-2', revision: 0, entries: [] };
    await act(async () => {
      root.render(<ProductSchedulePanel now={() => now} />);
      [...container.querySelectorAll('button')].find((button) => button.textContent === '刷新')?.click();
    });
    expect(container.querySelector('[data-testid="schedule-personal-counts"]')?.textContent).toBe(
      '共 1 件 · 当前筛选显示 1 件 · 已忽略 0 件',
    );
    expect(undo()).toBeUndefined();
  });

  it('does not claim exact ignored counts or save when personal preferences are unavailable', async () => {
    mocks.preferencesUnavailable = true;
    mocks.ownerReads = [
      ownerRead({ id: 'uncertain', titleRef: 'message:uncertain', timeRole: 'review_by', time: now }),
    ];
    await act(async () => root.render(<ProductSchedulePanel now={() => now} />));
    expect(container.querySelector('[data-testid="schedule-personal-counts"]')).toBeNull();
    const ignore = container.querySelector<HTMLButtonElement>('[data-testid="schedule-ignore"]');
    expect(ignore).not.toBeNull();
    expect(ignore?.disabled).toBe(true);
    expect(container.querySelector('[data-testid="schedule-preferences-error"]')).not.toBeNull();
  });

  it('does not let a previous owner save failure overwrite the next owner preference state', async () => {
    const work = ownerRead({ id: 'owner-switch', titleRef: 'message:owner-switch', timeRole: 'review_by', time: now });
    mocks.ownerReads = [work];
    let rejectPrevious: (reason: Error) => void = () => {
      throw new Error('No save started');
    };
    const original = mocks.api.getMockImplementation();
    mocks.api.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === 'PATCH')
        return new Promise((_resolve, reject) => {
          rejectPrevious = reject;
        });
      return original?.(path, init);
    });
    await act(async () => root.render(<ProductSchedulePanel now={() => now} />));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="schedule-ignore"]')?.click());
    work.envelope.visibility.ownerUserId = 'owner-2';
    mocks.preferences = { ownerUserId: 'owner-2', revision: 0, entries: [] };
    await act(async () => {
      root.render(<ProductSchedulePanel now={() => now} />);
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === '刷新')
        ?.click();
    });
    expect(container.querySelector('[data-testid="schedule-personal-counts"]')?.textContent).toBe(
      '共 1 件 · 当前筛选显示 1 件 · 已忽略 0 件',
    );
    await act(async () => rejectPrevious(new Error('Old owner connection failed')));
    expect(container.querySelector('[data-testid="schedule-preferences-error"]')).toBeNull();
  });
  let container: HTMLDivElement;
  let root: Root;

  it('puts only actual starts and business deadlines on the calendar, without inventing admission dates', () => {
    const work = ownerRead({ id: 'real-dates', titleRef: 'message:source', timeRole: 'business_deadline', time: now });
    work.work = {
      title: '真实日期',
      ownerCatId: 'codex61-sol',
      threadId: 'thread-source',
      admittedAt: now - 86400000,
      ownerNote: '原托付',
    };
    const date = work.timeRefs[0];
    work.timeRefs = [
      { ...date, role: 'planned_start' },
      { ...date, role: 'review_by' },
      { ...date, role: 'estimated_completion' },
      { ...date, role: 'execution_trigger' },
      { ...date, role: 'actual_start' },
      date,
    ];
    const original = structuredClone(work);
    expect(workCalendarDates(work)).toEqual([{ ...date, role: 'actual_start' }, date]);
    expect(work).toEqual(original);
    work.timeRefs = [];
    expect(workCalendarDates(work)).toEqual([]);
  });

  it('starts in week view even when the actual panel reports a wide viewport', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private readonly callback: (entries: { contentRect: { width: number } }[]) => void) {}
        observe() {
          this.callback([{ contentRect: { width: 900 } }]);
        }
        disconnect() {}
      },
    );
    try {
      mocks.ownerReads = [];
      await act(async () => root.render(<ProductSchedulePanel now={() => now} />));
      expect(container.querySelector('[aria-label="工作日历"]')?.getAttribute('data-view')).toBe('week');
      expect(container.querySelector('[aria-label="本周安排"]')).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('retains the chosen month and day while visiting the wide list and returning', async () => {
    await act(async () => root.render(<ProductSchedulePanel now={() => now} />));
    const click = async (label: string) =>
      act(async () =>
        Array.from(container.querySelectorAll('button'))
          .find((button) => button.textContent === label)
          ?.click(),
      );
    await click('月');
    const day = container.querySelector<HTMLButtonElement>('[data-calendar-date]');
    await act(async () => day?.click());
    const selectedDay = day?.getAttribute('data-calendar-date');
    await click('展开成宽列表');
    await click('返回列表');
    expect(container.querySelector('[aria-label="工作日历"]')?.getAttribute('data-view')).toBe('month');
    expect(container.querySelector(`[data-calendar-date="${selectedDay}"]`)?.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps undated work blocked first, overdue collapsed and only the last seven days of actual completions visible', async () => {
    const undated = (id: string, state: 'todo' | 'doing' | 'blocked') => {
      const work = ownerRead({ id, titleRef: `message:${id}`, timeRole: 'review_by', time: now });
      work.brief.current.state = state;
      return work;
    };
    const overdue = ownerRead({
      id: 'overdue',
      titleRef: 'message:overdue',
      timeRole: 'business_deadline',
      time: now - 86400000,
    });
    const finished = (id: string, recordedAt?: number) => {
      const work = undated(id, 'doing');
      work.brief.current.state = 'done';
      work.completion = {
        ...(recordedAt === undefined ? {} : { recordedAt }),
        evidenceRefs: [`message:${id}:accepted`],
      };
      return work;
    };
    mocks.ownerReads = [
      undated('doing', 'doing'),
      undated('todo', 'todo'),
      overdue,
      undated('blocked', 'blocked'),
      finished('recent', now - 86400000),
      finished('old', now - 8 * 86400000),
      finished('unknown-time'),
    ];
    await act(async () => root.render(<ProductSchedulePanel now={() => now} />));
    const undatedList = container.querySelector('[data-testid="schedule-unscheduled"]');
    expect(
      Array.from(undatedList?.querySelectorAll('[data-subject-ref]') ?? []).map((el) =>
        el.getAttribute('data-subject-ref'),
      ),
    ).toEqual(['task:work:blocked', 'task:work:doing', 'task:work:todo']);
    const overdueList = container.querySelector<HTMLDetailsElement>('[data-testid="schedule-overdue"]');
    expect(overdueList).not.toBeNull();
    expect(overdueList?.open).toBe(false);
    expect(overdueList?.querySelector('summary')?.textContent).toContain('1 件已过截止时间');
    const completed = container.querySelector('[data-testid="schedule-recent-completed"]');
    expect(completed?.textContent).toContain('recent');
    expect(completed?.textContent).not.toContain('old');
    expect(completed?.textContent).not.toContain('unknown-time');
    expect(mocks.projection).toHaveBeenCalledWith('schedule');
    expect(mocks.projection).toHaveBeenCalledWith('completed');
  });

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
    expect(item?.querySelector('[data-testid="work-owner-note"]')?.textContent).toContain('没有进展记录');
    expect(item?.querySelector('[data-testid="entrusted-work-brief"]')?.textContent).toContain(
      'Prepare legacy-work outcome',
    );
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
    expect(item?.querySelector('[data-testid="work-owner"]')?.closest('details')?.hasAttribute('open')).toBe(true);
    expect(item?.querySelector('[data-testid="work-owner"]')?.textContent).toContain('codex-sol');
    const origin = item?.querySelector('a[href="/thread/thread-original"]');
    expect(origin).not.toBeNull();
    expect(origin?.closest('details')?.hasAttribute('open')).toBe(true);
    expect(item?.querySelector('[data-testid="work-owner-note"]')?.textContent).toContain('等待已登记的审阅结果');
    expect(item?.querySelector('[data-testid="work-owner-note"]')?.textContent).toContain('处理审阅结论');
    expect(item?.textContent).toContain('接单日期');
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
    expect(item?.textContent).toContain('受阻');
    expect(item?.textContent).not.toContain('安静进行中');
    expect(container.querySelector('[aria-label="工作日历"]')).not.toBeNull();
    expect(work.timeRefs).toEqual([]);
  });

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          mocks.resizeReading = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    mocks.ownerReads = [];
    mocks.loading = false;
    mocks.error = false;
    mocks.partial = false;
    mocks.refetch.mockReset();
    mocks.projection.mockReset();
    mocks.preferences = { ownerUserId: 'owner-1', revision: 0, entries: [] };
    mocks.preferencesUnavailable = false;
    mocks.api.mockReset();
    useChatStore.setState({ currentThreadId: 'source-chat', pendingChatInsert: null, presentationLock: null });
    useToastStore.setState({ toasts: [] });
    window.history.replaceState({}, '', '/thread/source-chat');
    mocks.api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === '/api/session') return Response.json({ userId: mocks.preferences.ownerUserId });
      if (path === '/api/threads/thread-original')
        return Response.json({ id: 'thread-original', createdBy: 'owner-1' });
      if (path !== '/api/config/ignored-items') return new Response(null, { status: 404 });
      if (mocks.preferencesUnavailable) return new Response(null, { status: 503 });
      if (init?.method === 'PATCH') {
        const change = JSON.parse(String(init.body));
        const removed = new Set(change.restore.map((item: { subjectRef: string }) => item.subjectRef));
        mocks.preferences = {
          ...mocks.preferences,
          revision: mocks.preferences.revision + 1,
          entries: [
            ...mocks.preferences.entries.filter((entry) => !removed.has(entry.coordinate.subjectRef)),
            ...change.ignore.map((coordinate: { kind: 'schedule'; subjectRef: string }) => ({
              coordinate,
              ignoredAt: now,
            })),
          ],
        };
      }
      return Response.json(mocks.preferences);
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    writeShellLanguage('zh');
    container.remove();
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('keeps factual schedule rows visible while producer coverage is partial', async () => {
    mocks.partial = true;
    mocks.ownerReads = [
      ownerRead({ id: 'partial', titleRef: 'message:partial', timeRole: 'review_by', time: now + 3_600_000 }),
    ];

    await act(async () => {
      root.render(<ProductSchedulePanel now={() => now} />);
    });

    expect(container.textContent).toContain('仅部分读取，部分工作仍待确认');
    expect(container.querySelector('[data-testid="product-schedule-item"]')).not.toBeNull();
    expect(container.textContent).not.toContain('暂时无法读取工作与安排');
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

    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === '展开成宽列表')
        ?.click(),
    );

    const rows = container.querySelectorAll('[data-testid="product-schedule-item"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute('data-owner-ref')).toBe('task:item:actionable');
    expect(rows[0]?.textContent).toContain('请你审阅');
    expect(rows[0]?.textContent).toContain('等你判断');
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

  for (const [elapsed, expected, english] of [
    [3600000, '超过截止时间，未满 1 天', 'Less than 1 day past the deadline'],
    [3.5 * 86400000, '超过截止时间 3 天', '3 days past the deadline'],
  ] as const) {
    it(`reports ${elapsed}ms past the real deadline without rounding up`, async () => {
      const work = ownerRead({
        id: 'elapsed',
        titleRef: 'message:deadline',
        timeRole: 'business_deadline',
        time: now - elapsed,
      });
      mocks.ownerReads = [work];
      await act(async () =>
        root.render(<ProductSchedulePanel now={() => now} selectedItemRef={scheduleItemRef(work)} />),
      );
      expect(container.querySelector('[data-testid="product-schedule-item"]')?.textContent).toContain(expected);
      await act(async () => writeShellLanguage('en'));
      expect(container.querySelector('[data-testid="product-schedule-item"]')?.textContent).toContain(english);
      expect(container.querySelector('[data-testid="product-schedule-item"]')?.getAttribute('data-selected')).toBe(
        'true',
      );
    });
  }

  it('discards the local reading point when the original artifact read fails without leaving', async () => {
    const work = ownerRead({ id: 'failed', titleRef: 'message:failed', timeRole: 'review_by', time: now });
    work.timeRefs = [];
    mocks.ownerReads = [work];
    const itemRef = scheduleItemRef(work);
    const open = vi.fn<(artifact: PreparedArtifactCoordinate, itemRef: string, title?: string) => void>();
    const render = (artifactsLoading: boolean) =>
      root.render(
        <ProductSchedulePanel
          now={() => now}
          selectedItemRef={itemRef}
          artifactsLoading={artifactsLoading}
          onOpenArtifact={open}
        />,
      );
    open.mockImplementation(() => render(true));
    await act(async () => render(false));
    const port = container.querySelector<HTMLDivElement>('[data-testid="schedule-unscheduled"]');
    if (!port) throw new Error('expected the original list');
    let width = 928;
    Object.defineProperty(port, 'clientWidth', { get: () => width });
    port.scrollTop = 4051;
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="product-schedule-open-artifact"]')?.click(),
    );
    width = 247;
    mocks.resizeReading?.();
    width = 928;
    mocks.resizeReading?.();
    await act(async () => render(false));
    port.scrollTop = 2000;
    width = 247;
    mocks.resizeReading?.();
    width = 928;
    mocks.resizeReading?.();
    expect(port.scrollTop).toBe(2000);
  });

  for (const transition of ['failed different artifact', 'scope', 'owner refresh'] as const) {
    it(`does not reveal the previous selection again after ${transition}`, async () => {
      const previous = ownerRead({ id: 'previous', titleRef: 'message:previous', timeRole: 'review_by', time: now });
      const current = ownerRead({ id: 'current', titleRef: 'message:current', timeRole: 'review_by', time: now });
      previous.timeRefs = [];
      current.timeRefs = [];
      mocks.ownerReads = [previous, current];
      const reveal = vi.fn();
      const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: reveal });
      const open = vi.fn<(artifact: PreparedArtifactCoordinate, itemRef: string, title?: string) => void>();
      const render = (artifactsLoading = false) =>
        root.render(
          <ProductSchedulePanel
            now={() => now}
            selectedItemRef={scheduleItemRef(previous)}
            artifactsLoading={artifactsLoading}
            onOpenArtifact={open}
          />,
        );
      open.mockImplementation(() => render(true));
      try {
        await act(async () => render());
        expect(reveal).toHaveBeenCalledOnce();
        reveal.mockClear();
        if (transition === 'failed different artifact') {
          await act(async () =>
            container
              .querySelector<HTMLButtonElement>(
                '[data-subject-ref="task:work:current"] [data-testid="product-schedule-open-artifact"]',
              )
              ?.click(),
          );
          expect(open).toHaveBeenCalledOnce();
          await act(async () => render(false));
        } else if (transition === 'scope') {
          await act(async () =>
            Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
              .find((button) => button.textContent === '已完成')
              ?.click(),
          );
          await act(async () =>
            Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
              .find((button) => button.textContent === '当前工作')
              ?.click(),
          );
        } else {
          mocks.loading = true;
          await act(async () => render());
          mocks.loading = false;
          await act(async () => render());
        }
        expect(reveal).not.toHaveBeenCalled();
      } finally {
        if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
        else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
      }
    });
  }

  for (const language of ['zh', 'en'] as const) {
    it(`labels an empty calendar day honestly while retaining all 22 undated works in ${language}`, async () => {
      await act(async () => writeShellLanguage(language));
      mocks.ownerReads = Array.from({ length: 22 }, (_, index) => {
        const work = ownerRead({
          id: `undated-${index}`,
          titleRef: 'message:source',
          timeRole: 'review_by',
          time: now,
        });
        work.timeRefs = [];
        return work;
      });
      await act(async () => root.render(<ProductSchedulePanel now={() => now} />));
      await act(async () => container.querySelector<HTMLButtonElement>('[data-calendar-date]')?.click());
      expect(container.querySelector('[data-testid="schedule-unscheduled"]')?.querySelectorAll('article')).toHaveLength(
        22,
      );
      const heading = container.querySelector('[data-testid="schedule-worklist"] h3');
      expect(heading?.textContent).toContain(language === 'en' ? 'and unscheduled work' : '和未排期工作');
      expect(heading?.textContent).toContain('22');
    });
  }

  it('reveals an external completion when its original owner read first becomes ready', async () => {
    const work = ownerRead({ id: 'external-done', titleRef: 'message:done', timeRole: 'review_by', time: now });
    work.brief.current.state = 'done';
    work.completion = { recordedAt: now - 1000, evidenceRefs: ['message:accepted'] };
    mocks.ownerReads = [work];
    mocks.loading = true;
    const reveal = vi.fn();
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: reveal });
    const render = () => root.render(<ProductSchedulePanel now={() => now} selectedItemRef={scheduleItemRef(work)} />);
    try {
      await act(async () => render());
      expect(reveal).not.toHaveBeenCalled();
      mocks.loading = false;
      await act(async () => render());
      expect(reveal).toHaveBeenCalledOnce();
      expect(container.querySelector('[data-view="week"]')).toBeNull();
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
  });

  it('returns a locally opened recent completion to the same active calendar and recent list', async () => {
    const work = ownerRead({
      id: 'recent-return',
      titleRef: 'message:recent-return',
      timeRole: 'review_by',
      time: now,
    });
    work.timeRefs = [];
    work.brief.current.state = 'done';
    work.completion = { recordedAt: now - 1000, evidenceRefs: ['message:accepted'] };
    mocks.ownerReads = [work];
    const open = vi.fn<(artifact: PreparedArtifactCoordinate, itemRef: string, title?: string) => void>();
    open.mockImplementation((_artifact, itemRef) =>
      root.render(<ProductSchedulePanel now={() => now} selectedItemRef={itemRef} onOpenArtifact={open} />),
    );
    await act(async () => root.render(<ProductSchedulePanel now={() => now} onOpenArtifact={open} />));
    const recent = container.querySelector<HTMLElement>('[data-testid="schedule-recent-completed"]');
    if (!recent) throw new Error('expected the original recent completions');
    let width = 928;
    Object.defineProperty(recent, 'clientWidth', { get: () => width });
    recent.scrollTop = 123;
    await act(async () =>
      recent.querySelector<HTMLButtonElement>('[data-testid="product-schedule-open-artifact"]')?.click(),
    );
    container.setAttribute('role', 'complementary');
    width = 247;
    recent.scrollTop = 0;
    mocks.resizeReading?.();
    container.removeAttribute('role');
    width = 928;
    mocks.resizeReading?.();
    expect(container.querySelector('[data-testid="schedule-recent-completed"]')).toBe(recent);
    expect(container.querySelector('[data-view="week"]')).not.toBeNull();
    expect(recent.scrollTop).toBe(123);
  });

  it('restores local list reading once and respects later user scrolling', async () => {
    const work = ownerRead({ id: 'reading', titleRef: 'message:reading', timeRole: 'review_by', time: now });
    work.timeRefs = [];
    mocks.ownerReads = [work];
    const open = vi.fn<(artifact: PreparedArtifactCoordinate, itemRef: string, title?: string) => void>();
    open.mockImplementation((_artifact, itemRef) => {
      root.render(<ProductSchedulePanel now={() => now} selectedItemRef={itemRef} onOpenArtifact={open} />);
    });
    await act(async () => root.render(<ProductSchedulePanel now={() => now} onOpenArtifact={open} />));
    const port = container.querySelector<HTMLDivElement>('[data-testid="schedule-unscheduled"]');
    if (!port) throw new Error('expected the original Schedule list');
    let width = 928;
    Object.defineProperty(port, 'clientWidth', { get: () => width });
    port.scrollTop = 4051;
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="product-schedule-open-artifact"]')?.click(),
    );
    container.setAttribute('role', 'complementary');
    width = 247;
    port.scrollTop = 0;
    mocks.resizeReading?.();
    container.removeAttribute('role');
    width = 928;
    mocks.resizeReading?.();
    expect(port.scrollTop).toBe(4051);
    port.scrollTop = 2000;
    container.setAttribute('role', 'complementary');
    width = 247;
    mocks.resizeReading?.();
    container.removeAttribute('role');
    width = 928;
    mocks.resizeReading?.();
    expect(port.scrollTop).toBe(2000);
  });

  it('keeps a locally opened result at its reading point but reveals an external return target', async () => {
    const local = ownerRead({ id: 'local', titleRef: 'message:local', timeRole: 'review_by', time: now });
    const external = ownerRead({ id: 'external', titleRef: 'message:external', timeRole: 'review_by', time: now });
    local.timeRefs = [];
    external.timeRefs = [];
    mocks.ownerReads = [local, external];
    const reveal = vi.fn();
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: reveal });
    const open = vi.fn<(artifact: PreparedArtifactCoordinate, itemRef: string, title?: string) => void>();
    open.mockImplementation((_artifact, itemRef) => {
      root.render(<ProductSchedulePanel now={() => now} selectedItemRef={itemRef} onOpenArtifact={open} />);
    });
    try {
      await act(async () => root.render(<ProductSchedulePanel now={() => now} onOpenArtifact={open} />));
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-subject-ref="task:work:local"] [data-testid="product-schedule-open-artifact"]',
          )
          ?.click(),
      );
      expect(open).toHaveBeenCalledOnce();
      expect(reveal).not.toHaveBeenCalled();
      await act(async () =>
        root.render(
          <ProductSchedulePanel now={() => now} selectedItemRef={scheduleItemRef(external)} onOpenArtifact={open} />,
        ),
      );
      expect(reveal).toHaveBeenCalledOnce();
      await act(async () =>
        root.render(
          <ProductSchedulePanel now={() => now} selectedItemRef={scheduleItemRef(local)} onOpenArtifact={open} />,
        ),
      );
      expect(reveal).toHaveBeenCalledTimes(2);
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', original);
      else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
    }
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
