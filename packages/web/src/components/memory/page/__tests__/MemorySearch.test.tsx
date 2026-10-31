import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryPagePreview } from '../MemoryPagePreview';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: fetchMock }));
vi.mock('../MemoryTaste', () => ({ MemoryTaste: () => <p>已存记忆</p> }));
vi.mock('../MemoryRecall', () => ({ MemoryRecall: () => <p>召回记录</p> }));
vi.mock('../MemoryBrakes', () => ({ MemoryBrakes: () => <p>拉闸记录</p> }));
vi.mock('../MemoryLibrary', () => ({ MemoryLibrary: () => <p>资料库</p> }));
vi.mock('../../CollectionGraph', () => ({ CollectionGraph: () => <p>关系图</p> }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>,
}));
let container: HTMLDivElement;
let root: Root;
const ok = (value: unknown) => ({ ok: true, json: async () => value });
const empty = {
  query: '搜索',
  readStatus: 'ready',
  groups: [
    { type: 'memory', status: 'ready', results: [], hasMore: false },
    { type: 'documents', status: 'ready', results: [], hasMore: false },
    { type: 'conversations', status: 'ready', results: [], hasMore: false },
  ],
};
const response = (title: string) => ({
  ...empty,
  groups: [
    {
      type: 'documents',
      status: 'ready',
      hasMore: false,
      results: [
        {
          id: 'doc',
          title,
          snippet: '真实摘要',
          displayType: '设计规范',
          authority: 'observed',
          updatedAt: '2026-09-25',
          destination: null,
          graph: null,
        },
      ],
    },
    ...empty.groups.filter((g) => g.type !== 'documents'),
  ],
});
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  fetchMock.mockImplementation((path: string) => Promise.resolve(ok(path.includes('/search?') ? empty : {})));
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});
const render = () => act(async () => root.render(<MemoryPagePreview tab="all" />));
async function search(value = '搜索') {
  const input = container.querySelector<HTMLInputElement>('input[aria-label="搜索记忆和资料"]');
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!input || !setValue) throw new Error('Missing input or native setter');
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => input.closest('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

it('enables the topbar search and keeps only summary/raw and result-type controls', async () => {
  await render();
  expect(container.querySelector<HTMLInputElement>('input')?.disabled).toBe(false);
  await search();
  expect(fetchMock.mock.calls.some(([url]) => url.includes('/api/memory/search?'))).toBe(true);
  expect(container.textContent).toContain('只看摘要');
  expect(container.textContent).toContain('包含原文');
  expect(container.textContent).not.toContain('混合检索');
});

it('lands a find keyword in the existing topbar search and submits it once through the memory owner', async () => {
  fetchMock.mockImplementation((path: string) =>
    Promise.resolve(ok(path.includes('/search?') ? { ...response('同源记忆结果'), query: '一行' } : {})),
  );
  await act(async () => root.render(<MemoryPagePreview tab="all" initialQuery="一行" />));
  expect(container.querySelector<HTMLInputElement>('input[aria-label="搜索记忆和资料"]')?.value).toBe('一行');
  expect(container.textContent).toContain('同源记忆结果');
  const calls = fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/memory/search?'));
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0][0], 'https://example.test').searchParams.get('q')).toBe('一行');
  expect(fetchMock.mock.calls.some(([url]) => url.startsWith('/api/evidence/search?'))).toBe(false);
});

it('treats search as a separate view with quiet submission and consistent calendar dates', async () => {
  const body = response('搜索日期');
  body.groups[0].results[0] = { ...body.groups[0].results[0], updatedAt: '2026-09-25' };
  fetchMock.mockImplementation((path: string) => Promise.resolve(ok(path.includes('/search?') ? body : {})));
  await render();
  const submit = container.querySelector<HTMLButtonElement>('form button[type="submit"]');
  expect.soft(submit?.className).not.toContain('bg-cafe-accent');
  await search();
  expect.soft(container.querySelectorAll('nav[aria-label="记忆页标签"] [aria-current="page"]')).toHaveLength(0);
  expect.soft(container.textContent).toContain('9 月 25 日');
  expect.soft(container.textContent).not.toContain('记录日期');
  expect.soft(container.textContent).not.toContain('2026-09-25');
});

