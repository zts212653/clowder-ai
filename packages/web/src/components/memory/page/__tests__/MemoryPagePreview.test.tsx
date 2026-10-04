import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryPagePreview } from '../MemoryPagePreview';

const fetchMock = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: routerPush }) }));
vi.mock('@/utils/api-client', () => ({ apiFetch: fetchMock }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: () => ({ nickname: '宪宪', displayName: '布偶猫' }) }),
}));
vi.mock('@/components/CatAvatar', () => ({ CatAvatar: () => <span>猫头像</span> }));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>,
}));
vi.mock('@/hooks/useTeleport', () => ({
  handleTeleportEvent: (
    data: { threadId: string },
    _current: unknown,
    actions: { pushThreadRoute: (id: string) => void },
  ) => actions.pushThreadRoute(data.threadId),
}));

const ok = (value: unknown) => Promise.resolve({ ok: true, json: async () => value });
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  fetchMock.mockImplementation((path: string) =>
    path === '/api/evidence/status'
      ? ok({ healthy: true, backend: 'sqlite', docs_count: 12 })
      : path === '/api/memory/maintenance'
        ? ok({
            pendingChecks: 2,
            passedChecks: 4,
            checks: [{ key: 'orphan', label: '指向不存在文档的关系', count: 6 }],
            generatedAt: '2026-10-02',
          })
        : path === '/api/memory/catalog'
          ? ok({
              collections: [
                {
                  id: 'private:hidden-id',
                  name: '主人资料库',
                  kind: 'domain',
                  visibility: 'private',
                  status: 'active',
                  docCount: 3,
                  lastDocumentUpdatedAt: null,
                  readStatus: 'ready',
                },
              ],
            })
          : path === '/api/memory/library-feed'
            ? ok({
                pending: [
                  {
                    id: 'marker-a',
                    content: '一条真实提议',
                    kind: 'lesson',
                    createdAt: '2026-10-01',
                    collectionName: '内部资料库',
                    state: '待收录',
                  },
                ],
                processed: [],
              })
            : ok({ events: [], meta: { hasMore: false } }),
  );
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});
const render = async (tab: 'library' | 'brakes' | 'all') => {
  await act(async () => root.render(<MemoryPagePreview tab={tab} shell="v2" />));
};

describe('memory page read-only preview', () => {
  it('a verified source opens the full chat route from this global page', async () => {
    const original = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((path: string) =>
      path.startsWith('/api/memory/events?')
        ? ok({
            events: [
              {
                eventId: 'e1',
                ownerUserId: 'owner',
                type: '数学之美',
                trigger: 'human_brake',
                cat: 'sonnet',
                threadId: 'thread-a',
                messageId: 'message-a',
                timestamp: 100,
                summary: '原话',
                confidence: 'high',
                relatedHarness: null,
              },
            ],
            meta: { hasMore: false },
          })
        : path.includes('/brakes/e1/source')
          ? ok({ title: '真实对话', canOpen: true, threadId: 'thread-a', messageId: 'message-a' })
          : original?.(path),
    );
    await render('brakes');
    const link = [...container.querySelectorAll('button')].find((button) => button.textContent === '查看原消息 ↗');
    expect(link).toBeDefined();
    await act(async () => link?.click());
    expect(routerPush).toHaveBeenCalledWith('/thread/thread-a');
  });
  it('keeps four tabs on preview routes and keeps preview writes disabled', async () => {
    await render('library');
    expect([...container.querySelectorAll('nav a')].map((a) => a.textContent)).toEqual([
      '全部记忆',
      '召回记录',
      '拉闸记录',
      '资料库',
    ]);
    expect(
      [...container.querySelectorAll('nav a')].every((a) => a.getAttribute('href')?.startsWith('/memory/preview?')),
    ).toBe(true);
    const writeButtons = [...container.querySelectorAll('button')].filter((b) =>
      ['＋ 新建资料库', '收录', '不收录'].includes(b.textContent ?? ''),
    );
    expect(writeButtons).toHaveLength(3);
    expect(writeButtons.every((b) => b.disabled)).toBe(true);
    expect(container.textContent).not.toContain('hidden-id');
    expect(container.textContent).toContain('主人资料库');
    expect(container.textContent).toContain('私有');
    expect(container.textContent).not.toContain('已接入');
  });
  it('maintenance failure is partial data, never zero maintenance or all healthy', async () => {
    fetchMock.mockImplementation((path: string) =>
      path === '/api/memory/maintenance'
        ? Promise.resolve({ ok: false })
        : path === '/api/evidence/status'
          ? ok({ healthy: true, backend: 'sqlite' })
          : path === '/api/memory/catalog'
            ? ok({ collections: [] })
            : ok({ pending: [], processed: [] }),
    );
    await render('library');
    expect(container.textContent).toContain('部分读到');
    expect(container.textContent).toContain('维护状态暂不可用');
    expect(container.textContent).not.toContain('0 项待维护');
    expect(container.textContent).not.toContain('检查通过');
  });
  it('renders loading and empty brake states independently', async () => {
    let release: (value: unknown) => void = () => {};
    const original = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((path: string) =>
      path.startsWith('/api/memory/events?')
        ? new Promise((resolve) => {
            release = resolve;
          })
        : original?.(path),
    );
    await render('brakes');
    expect(container.textContent).toContain('正在读取拉闸记录');
    expect(container.textContent).not.toContain('0 条消息');
    await act(async () => release({ ok: true, json: async () => ({ events: [], meta: { hasMore: false } }) }));
    expect(container.textContent).toContain('还没有拉闸记录');
  });
  it('failed brake read has retry and does not pretend to be empty', async () => {
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false }));
    await render('brakes');
    expect(container.textContent).toContain('暂时读不到拉闸记录');
    expect(container.textContent).not.toContain('0 条消息');
    expect(container.textContent).not.toContain('还没有拉闸记录');
  });
  it('missing taste response does not become a fake empty collection', async () => {
    await render('all');
    expect(container.textContent).toContain('暂时读不到品味');
    expect(container.textContent).not.toContain('品味 0');
    expect(container.querySelector('input')?.disabled).toBe(true);
  });
});
