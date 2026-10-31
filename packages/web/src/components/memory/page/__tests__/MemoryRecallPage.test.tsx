import { type AnchorHTMLAttributes, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryPagePreview } from '../MemoryPagePreview';
import { MemoryRecall } from '../MemoryRecall';
import { deferred, ledger, page, type Reply, response, taste, tasteEntry } from './recall-page-fixture';

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
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  feed = (path) => response(page({ days: Number(new URL(path, 'http://test').searchParams.get('days')) }));
  stats = (path) => response(ledger(Number(new URL(path, 'http://test').searchParams.get('days'))));
  tastes = () => response(taste());
  mocks.fetch.mockImplementation(async (path: string) =>
    path.startsWith('/api/memory/recall/stats')
      ? stats(path)
      : path.startsWith('/api/memory/recall?')
        ? feed(path)
        : path === '/api/memory/taste'
          ? tastes()
          : response(
              path === '/api/evidence/status'
                ? { healthy: true, backend: 'sqlite', docs_count: 2 }
                : { pendingChecks: 0, passedChecks: 6 },
            ),
  );
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

describe('global Recall page', () => {
  it('uses the real shell, independent time/source counts and existing row display without IDs', async () => {
    await render(true);
    expect(container.textContent).toContain('猫发起的检索');
    expect(container.textContent).toContain('通用上下文递送');
    expect(container.textContent).toContain('全部时间');
    expect(container.textContent).toContain('真实对话');
    expect(container.textContent).toContain('真实检索词');
    expect(container.textContent).toContain('没有命中');
    expect(container.textContent).not.toMatch(/还没接进来|thread-coordinate|event-coordinate|inv-event|忽略/);
    expect(mocks.fetch.mock.calls.some(([path]) => String(path).startsWith('/api/recall/events'))).toBe(false);
  });
  it('keeps loading, failure, retry and confirmed empty distinct', async () => {
    const pending = deferred<Reply>();
    feed = () => pending.promise;
    await render();
    expect(flow().textContent).toContain('正在读取召回记录');
    expect(flow().textContent).not.toContain('还没有召回记录');
    await act(async () => pending.resolve(response({}, false)));
    expect(flow().textContent).toContain('暂时读不到召回记录');
    expect(flow().textContent).not.toContain('还没有召回记录');
    feed = () => response(page({ records: [] }));
    await click('重试');
    expect(flow().textContent).toContain('还没有召回记录');
    expect(flow().querySelector('[role="alert"]')).toBeNull();
  });
  it('retains partial records and never calls an incomplete empty projection empty', async () => {
    feed = () => response(page({ readStatus: 'partial', records: [] }));
    await render();
    expect(flow().textContent).toContain('部分读到');
    expect(flow().textContent).not.toContain('还没有召回记录');
    feed = () => response(page({ readStatus: 'partial' }));
    await click('重读');
    expect(flow().textContent).toContain('真实检索词');
    expect(flow().textContent).toContain('部分读到');
  });
  it('rejects malformed success bodies without displaying an empty feed', async () => {
    feed = () => response({ ...page(), replies: null });
    await render();
    expect(flow().textContent).toContain('暂时读不到召回记录');
    expect(flow().textContent).not.toContain('还没有召回记录');
  });
  it('does not replace visible rows with zero counts when independent statistics or tastes fail', async () => {
    stats = () => response({}, false);
    tastes = () => response({}, false);
    await render();
    expect(flow().textContent).toContain('真实检索词');
    const cards = container.querySelector('[aria-label="召回统计"]');
    expect(cards?.textContent).toContain('暂时读不到统计');
    expect(cards?.querySelector('.text-display-sm')).toBeNull();
    expect(container.querySelector('aside')?.textContent).toContain('暂时读不到品味');
  });
  it('rejects statistics for a different window', async () => {
    stats = () => response(ledger(14));
    await render();
    const cards = container.querySelector('[aria-label="召回统计"]');
    expect(cards?.textContent).toContain('暂时读不到统计');
  });
  it('explains bounded reads and reports named outcomes without subtracting overlapping opens', async () => {
    const entry = tasteEntry('taste-example', 5, 5);
    entry.recall!.namedDelivery!.counts = { presented: 5, drilled: 5, applied: 1, dismissed: 1 };
    const ordinary = tasteEntry('not-a-named-trigger', 1);
    ordinary.recall!.namedDelivery = null;
    tastes = () =>
      response({ ...taste([entry, ordinary]), dimensionHints: { presented: 0, drilled: 0, applied: 0, dismissed: 0 } });
    await render();
    const cards = container.querySelector('[aria-label="召回统计"]');
    expect(cards?.textContent).toContain('只算同一次回复里、检索后不久读到结果的情况，可能漏算');
    expect(cards?.textContent).toContain('开场、冷启动时系统补给猫的上下文');
    expect(cards?.textContent).toContain('点开 5 · 采用 1 · 明确不用 1 · 其余 3 次未回报');
    expect(cards?.textContent).toContain('品味维度提示 · 全部时间：没有记录');
    expect(cards?.textContent).not.toContain('部分读到');
  });
  it.each([undefined, null])('keeps absent dimension evidence unavailable (%s)', async (dimensionHints) => {
    tastes = () => response({ ...taste(), dimensionHints });
    await render();
    expect(container.textContent).toContain('品味维度提示 · 全部时间：暂时读不到');
    expect(container.textContent).not.toContain('品味维度提示 · 全部时间：没有记录');
  });
  it('shows verified dimension counts and does not invent zero unreported outcomes for inconsistent historical counts', async () => {
    const entry = tasteEntry('taste-example', 1, 1);
    entry.recall!.namedDelivery!.counts = { presented: 1, drilled: 1, applied: 1, dismissed: 1 };
    tastes = () =>
      response({ ...taste([entry]), dimensionHints: { presented: 2, drilled: 0, applied: 0, dismissed: 0 } });
    await render();
    expect(container.textContent).toContain('品味维度提示 · 全部时间：2 次');
    expect(container.textContent).toContain('未回报次数暂时读不到');
    expect(container.textContent).not.toContain('其余 0 次未回报');
  });
  it('leaves global delivery summaries static while keeping search result expansion', async () => {
    const pull = page().records[0];
    const delivery = {
      ...pull,
      event: {
        ...pull.event,
        id: 'delivery-coordinate',
        source: 'push' as const,
        query: '',
        cueStatus: 'applied' as const,
        results: [{ title: '递送内容', sourceType: 'taste' }],
      },
    };
    feed = () => response(page({ records: [delivery, pull] }));
    await render();
    expect(flow().querySelector('[data-recall-event-id="delivery-coordinate"] button')).toBeNull();
    expect(flow().querySelector('[data-recall-event-id="event-coordinate"] button')).not.toBeNull();
  });
});
