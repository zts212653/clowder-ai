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

async function chooseViewOption(container: HTMLElement, kind: 'filter' | 'sort', label: string) {
  const trigger = container.querySelector<HTMLButtonElement>(`[data-testid="paw-feel-${kind}-trigger"]`);
  await act(async () => trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  const option = Array.from(container.querySelectorAll<HTMLButtonElement>('button[role="menuitemradio"]')).find(
    (button) => button.textContent?.startsWith(label),
  );
  expect(option).toBeTruthy();
  await act(async () => option?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await act(async () => {});
}

function buildItem(signalId: string, state: PawFeelInboxItem['disposition']['state']): PawFeelInboxItem {
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
      historicalBackfill: 0,
      postActivationIntake: items.length,
      typedConfirmed: items.length,
      ambiguousOrContaminated: 0,
      reviewBundles: overrides.counts?.total ?? items.length,
      problemFamilies: { status: 'unavailable', reason: 'No authoritative grouping contract' },
    },
    counts: { total: 0, unseen: 0, inProgress: 0, routePending: 0, disposed: 0, overdue: 0 },
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

function buildManualReturnActivePage(readCount: number): PawFeelInboxPage {
  const initial = readCount === 1;
  return buildPage({
    items: initial ? [buildItem('existing', 'new')] : [buildItem('fresh', 'new'), buildItem('existing', 'new')],
    counts: {
      total: initial ? 1 : 2,
      unseen: initial ? 1 : 2,
      inProgress: 0,
      routePending: 0,
      disposed: initial ? 0 : 1,
      overdue: 0,
    },
  });
}

describe('PawFeelInboxSection polling navigation', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.apiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('returns to the active filter when viewing a new report from a filtered inbox', async () => {
    let activeReads = 0;
    let disposedReads = 0;
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/paw-feel/duty') {
        return { ok: true, json: async () => ({ config: { primaryCatId: 'opus' } }) };
      }
      if (url.includes('states=closed%2Cduplicate%2Cno_action')) {
        disposedReads += 1;
        return {
          ok: true,
          json: async () =>
            buildPage({
              items: [buildItem('closed', 'closed')],
              counts: {
                total: disposedReads === 1 ? 1 : 2,
                unseen: disposedReads === 1 ? 0 : 1,
                inProgress: 0,
                routePending: 0,
                disposed: 1,
                overdue: 0,
              },
            }),
        };
      }
      activeReads += 1;
      const items =
        activeReads === 1 ? [buildItem('existing', 'new')] : [buildItem('fresh', 'new'), buildItem('existing', 'new')];
      return {
        ok: true,
        json: async () =>
          buildPage({
            items,
            counts: {
              total: activeReads === 1 ? 1 : 2,
              unseen: activeReads === 1 ? 1 : 2,
              inProgress: 0,
              routePending: 0,
              disposed: activeReads === 1 ? 0 : 1,
              overdue: 0,
            },
          }),
      };
    });

    await act(async () => root.render(<PawFeelInboxSection pollMs={100} />));
    await act(async () => {});
    await chooseViewOption(container, 'filter', '已处置');
    await act(async () => vi.advanceTimersByTimeAsync(100));

    const newestButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('新增 1 条'),
    );
    await act(async () => newestButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => {});

    expect(mocks.apiFetch).toHaveBeenLastCalledWith(
      '/api/paw-feel/inbox?limit=50&sort=newest&states=new%2Cseen%2Croute_pending%2Crouted%2Cfix%2Csignature_waiting%2Cblocked',
    );
    expect(container.textContent).toContain('原消息预览 fresh');
    expect(container.textContent).not.toContain('原消息预览 closed');
  });

  it('acknowledges new reports when the operator manually returns to active newest', async () => {
    let activeReads = 0;
    let disposedReads = 0;
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/paw-feel/duty') {
        return { ok: true, json: async () => ({ config: { primaryCatId: 'opus' } }) };
      }
      if (url.includes('states=closed%2Cduplicate%2Cno_action')) {
        disposedReads += 1;
        return {
          ok: true,
          json: async () =>
            buildPage({
              items: [buildItem('closed', 'closed')],
              counts: {
                total: disposedReads === 1 ? 1 : 2,
                unseen: disposedReads === 1 ? 0 : 1,
                inProgress: 0,
                routePending: 0,
                disposed: 1,
                overdue: 0,
              },
            }),
        };
      }
      activeReads += 1;
      return {
        ok: true,
        json: async () => buildManualReturnActivePage(activeReads),
      };
    });

    await act(async () => root.render(<PawFeelInboxSection pollMs={100} />));
    await act(async () => {});
    await chooseViewOption(container, 'filter', '已处置');
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(container.textContent).toContain('新增 1 条');

    await chooseViewOption(container, 'filter', '待处置');

    expect(container.textContent).toContain('原消息预览 fresh');
    expect(container.textContent).not.toContain('新增 1 条');
  });

  it('keeps the new-report notice until navigation reaches active newest', async () => {
    let inboxReads = 0;
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/paw-feel/duty') {
        return { ok: true, json: async () => ({ config: { primaryCatId: 'opus' } }) };
      }
      inboxReads += 1;
      const items =
        inboxReads === 1 ? [buildItem('existing', 'new')] : [buildItem('fresh', 'new'), buildItem('existing', 'new')];
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

    await act(async () => root.render(<PawFeelInboxSection pollMs={100} />));
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(container.textContent).toContain('新增 1 条');

    await chooseViewOption(container, 'sort', '最久未处理');
    expect(container.textContent).toContain('新增 1 条');

    await chooseViewOption(container, 'sort', '最新上报');
    expect(container.textContent).not.toContain('新增 1 条');
  });

  it('keeps appended backlog rows in place while polling page one', async () => {
    let firstPageReads = 0;
    mocks.apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/paw-feel/duty') {
        return { ok: true, json: async () => ({ config: { primaryCatId: 'opus' } }) };
      }
      if (url.includes('cursor=cursor-2')) {
        return {
          ok: true,
          json: async () =>
            buildPage({
              items: [buildItem('second-page', 'new')],
              counts: { total: 2, unseen: 2, inProgress: 0, routePending: 0, disposed: 0, overdue: 0 },
            }),
        };
      }
      firstPageReads += 1;
      return {
        ok: true,
        json: async () =>
          buildPage({
            items: [buildItem('first-page', 'new')],
            counts: { total: 2, unseen: 2, inProgress: 0, routePending: 0, disposed: 0, overdue: 0 },
            nextCursor: 'cursor-2',
          }),
      };
    });

    await act(async () => root.render(<PawFeelInboxSection pollMs={100} />));
    await act(async () => {});
    const loadMore = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '再看 50 条',
    );
    await act(async () => loadMore?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(100));

    expect(firstPageReads).toBe(2);
    expect(container.textContent).toContain('原消息预览 first-page');
    expect(container.textContent).toContain('原消息预览 second-page');
    expect(container.querySelectorAll('[data-testid="paw-feel-inbox-bundle"]')).toHaveLength(2);
  });
});
