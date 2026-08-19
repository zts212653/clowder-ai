import type { PawFeelInboxItem, PawFeelInboxPage } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));

import { PawFeelInboxSection } from '../PawFeelInboxSection';

function buildItem(
  signalId: string,
  state: PawFeelInboxItem['disposition']['state'],
  overrides: Partial<PawFeelInboxItem> = {},
): PawFeelInboxItem {
  const responsibility: PawFeelInboxItem['responsibility'] =
    state === 'closed' || state === 'duplicate' || state === 'no_action'
      ? { state: 'terminal', validExit: true, exitKind: 'terminal_disposition', evidenceRefs: [] }
      : { state: 'unreviewed', validExit: false, exitKind: 'none', evidenceRefs: [] };
  return {
    disposition: {
      signalId,
      sourceMessageId: `message-${signalId}`,
      sourceThreadId: 'thread-source',
      sourceCatId: 'codex-sol',
      markerDigest: `digest-${signalId}`,
      sameDigestOrdinal: 0,
      markerIndex: 0,
      state,
      sequence: 1,
      discoveredAt: '2026-07-20T00:00:00.000Z',
      lastTransitionAt: '2026-07-20T00:00:00.000Z',
      backfilled: false,
      captureMethod: 'typed',
      captureAssessment: 'confirmed',
    },
    responsibility,
    source: {
      availability: 'available',
      preview: `原消息预览 ${signalId}`,
      sourceHref: `/threads/thread-source?messageId=message-${signalId}`,
      digestVerified: true,
    },
    sourceOccurredAt: '2026-07-19T23:55:00.000Z',
    ageMs: 3_600_000,
    overdue: false,
    deterministicGroupKey: 'tool:cat_cafe_hold_ball',
    ...overrides,
  };
}

function buildPage(overrides: Partial<PawFeelInboxPage> = {}): PawFeelInboxPage {
  const items = overrides.items ?? [];
  return {
    generatedAt: '2026-07-26T00:00:00.000Z',
    projectionStatus: 'available',
    items,
    bundles:
      overrides.bundles ??
      items.map((item) => ({
        bundleKey: `signal:${item.disposition.signalId}`,
        basis: 'single_signal',
        sourceThreadId: item.disposition.sourceThreadId,
        representativeSourceMessageId: item.disposition.sourceMessageId,
        members: [item],
        rawSignalCount: 1,
        stateCounts: { [item.disposition.state]: 1 },
        responsibility: item.responsibility,
      })),
    bundleCounts: overrides.bundleCounts ?? {
      total: overrides.counts?.total ?? items.length,
      byBasis: {
        message: 0,
        turn_invocation: 0,
        legacy_invocation: 0,
        single_signal: items.length,
      },
    },
    denominator: overrides.denominator ?? {
      reportOccurrences: overrides.counts?.total ?? items.length,
      uniqueSourceMessages: new Set(items.map((item) => item.disposition.sourceMessageId)).size,
      historicalBackfill: items.filter((item) => item.disposition.backfilled).length,
      postActivationIntake: items.filter((item) => !item.disposition.backfilled).length,
      typedConfirmed: items.filter((item) => item.disposition.captureMethod === 'typed').length,
      ambiguousOrContaminated: items.filter((item) => item.disposition.captureAssessment !== 'confirmed').length,
      reviewBundles: overrides.counts?.total ?? items.length,
      problemFamilies: { status: 'unavailable', reason: 'No authoritative grouping contract' },
    },
    counts: {
      total: 0,
      unseen: 0,
      inProgress: 0,
      routePending: 0,
      disposed: 0,
      overdue: 0,
    },
    responsibilityCounts: overrides.responsibilityCounts ?? {
      unreviewed: Math.max(0, (overrides.counts?.total ?? items.length) - (overrides.counts?.disposed ?? 0)),
      bound_in_repair: 0,
      signature_waiting: 0,
      blocked: 0,
      terminal: overrides.counts?.disposed ?? 0,
    },
    degraded: false,
    coverage: {
      coverageStartAt: '2026-07-19T00:00:00.000Z',
      lastFullScanCompletedAt: '2026-07-26T00:00:00.000Z',
      status: 'healthy',
      lagMs: 0,
    },
    ...overrides,
  };
}

