import { summarizeWatcherDailyRow, type WatcherDailyRow } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fetcher = vi.fn();
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => fetcher(...args) }));

import { WatcherDailyUsage } from '../WatcherDailyUsage';

type Facts = Omit<WatcherDailyRow, 'threadId' | 'title' | 'count' | 'wakeIds'>;
const reported: Facts = {
  unattributedLegacy: [],
  knownTotals: {
    inputTokens: 50041,
    outputTokens: 1961,
    cacheReadTokens: 30848,
    cacheCreationTokens: null,
    rewrittenTokens: null,
    workingContextTokens: 27023,
  },
  modelAttempts: 6,
  failed: 1,
  inputTokens: 50041,
  outputTokens: 1961,
  cacheReadTokens: 30848,
  cacheCreationTokens: null,
  rewrittenTokens: null,
  workingContextTokens: 27023,
  usageSamples: 6,
  reportedUsageSamples: 6,
  legacyRecords: 0,
  coverage: {
    inputTokens: 6,
    outputTokens: 6,
    cacheReadTokens: 6,
    cacheCreationTokens: 0,
    rewrittenTokens: 0,
    workingContextTokens: 6,
  },
  cacheRatio: { inputTokens: 50041, cacheReadTokens: 30848, samples: 6 },
  contributions: [
    {
      invocationId: 'reported',
      wakeId: 'cat:source',
      failed: true,
      legacy: false,
      usages: Array.from({ length: 6 }, (_, i) => ({
        reportedAt: i,
        inputTokens: i === 0 ? 50036 : 1,
        outputTokens: i === 0 ? 1956 : 1,
        cacheReadTokens: i === 0 ? 30843 : 1,
        workingContextTokens: i === 0 ? 27023 : 10,
      })),
    },
  ],
};
const unknown: Facts = {
  ...reported,
  knownTotals: {
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    rewrittenTokens: null,
    workingContextTokens: null,
  },
  modelAttempts: 1,
  failed: 0,
  inputTokens: null,
  outputTokens: null,
  cacheReadTokens: null,
  workingContextTokens: null,
  usageSamples: 1,
  reportedUsageSamples: 0,
  coverage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    rewrittenTokens: 0,
    workingContextTokens: 0,
  },
  cacheRatio: { inputTokens: 0, cacheReadTokens: 0, samples: 0 },
  contributions: [{ invocationId: 'unreported', wakeId: 'cat:source', failed: false, legacy: false, usages: [null] }],
};
function row(facts: Facts = reported, threadId = 'line') {
  return { ...facts, threadId, title: threadId, count: 1, wakeIds: ['cat:source'] };
}
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  fetcher.mockReset();
  vi.unstubAllGlobals();
});
async function open() {
  await act(async () => root.render(<WatcherDailyUsage />));
  await act(async () => {
    const details = container.querySelector('details')!;
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
  });
}
async function more() {
  await act(async () =>
    Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === '加载更多记录')!
      .click(),
  );
}

it('keeps known usage across pages, marks the missing request and ignores a replayed page', async () => {
  fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ rows: [row()], nextCursor: 1, hasMore: true }) });
  fetcher.mockResolvedValue({ ok: true, json: async () => ({ rows: [row(unknown)], nextCursor: 2, hasMore: true }) });
  await open();
  expect(container.textContent).toContain('6/6 次有记录');
  expect(container.textContent).toContain('仅已加载部分记录');
  expect(Array.from(container.querySelectorAll('tbody td')).map((cell) => cell.textContent)).toContain('至少 50,041');
  await more();
  await more();
  const cells = Array.from(container.querySelectorAll('tbody td')).map((cell) => cell.textContent);
  expect(cells).toContain('7');
  expect(cells).toContain('6/7 次有记录');
  expect(cells).toContain('至少 50,041');
  expect(cells).toContain('至少 1,961');
  expect(container.textContent).toContain('至少 30,848');
  expect(container.textContent).toContain('61.6%（已报子集）');
  expect(container.textContent).toContain('27,023（6/7 次有记录）');
  expect(container.textContent).not.toContain('至少 27,023');
  expect(container.textContent).toContain('已记录请求预算上界（最大值）');
  expect(container.textContent).toContain('输入 token（含缓存）');
  expect(container.textContent).toContain('未成功执行');
  expect(container.textContent).not.toContain('未完成');
  expect(fetcher.mock.calls[1][0]).toContain('&cursor=1');
});

it('distinguishes an unreported request, a zero-request day and legacy request counts', async () => {
  const zero = {
    ...unknown,
    knownTotals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      rewrittenTokens: 0,
      workingContextTokens: 0,
    },
    modelAttempts: 0,
    usageSamples: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    rewrittenTokens: 0,
    workingContextTokens: 0,
    contributions: [{ invocationId: 'zero', wakeId: 'cat:source', failed: false, legacy: false, usages: [] }],
  };
  const legacy = {
    ...unknown,
    modelAttempts: 0,
    legacyRecords: 1,
    contributions: [{ invocationId: 'legacy', wakeId: 'cat:source', failed: false, legacy: true, usages: [null] }],
  };
  fetcher.mockResolvedValue({
    ok: true,
    json: async () => ({
      rows: [row(unknown, 'missing'), row(zero, 'zero'), row(legacy, 'legacy')],
      nextCursor: 3,
      hasMore: false,
    }),
  });
  await open();
  const rows = Array.from(container.querySelectorAll('tbody tr'));
  expect(rows[0].textContent).toContain('0/1 次有记录');
  expect(rows[0].textContent).toContain('未知');
  expect(rows[1].textContent).toContain('无模型请求');
  expect(Array.from(rows[1].querySelectorAll('td')).map((cell) => cell.textContent)).toContain('0');
  expect(rows[2].textContent).toContain('历史请求数未知');
});