it('keeps loading and unavailable distinct from a verified empty result, then retries', async () => {
  let release: (value: unknown) => void = () => {};
  fetchMock.mockImplementation((path: string) =>
    path.includes('/search?')
      ? new Promise((r) => {
          release = r;
        })
      : Promise.resolve(ok({})),
  );
  await render();
  await search();
  expect(container.textContent).toContain('正在搜索');
  expect(container.textContent).not.toContain('没有找到匹配');
  await act(async () => release({ ok: false }));
  expect(container.textContent).toContain('暂时读不到搜索结果');
  expect(container.textContent).not.toContain('没有找到匹配');
  fetchMock.mockImplementation((path: string) => Promise.resolve(ok(path.includes('/search?') ? empty : {})));
  await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === '重试')?.click());
  expect(container.textContent).toContain('没有找到匹配');
});

it('uses producer types and authority words, retaining successful sources beside an unavailable one', async () => {
  const body = response('规则以真实界面为准');
  body.groups[1] = { type: 'memory', status: 'unavailable', hasMore: false, results: [] };
  fetchMock.mockImplementation((path: string) =>
    Promise.resolve(ok(path.includes('/search?') ? { ...body, readStatus: 'partial' } : {})),
  );
  await render();
  await search();
  expect(container.textContent).toContain('规则以真实界面为准');
  expect(container.textContent).toContain('设计规范');
  expect(container.textContent).toContain('已观测');
  expect(container.textContent).toContain('记忆暂时读不到');
  expect(container.textContent).not.toContain('未验证');
  expect(container.textContent).not.toContain('sourcePath');
});

it('rejects malformed 200 bodies instead of inventing empty results', async () => {
  fetchMock.mockImplementation((path: string) =>
    Promise.resolve(ok(path.includes('/search?') ? { groups: null } : {})),
  );
  await render();
  await search();
  expect(container.textContent).toContain('暂时读不到搜索结果');
  expect(container.textContent).not.toContain('没有找到匹配');
});

it('cancellation and a new query prevent a late response from replacing the visible query', async () => {
  let release: (value: unknown) => void = () => {};
  fetchMock.mockImplementation((path: string) =>
    path.includes('/search?') && path.includes('old')
      ? new Promise((r) => {
          release = r;
        })
      : Promise.resolve(ok(path.includes('/search?') ? { ...response('当前结果'), query: 'new' } : {})),
  );
  await render();
  await search('old');
  await search('new');
  expect(container.textContent).toContain('当前结果');
  await act(async () => release(ok({ ...response('过期结果'), query: 'old' })));
  expect(container.textContent).not.toContain('过期结果');
  await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === '关闭搜索')?.click());
  expect(container.textContent).toContain('已存记忆');
  expect(container.textContent).not.toContain('当前结果');
});

it.each([
  'partial',
  'unavailable',
] as const)('names the verified empty sources beside a %s conversation read', async (status) => {
  const body = {
    ...empty,
    readStatus: 'partial',
    groups: empty.groups.map((g) => (g.type === 'conversations' ? { ...g, status } : g)),
  };
  fetchMock.mockImplementation((path: string) => Promise.resolve(ok(path.includes('/search?') ? body : {})));
  await render();
  await search();
  expect(container.textContent).toContain('记忆、文档里没有找到匹配');
  expect(container.textContent).not.toContain('未找到匹配');
  if (status === 'partial') {
    expect(container.textContent).toContain('本次核对的对话里没有找到匹配');
    expect(container.textContent).toContain('对话索引的覆盖范围尚未确认');
  } else {
    expect(container.textContent).toContain('对话暂时读不到');
    expect(container.textContent).not.toContain('对话里没有找到匹配');
  }
});

it('combines more-match guidance once without losing the successful result or source failure', async () => {
  const body = response('保留已读到的资料');
  body.groups[0].hasMore = true;
  body.groups[1] = { ...body.groups[1], status: 'unavailable' };
  body.groups[2] = { ...body.groups[2], status: 'partial', hasMore: true };
  fetchMock.mockImplementation((path: string) =>
    Promise.resolve(ok(path.includes('/search?') ? { ...body, readStatus: 'partial' } : {})),
  );
  await render();
  await search();
  expect(container.textContent).toContain('保留已读到的资料');
  expect(container.textContent).toContain('记忆暂时读不到');
  expect(container.textContent?.match(/还有更多匹配；请缩小搜索词/g)).toHaveLength(1);
});
