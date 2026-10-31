import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryLibrary } from '../MemoryLibrary';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: fetchMock }));
const response = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const collections = [
  {
    id: 'domain:private',
    name: '我的资料',
    visibility: 'private',
    status: 'active',
    readStatus: 'ready',
    docCount: 0,
    lastDocumentUpdatedAt: null,
    kind: 'domain',
  },
  {
    id: 'project:cat-cafe',
    name: 'Clowder AI Project',
    visibility: 'internal',
    status: 'active',
    readStatus: 'ready',
    docCount: 0,
    lastDocumentUpdatedAt: null,
    kind: 'domain',
  },
  {
    id: 'domain:archived',
    name: '归档库',
    visibility: 'private',
    status: 'archived',
    readStatus: 'ready',
    docCount: 0,
    lastDocumentUpdatedAt: null,
    kind: 'domain',
  },
];
let container: HTMLDivElement;
let root: Root;
const read = { data: null, loading: false, error: false, retry: vi.fn() };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  fetchMock.mockImplementation((path: string) =>
    path === '/api/memory/catalog'
      ? response({ collections })
      : path === '/api/memory/library-feed'
        ? response({
            pending: [
              {
                id: 'm1',
                content: '真实提议',
                createdAt: '2026-10-03',
                state: '待收录',
                sourceCollectionId: 'domain:private',
                sourceVisibility: 'private',
                collectionName: '我的资料',
              },
            ],
            processed: [],
          })
        : response({ status: 'approved' }),
  );
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});
const render = async () => {
  await act(async () => root.render(<MemoryLibrary index={read} maintenance={read} />));
};
const button = (name: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;
const click = async (name: string) => {
  await act(async () => button(name).click());
};
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
const choose = async (value: string) => {
  const select = container.querySelector('select')!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

it('keeps per-library rebuild and archive reachable through the original management page without writing on entry', async () => {
  await render();
  const manage = [...container.querySelectorAll('a')].find((link) => link.textContent === '管理资料库 ↗');
  expect(manage?.getAttribute('href')).toBe('/memory/catalog?shell=v2');
  expect(container.textContent).toContain('重建、归档和取消归档在原资料库管理页');
  expect(button('＋ 新建资料库').disabled).toBe(false);
  expect(posts()).toHaveLength(0);
});

it('shows destination and visibility before approving, excludes archived targets, and sends the explicit target', async () => {
  await render();
  expect(container.querySelector('select')?.value).toBe('');
  await choose('domain:private');
  expect(container.textContent).toContain('收录到 我的资料 · 私有可见');
  expect([...container.querySelectorAll('option')].map((o) => o.textContent)).not.toContain('归档库 · 私有');
  expect(container.textContent).not.toContain('domain:private');
  await click('收录');
  expect(JSON.parse(posts()[0][1].body)).toEqual({ markerId: 'm1', targetCollectionId: 'domain:private' });
  expect(container.textContent).toContain('已批准 · 收录结果暂时读不到');
  expect(container.textContent).not.toContain('已收录到');
});

it('requires a separate visibility confirmation and resets it when the target changes', async () => {
  await render();
  await choose('project:cat-cafe');
  await click('收录');
  expect(posts()).toHaveLength(0);
  expect(container.textContent).toContain('私有 → 内部');
  await choose('domain:private');
  expect(container.textContent).not.toContain('确认扩大可见范围并收录');
  await choose('project:cat-cafe');
  await click('收录');
  await click('确认扩大可见范围并收录');
  expect(JSON.parse(posts()[0][1].body)).toEqual({
    markerId: 'm1',
    targetCollectionId: 'project:cat-cafe',
    confirmVisibilityWidening: true,
  });
});

it('rejects through the existing writer, refreshes reads, and a failed request leaves the proposal actionable', async () => {
  const original = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((path: string) =>
    path === '/api/knowledge/reject' ? response({ error: 'private raw path' }, 500) : original?.(path),
  );
  await render();
  await click('不收录');
  expect(container.textContent).toContain('没有确认操作成功');
  expect(container.textContent).not.toContain('private raw path');
  expect(button('不收录').disabled).toBe(true);
  await click('重读待收录记录');
  fetchMock.mockImplementation((path: string) =>
    path === '/api/knowledge/reject' ? response({ status: 'rejected' }) : original?.(path),
  );
  await click('不收录');
  expect(JSON.parse(posts()[1][1].body)).toEqual({ markerId: 'm1' });
  expect(container.textContent).toContain('已选择不收录');
  expect(fetchMock.mock.calls.filter(([path]) => path === '/api/memory/library-feed')).toHaveLength(3);
});

it('an unrecognized sensitivity error never offers the confirmation retry', async () => {
  const original = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((path: string) =>
    path === '/api/knowledge/approve'
      ? response({ error: 'visibility-widening blocked: unrecognized source sensitivity' }, 400)
      : original?.(path),
  );
  await render();
  await choose('domain:private');
  await click('收录');
  expect(container.textContent).toContain('来源可见范围无法确认');
  expect(container.textContent).not.toContain('确认扩大可见范围并收录');
  expect(posts()).toHaveLength(1);
});

it('no readable target never becomes automatic routing; rejection remains available', async () => {
  const original = fetchMock.getMockImplementation();
  fetchMock.mockImplementation((path: string) =>
    path === '/api/memory/catalog' ? response({ collections: [] }) : original?.(path),
  );
  await render();
  expect(button('收录').disabled).toBe(true);
  expect(button('不收录').disabled).toBe(false);
  expect(container.textContent).toContain('还没有可收录的资料库');
});