it('continues from an empty filtered page and labels nonterminal pages as a loaded subset', async () => {
  fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ rows: [], nextCursor: 200, hasMore: true }) });
  fetcher.mockResolvedValue({ ok: true, json: async () => ({ rows: [row()], nextCursor: 201, hasMore: false }) });
  await open();
  expect(container.textContent).not.toContain('这一天还没有守望记录');
  expect(container.textContent).toContain('仅已加载部分记录');
  await more();
  expect(container.textContent).toContain('50,041');
  expect(container.textContent).not.toContain('仅已加载部分记录');
});

it('reads old API summaries without request metadata and retains known values across old pages', async () => {
  const old = {
    threadId: 'old',
    title: '旧接口记录',
    count: 1,
    wakeIds: ['old:wake'],
    modelAttempts: 1,
    failed: 0,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 50,
    cacheCreationTokens: null,
    rewrittenTokens: null,
    workingContextTokens: 2000,
  };
  fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ rows: [old], nextCursor: 1, hasMore: true }) });
  fetcher.mockResolvedValue({
    ok: true,
    json: async () => ({
      rows: [{ ...old, inputTokens: null, outputTokens: null, cacheReadTokens: null, workingContextTokens: null }],
      nextCursor: 2,
      hasMore: true,
    }),
  });
  await open();
  expect(container.textContent).toContain('旧版汇总');
  expect(container.textContent).toContain('完整度未知');
  await more();
  await more();
  expect(container.textContent).toContain('日期归属未知');
  expect(container.textContent).toContain('已报输入 100');
  expect(container.textContent).not.toContain('至少 100');
  expect(container.textContent).not.toContain('至少 200');
  expect(container.textContent).not.toContain('无模型请求');
});

it('restarts from the first page once when the API upgrades while paging', async () => {
  const v1 = {
    threadId: 'old-upgrade',
    title: '旧版页',
    count: 1,
    wakeIds: ['old:wake'],
    modelAttempts: 1,
    failed: 0,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 50,
    cacheCreationTokens: null,
    rewrittenTokens: null,
    workingContextTokens: 2000,
  };
  fetcher.mockResolvedValueOnce({ ok: true, json: async () => ({ rows: [v1], nextCursor: 1, hasMore: true }) });
  fetcher.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ usageVersion: 2, rows: [row(unknown)], nextCursor: 2, hasMore: false }),
  });
  fetcher.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ usageVersion: 2, rows: [row()], nextCursor: 3, hasMore: false }),
  });
  await open();
  await more();
  expect(container.textContent).not.toContain('旧版页');
  expect(container.textContent).toContain('6/6 次有记录');
  expect(fetcher.mock.calls[2][0]).not.toContain('cursor=');
});

it('keeps undated whole totals outside daily token bounds and uses same-day legacy proof', async () => {
  const old = {
    invocationId: 'legacy-midnight',
    wakeId: 'old:wake',
    legacy: true,
    failed: false,
    startedAt: Date.parse('2026-11-12T23:59:00Z'),
    endedAt: Date.parse('2026-11-13T00:02:00Z'),
    usages: [{ reportedAt: 1, inputTokens: 100 }],
  };
  const dated = {
    invocationId: 'known-request',
    wakeId: 'new:wake',
    legacy: false,
    failed: false,
    usages: [{ reportedAt: 2, inputTokens: 50 }],
  };
  fetcher.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      usageVersion: 2,
      rows: [summarizeWatcherDailyRow('mixed', [old, dated])],
      nextCursor: 1,
      hasMore: false,
    }),
  });
  fetcher.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      usageVersion: 2,
      rows: [summarizeWatcherDailyRow('same-day', [{ ...old, endedAt: old.startedAt + 1000, legacyDayKnown: true }])],
      nextCursor: 1,
      hasMore: false,
    }),
  });
  await open();
  expect(container.querySelector('table')?.textContent).toContain('至少 50');
  expect(container.querySelector('table')?.textContent).toContain('1/1 条有记录');
  expect(container.querySelector('table')?.textContent).not.toContain('至少 150');
  expect(container.querySelector('[data-testid="watcher-unattributed-usage"]')?.textContent).toContain('已报输入 100');
  expect(container.querySelector('[data-testid="watcher-unattributed-usage"]')?.textContent).toContain(
    'legacy-midnight',
  );
  await act(async () =>
    Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === '查询')
      ?.click(),
  );
  expect(container.querySelector('table')?.textContent).toContain('至少 100');
  expect(container.querySelector('[data-testid="watcher-unattributed-usage"]')).toBeNull();
});
