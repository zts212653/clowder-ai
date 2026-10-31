import { type AnchorHTMLAttributes, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryPagePreview } from '../MemoryPagePreview';
import { MemoryRecall } from '../MemoryRecall';
import { deferred, ledger, page, type Reply, recallRow, response, taste, tasteEntry } from './recall-page-fixture';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), teleport: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.fetch }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [{ id: 'sonnet', nickname: '宪宪' }],
    getCatById: (id: string) => (id === 'sonnet' ? { nickname: '宪宪' } : undefined),
  }),
}));
vi.mock('@/hooks/useTeleport', () => ({ handleTeleportEvent: mocks.teleport }));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => <span>猫头像</span> }));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>,
}));
let container: HTMLDivElement;
let root: Root;
let feed: (path: string) => Reply | Promise<Reply>;
let stats: (path: string) => Reply | Promise<Reply>;
let tastes: () => Reply | Promise<Reply>;
const flow = () => container.querySelector('section[aria-label="所有对话的召回流水"]') as HTMLElement;
const button = (text: string) =>
  [...container.querySelectorAll('button')].find((node) => node.textContent === text) as HTMLButtonElement;
const render = async (shell = false) =>
  act(async () => root.render(shell ? <MemoryPagePreview tab="recall" shell="v2" /> : <MemoryRecall />));
const click = async (text: string) => act(async () => button(text).click());
const select = async (label: string, value: string) =>
  act(async () => {
    const node = container.querySelector(`select[aria-label="${label}"]`) as HTMLSelectElement;
    node.value = value;
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  feed = (path) => response(page({ days: Number(new URL(path, 'http://test').searchParams.get('days')) }));
  stats = (path) => response(ledger(Number(new URL(path, 'http://test').searchParams.get('days'))));
  tastes = () => response(taste());
  mocks.fetch.mockImplementation(async (path: string) => {
    if (path.startsWith('/api/memory/recall/stats')) return stats(path);
    if (path.startsWith('/api/memory/recall?')) return feed(path);
    if (path === '/api/memory/taste') return tastes();
    if (path.startsWith('/api/memory/taste/')) return response({}, false);
    return response(
      path === '/api/evidence/status'
        ? { healthy: true, backend: 'sqlite', docs_count: 2 }
        : { pendingChecks: 0, passedChecks: 6 },
    );
  });
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('global Recall navigation and pagination', () => {
  it('changes window and source/cat filters while rejecting a late old-window response', async () => {
    const old = deferred<Reply>();
    feed = () => old.promise;
    await render();
    feed = (path) =>
      response(
        page({
          days: Number(new URL(path, 'http://test').searchParams.get('days')),
          records: [recallRow('new', '新窗口')],
        }),
      );
    await click('近 14 天');
    await act(async () => old.resolve(response(page({ records: [recallRow('old', '旧窗口')] }))));
    expect(flow().textContent).toContain('新窗口');
    expect(flow().textContent).not.toContain('旧窗口');
    await click('近 30 天');
    await select('筛选召回来源', 'push');
    await select('筛选猫', 'sonnet');
    expect(
      mocks.fetch.mock.calls.some(([path]) => path === '/api/memory/recall?days=30&source=push&catId=sonnet'),
    ).toBe(true);
    expect(mocks.fetch.mock.calls.filter(([path]) => path === '/api/memory/taste')).toHaveLength(1);
  });
  it('preserves the first page after failure and deduplicates a successful retry', async () => {
    feed = () => response(page({ nextCursor: 'cursor-one' }));
    await render();
    feed = () => response({}, false);
    await click('读取更早的记录');
    expect(flow().textContent).toContain('真实检索词');
    expect(flow().textContent).toContain('暂时读不到更早的记录');
    feed = () =>
      response(
        page({
          records: [recallRow(), recallRow('second', '更早的检索'), recallRow('second', '更早的检索')],
          nextCursor: null,
        }),
      );
    await click('重试更早的记录');
    expect(flow().querySelectorAll('article')).toHaveLength(2);
    await act(async () =>
      (flow().querySelectorAll('article')[1].querySelector('button[aria-expanded]') as HTMLButtonElement).click(),
    );
    expect(flow().textContent).toContain('更早的检索');
    expect(flow().querySelector('[role="alert"]')).toBeNull();
  });
  it('rejects pagination that moves the snapshot upper boundary', async () => {
    feed = () => response(page({ nextCursor: 'cursor-one' }));
    await render();
    feed = () => response(page({ to: 101, records: [recallRow('wrong', '错误快照')] }));
    await click('读取更早的记录');
    expect(flow().textContent).not.toContain('错误快照');
    expect(flow().textContent).toContain('真实检索词');
    expect(flow().textContent).toContain('暂时读不到更早的记录');
  });
  it('locates an exact reply with its own conversation coordinates', async () => {
    feed = () =>
      response(
        page({
          replies: [
            {
              threadId: 'thread-coordinate',
              messageId: 'message-coordinate',
              catId: 'sonnet',
              invocationId: 'inv-event-coordinate',
              timestamp: 90,
            },
          ],
        }),
      );
    await render();
    await act(async () => {
      button('定位回复').click();
      button('定位回复').click();
    });
    expect(mocks.teleport).toHaveBeenCalledTimes(1);
    expect(mocks.teleport).toHaveBeenCalledWith(
      { threadId: 'thread-coordinate', messageId: 'message-coordinate' },
      null,
      expect.any(Object),
    );
    expect(flow().textContent).not.toContain('message-coordinate');
  });
  it('reloads the taste list when a ranked detail revision cannot be read', async () => {
    tastes = () => response(taste([tasteEntry('taste-coordinate', 1)]));
    await render();
    await act(async () => (container.querySelector('aside button') as HTMLButtonElement).click());
    expect(container.querySelector('[aria-label="品味详情"]')?.textContent).toContain('版本可能已变化');
    await click('重读品味列表');
    expect(container.querySelector('[aria-label="品味详情"]')).toBeNull();
    expect(mocks.fetch.mock.calls.filter(([path]) => path === '/api/memory/taste')).toHaveLength(2);
    expect(flow().textContent).toContain('真实检索词');
  });
  it('ranks five all-time taste hits independently from named delivery counts', async () => {
    tastes = () => response(taste([1, 6, 2, 4, 3, 5].map((hits) => tasteEntry(`taste-coordinate-${hits}`, hits, 2))));
    await render();
    const entries = [...(container.querySelector('aside')?.querySelectorAll('button') ?? [])].map(
      (node) => node.textContent,
    );
    expect(entries).toEqual(
      [6, 5, 4, 3, 2].map((hits, index) => `${index + 1}“保留真实来源”只给你看命中 ${hits} 次点开 0 次`),
    );
    expect(container.querySelector('[aria-label="召回统计"]')?.textContent).toContain('12次');
    expect(container.textContent).not.toContain('taste-coordinate');
  });
});
