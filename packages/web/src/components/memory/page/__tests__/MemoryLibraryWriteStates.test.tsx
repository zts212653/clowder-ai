import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LibraryCollection } from '../MemoryLibrary';
import { MemoryLibraryCandidate } from '../MemoryLibraryCandidate';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: request }));
let container: HTMLDivElement;
let root: Root;
const changed = vi.fn();
const item = {
  id: 'm1',
  content: '教训',
  kind: 'lesson',
  createdAt: '2026-10-03',
  state: '待收录',
  sourceVisibility: 'internal',
  collectionName: null,
  sourceCollectionId: null,
};
const collection: LibraryCollection = {
  id: 'project:docs',
  name: '项目资料',
  kind: 'project',
  visibility: 'internal',
  status: 'active',
  readStatus: 'ready',
  docCount: 0,
  lastDocumentUpdatedAt: null,
};
const response = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status }));
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});
const render = async () => {
  await act(async () =>
    root.render(
      <MemoryLibraryCandidate
        item={item}
        collections={[collection]}
        defaultTargetCollectionId={collection.id}
        processed={false}
        onChanged={changed}
      />,
    ),
  );
};
const button = (name: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;

it.each([
  'approve',
  'reject',
] as const)('a mismatched %s success never finishes or unlocks either action before a reread', async (action) => {
  request.mockImplementation(() => response({ status: action === 'approve' ? 'rejected' : 'approved' }));
  await render();
  await act(async () => button(action === 'approve' ? '收录' : '不收录').click());
  expect(container.textContent).toContain('没有确认操作成功');
  expect(container.querySelector('output')).toBeNull();
  expect(changed).not.toHaveBeenCalled();
  expect(button('收录').disabled).toBe(true);
  expect(button('不收录').disabled).toBe(true);
  await act(async () => {
    button('收录').click();
    button('不收录').click();
  });
  expect(request).toHaveBeenCalledOnce();
  await act(async () => button('重读待收录记录').click());
  expect(changed).toHaveBeenCalledWith('已请求重读待收录记录。');
});

it.each([
  false,
  undefined,
])('written documents with reindexed=%s never claim the index is updated', async (reindexed) => {
  request.mockImplementation(() =>
    response({ status: 'approved', materialized: { outputPath: '/isolated/lesson.md', reindexed } }),
  );
  await render();
  await act(async () => button('收录').click());
  expect(container.textContent).toContain('已写入文档，索引稍后更新');
  expect(container.textContent).not.toContain('已收录到');
});

it('a written and reindexed document reports the destination', async () => {
  request.mockImplementation(() =>
    response({ status: 'approved', materialized: { outputPath: '/isolated/lesson.md', reindexed: true } }),
  );
  await render();
  await act(async () => button('收录').click());
  expect(container.textContent).toContain('已收录到 项目资料');
});

it('changing a destination cannot clear an uncertain write or bypass its reread requirement', async () => {
  request.mockImplementation(() => response({}, 503));
  await render();
  await act(async () => button('收录').click());
  const select = container.querySelector('select')!;
  await act(async () => {
    select.value = collection.id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(button('收录').disabled).toBe(true);
  expect(button('不收录').disabled).toBe(true);
  expect(container.textContent).toContain('没有确认操作成功');
});

it('failed widening confirmation cannot issue another writer before rereading', async () => {
  request.mockImplementation(() => response({}, 503));
  await act(async () =>
    root.render(
      <MemoryLibraryCandidate
        item={{ ...item, sourceVisibility: 'private' }}
        collections={[collection]}
        defaultTargetCollectionId={collection.id}
        processed={false}
        onChanged={changed}
      />,
    ),
  );
  const select = container.querySelector('select')!;
  await act(async () => {
    select.value = collection.id;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => button('收录').click());
  await act(async () => button('确认扩大可见范围并收录').click());
  await act(async () => button('确认扩大可见范围并收录').click());
  expect(request).toHaveBeenCalledOnce();
});