describe('PawFeelInboxSection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.apiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('keeps every ledger row visible when semantic grouping is degraded', async () => {
    const routed = buildItem('routed', 'routed', {
      disposition: {
        ...buildItem('routed', 'routed').disposition,
        lastActorCatId: 'sonnet',
        targetThreadId: 'thread-owner',
      },
    });
    const unavailable = buildItem('unavailable', 'new', {
      ageMs: 4 * 24 * 3_600_000,
      overdue: true,
      source: {
        availability: 'unavailable',
        reason: 'source message missing',
        sourceHref: '/threads/thread-source?messageId=message-unavailable',
      },
    });
    const page = buildPage({
      items: [routed, unavailable],
      counts: {
        total: 2,
        unseen: 1,
        inProgress: 0,
        routePending: 0,
        disposed: 1,
        overdue: 1,
      },
      degraded: true,
    });
    mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => page });

    await act(async () => {
      root.render(<PawFeelInboxSection pollMs={0} variant="history" />);
    });
    await act(async () => {});

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/paw-feel/inbox?limit=50&sort=oldest');
    expect(container.querySelectorAll('[data-testid="paw-feel-inbox-bundle"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-testid="paw-feel-inbox-row"]')).toHaveLength(0);
    expect(container.textContent).toContain('此页面当前不提供 live 语义分组');
    expect(container.textContent).toContain('确定性上下文审阅包与全部原始报告继续可见');
    expect(container.textContent).not.toContain('工具分组');
    const expandButtons = Array.from(container.querySelectorAll('button')).filter((button) =>
      button.textContent?.includes('展开 1 条原始报告'),
    );
    await act(async () => {
      for (const button of expandButtons) {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
    });
    expect(container.textContent).toContain('已移交至 thread-owner，不代表已经修复');
    expect(container.textContent).toContain('原始证据暂不可读：source message missing');
    expect(container.textContent).toContain('72h+');
    expect(container.textContent).toContain('覆盖正常');
  });

  it('uses server-side filters without treating them as visibility admission', async () => {
    mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => buildPage() });

    await act(async () => {
      root.render(<PawFeelInboxSection pollMs={0} />);
    });
    await act(async () => {});

    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/paw-feel/inbox?limit=50&sort=newest&states=new%2Cseen%2Croute_pending%2Crouted%2Cfix%2Csignature_waiting%2Cblocked',
    );

    const filterTrigger = container.querySelector<HTMLButtonElement>('[data-testid="paw-feel-filter-trigger"]');
    await act(async () => {
      filterTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const allButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.startsWith('全部'),
    );
    await act(async () => {
      allButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {});

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/paw-feel/inbox?limit=50&sort=newest');
    expect(container.textContent).toContain('完整历史仍保留在同一台账中');

    await act(async () => {
      filterTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const overdueButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.startsWith('72h+'),
    );
    await act(async () => {
      overdueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {});
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/paw-feel/inbox?limit=50&sort=newest&states=new%2Cseen%2Croute_pending%2Crouted%2Cfix%2Csignature_waiting%2Cblocked&overdueOnly=true',
    );
  });

  it('keeps secondary filters and diagnostic counts behind compact disclosure menus', async () => {
    const page = buildPage({
      denominator: {
        reportOccurrences: 614,
        uniqueSourceMessages: 446,
        reviewBundles: 442,
        historicalBackfill: 417,
        postActivationIntake: 197,
        typedConfirmed: 63,
        ambiguousOrContaminated: 551,
        problemFamilies: { status: 'unavailable', reason: 'No authoritative grouping contract' },
      },
      counts: {
        total: 614,
        unseen: 397,
        inProgress: 12,
        routePending: 8,
        disposed: 197,
        overdue: 3,
      },
      bundleCounts: {
        total: 442,
        byBasis: { message: 300, turn_invocation: 100, legacy_invocation: 40, single_signal: 2 },
      },
    });
    mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => page });

    await act(async () => {
      root.render(<PawFeelInboxSection pollMs={0} />);
    });
    await act(async () => {});

    const summary = container.querySelector('[data-testid="paw-feel-primary-summary"]');
    expect(summary).toBeTruthy();
    const summaryMetrics = summary?.querySelectorAll('[data-testid="paw-feel-summary-metric"]');
    expect(summaryMetrics).toHaveLength(6);
    for (const metric of summaryMetrics ?? []) expect(metric.classList.contains('whitespace-nowrap')).toBe(true);
    expect(summary?.textContent).toContain('unreviewed417');
    expect(summary?.textContent).toContain('terminal197');
    expect(summary?.textContent).toContain('72h+3');

    const filterTrigger = container.querySelector<HTMLButtonElement>('[data-testid="paw-feel-filter-trigger"]');
    const sortTrigger = container.querySelector<HTMLButtonElement>('[data-testid="paw-feel-sort-trigger"]');
    const detailsTrigger = container.querySelector<HTMLButtonElement>('[data-testid="paw-feel-details-trigger"]');
    expect(filterTrigger?.getAttribute('aria-haspopup')).toBe('menu');
    expect(sortTrigger?.getAttribute('aria-haspopup')).toBe('menu');
    expect(detailsTrigger?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(container.querySelector('[data-testid="paw-feel-filter-menu"]')).toBeNull();
    expect(container.querySelector('[data-testid="paw-feel-details-menu"]')).toBeNull();

    await act(async () => {
      filterTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const filterMenu = container.querySelector('[data-testid="paw-feel-filter-menu"]');
    expect(filterMenu?.getAttribute('role')).toBe('menu');
    expect(filterMenu?.textContent).toContain('全部');
    expect(filterMenu?.textContent).toContain('已处置');

    await act(async () => {
      detailsTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const detailsMenu = container.querySelector('[data-testid="paw-feel-details-menu"]');
    expect(detailsMenu?.getAttribute('role')).toBe('dialog');
    expect(detailsMenu?.textContent).toContain('报告 occurrences');
    expect(detailsMenu?.textContent).toContain('歧义 / 污染');
    expect(container.querySelectorAll('[data-testid="paw-feel-count-card"]')).toHaveLength(0);
  });

  it('appends the next ledger page without duplicating an existing signal', async () => {
    const first = buildItem('one', 'new');
    const second = buildItem('two', 'seen');
    mocks.apiFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ config: null }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          buildPage({
            items: [first],
            counts: { total: 2, unseen: 1, inProgress: 1, routePending: 0, disposed: 0, overdue: 0 },
            nextCursor: 'cursor-2',
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () =>
          buildPage({
            items: [first, second],
            counts: { total: 2, unseen: 1, inProgress: 1, routePending: 0, disposed: 0, overdue: 0 },
          }),
      });

    await act(async () => {
      root.render(<PawFeelInboxSection pollMs={0} />);
    });
    await act(async () => {});

    const loadMore = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '再看 50 条',
    );
    await act(async () => {
      loadMore?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {});

    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/paw-feel/inbox?limit=50&sort=newest&states=new%2Cseen%2Croute_pending%2Crouted%2Cfix%2Csignature_waiting%2Cblocked&cursor=cursor-2',
    );
    expect(container.querySelectorAll('[data-testid="paw-feel-inbox-bundle"]')).toHaveLength(2);
    expect(container.textContent?.match(/原消息预览 one/g)).toHaveLength(1);
  });

  it('shows ledger failure independently from the periodic Eval surface', async () => {
    mocks.apiFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });

    await act(async () => {
      root.render(<PawFeelInboxSection pollMs={0} />);
    });
    await act(async () => {});

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('爪感差收件箱请求失败 (503)');
  });

  it('separates original occurrence time from backfill discovery and SLA age', async () => {
    const item = buildItem('backfilled', 'new', {
      sourceOccurredAt: '2026-07-27T11:59:00.000Z',
      ageMs: 12 * 3_600_000,
      disposition: {
        ...buildItem('backfilled', 'new').disposition,
        discoveredAt: '2026-07-27T00:00:00.000Z',
        backfilled: true,
      },
    });
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      json: async () =>
        buildPage({
          items: [item],
          counts: { total: 1, unseen: 1, inProgress: 0, routePending: 0, disposed: 0, overdue: 0 },
        }),
    });

    await act(async () => {
      root.render(<PawFeelInboxSection pollMs={0} variant="history" />);
    });
    await act(async () => {});

    const expand = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('展开 1 条原始报告'),
    );
    await act(async () => {
      expand?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('原消息时间');
    expect(container.textContent).toContain('入箱 / SLA');
    expect(container.textContent).toContain('历史回填');
    expect(container.textContent).not.toContain('已等待 12 小时');
  });

  it('makes an unassigned duty roster prominent in Workspace without guessing an owner', async () => {
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/paw-feel/duty') {
        return { ok: true, json: async () => ({ config: null }) };
      }
      return {
        ok: true,
        json: async () =>
          buildPage({
            counts: { total: 9, unseen: 7, inProgress: 0, routePending: 0, disposed: 2, overdue: 3 },
            denominator: {
              reportOccurrences: 9,
              uniqueSourceMessages: 7,
              historicalBackfill: 6,
              postActivationIntake: 3,
              typedConfirmed: 3,
              ambiguousOrContaminated: 6,
              reviewBundles: 5,
              problemFamilies: { status: 'unavailable', reason: 'No authoritative grouping contract' },
            },
            bundleCounts: {
              total: 5,
              byBasis: { message: 2, turn_invocation: 1, legacy_invocation: 1, single_signal: 1 },
            },
          }),
      };
    });

    await act(async () => {
      root.render(<PawFeelInboxSection pollMs={0} />);
    });
    await act(async () => {});

    expect(container.textContent).toContain('当前无人值班');
    expect(container.textContent).toContain('尚未开始责任审阅');
    expect(container.textContent).toContain('0 / 2 位值班猫');
    expect(container.textContent).toContain('9 条报告');
    expect(container.textContent).toContain('5 个审阅包');
    expect(container.textContent).toContain('3 条 72h+');
    expect(container.textContent).not.toContain('@codex-sol 负责值班');
  });

  it('fails loud on a legacy primary-only duty config instead of showing green 1/2 ownership', async () => {
    const page = buildPage({
      items: [buildItem('partial-duty', 'new')],
      counts: { total: 1, unseen: 1, inProgress: 0, routePending: 0, disposed: 0, overdue: 0 },
    });
    mocks.apiFetch.mockImplementation(async (url: string) =>
      url === '/api/paw-feel/duty'
        ? {
            ok: true,
            json: async () => ({
              config: {
                systemThreadId: 'thread_eval_friction',
                primaryCatId: 'opus',
                version: 2,
                updatedAt: '2026-07-30T00:00:00.000Z',
                updatedBy: 'you',
              },
            }),
          }
        : { ok: true, json: async () => page },
    );

    await act(async () => {
      root.render(<PawFeelInboxSection pollMs={0} />);
    });
    await act(async () => {});

    expect(container.textContent).toContain('值班配置不完整');
    expect(container.textContent).toContain('0 / 2 位可运营值班猫');
    expect(container.textContent).not.toContain('值班责任 · 1 / 2');
  });

  it('renders contextual bundles as the work unit and exposes three truthful actions', async () => {
    const first = buildItem('one', 'new', { ageMs: 25 * 3_600_000 });
    const second = buildItem('two', 'new', {
      disposition: {
        ...buildItem('two', 'new').disposition,
        sourceMessageId: first.disposition.sourceMessageId,
      },
      ageMs: 25 * 3_600_000,
    });
    const page = buildPage({
      items: [first, second],
      bundles: [
        {
          bundleKey: `message:${first.disposition.sourceMessageId}`,
          basis: 'message',
          sourceThreadId: 'thread-source',
          representativeSourceMessageId: first.disposition.sourceMessageId,
          members: [first, second],
          rawSignalCount: 2,
          stateCounts: { new: 2 },
          responsibility: first.responsibility,
        },
      ],
      bundleCounts: {
        total: 1,
        byBasis: { message: 1, turn_invocation: 0, legacy_invocation: 0, single_signal: 0 },
      },
      denominator: {
        reportOccurrences: 2,
        uniqueSourceMessages: 1,
        historicalBackfill: 0,
        postActivationIntake: 2,
        typedConfirmed: 2,
        ambiguousOrContaminated: 0,
        reviewBundles: 1,
        problemFamilies: { status: 'unavailable', reason: 'No authoritative grouping contract' },
      },
      counts: { total: 2, unseen: 2, inProgress: 0, routePending: 0, disposed: 0, overdue: 0 },
    });
    mocks.apiFetch.mockImplementation(async (url: string) =>
      url === '/api/paw-feel/duty'
        ? {
            ok: true,
            json: async () => ({
              config: {
                systemThreadId: 'thread_eval_friction',
                primaryCatId: 'opus',
                backupCatId: 'kimi',
                version: 1,
                updatedAt: '2026-07-30T00:00:00.000Z',
                updatedBy: 'user-1',
              },
            }),
          }
        : { ok: true, json: async () => page },
    );

    await act(async () => {
      root.render(<PawFeelInboxSection pollMs={0} />);
    });
    await act(async () => {});

    expect(container.querySelectorAll('[data-testid="paw-feel-inbox-bundle"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="paw-feel-inbox-row"]')).toHaveLength(0);
    expect(container.textContent).toContain('同一消息 · 2 条报告');
    expect(container.textContent).toContain('问题族数不可可靠计算');
    const bundleCard = container.querySelector('[data-testid="paw-feel-inbox-bundle"]');
    const sourceLink = bundleCard?.querySelector<HTMLAnchorElement>('a[title="原消息预览 one"]');
    expect(sourceLink?.classList.contains('truncate')).toBe(true);
    expect(sourceLink?.classList.contains('min-w-0')).toBe(true);
    expect(bundleCard?.textContent).not.toContain('@opus');

    const detailsTrigger = container.querySelector<HTMLButtonElement>('[data-testid="paw-feel-details-trigger"]');
    await act(async () => {
      detailsTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const details = container.querySelector('[data-testid="paw-feel-details-menu"]');
    expect(details?.textContent).toContain('重复');
    expect(details?.textContent).toContain('不修');
    expect(details?.textContent).toContain('要修');
    expect(details?.textContent).toContain('Primary 持续负责');
    expect(details?.textContent).toContain('Backup 仅在显式交接后接班');
    expect(details?.textContent).toContain('报告猫不能签自己的 terminal');
    expect(details?.textContent).toContain('真实 task、owner 与 active F167 lease');

    const expand = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('展开 2 条原始报告'),
    );
    await act(async () => {
      expand?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelectorAll('[data-testid="paw-feel-inbox-row"]')).toHaveLength(2);
  });

  it('defaults Workspace to newest reports and lets the operator switch to oldest backlog', async () => {
    mocks.apiFetch.mockResolvedValue({ ok: true, json: async () => buildPage() });

    await act(async () => {
      root.render(<PawFeelInboxSection pollMs={0} />);
    });
    await act(async () => {});

    const sortTrigger = container.querySelector<HTMLButtonElement>('[data-testid="paw-feel-sort-trigger"]');
    await act(async () => {
      sortTrigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const oldestButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '最久未处理',
    );
    expect(oldestButton).toBeTruthy();
    await act(async () => {
      oldestButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {});

    expect(mocks.apiFetch).toHaveBeenCalledWith(
      '/api/paw-feel/inbox?limit=50&sort=oldest&states=new%2Cseen%2Croute_pending%2Crouted%2Cfix%2Csignature_waiting%2Cblocked',
    );
  });

  it('announces newly arrived reports during polling and jumps back to newest', async () => {
    vi.useFakeTimers();
    try {
      let inboxReads = 0;
      mocks.apiFetch.mockImplementation(async (url: string) => {
        if (url === '/api/paw-feel/duty') {
          return { ok: true, json: async () => ({ config: { primaryCatId: 'opus' } }) };
        }
        inboxReads += 1;
        const items = inboxReads === 1 ? [buildItem('one', 'new')] : [buildItem('two', 'new'), buildItem('one', 'new')];
        return {
          ok: true,
          json: async () =>
            buildPage({
              items,
              counts: {
                total: items.length,
                unseen: items.length,
                inProgress: 0,
                routePending: 0,
                disposed: 0,
                overdue: 0,
              },
            }),
        };
      });

      await act(async () => {
        root.render(<PawFeelInboxSection pollMs={100} />);
      });
      await act(async () => {});
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const newButton = Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('新增 1 条'),
      );
      expect(newButton).toBeTruthy();
      await act(async () => {
        newButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      expect(container.textContent).not.toContain('新增 1 条');
    } finally {
      vi.useRealTimers();
    }
  });
});
