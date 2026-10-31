import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryLibrary } from '../MemoryLibrary';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: fetchMock }));
let root: Root;
let container: HTMLDivElement;
let sourceVisibility: string | null;
let defaultId: string | null;
const collection = (id: string, name: string, visibility: string) => ({
  id,
  name,
  visibility,
  kind: 'domain',
  status: 'active',
  readStatus: 'ready',
  docCount: 0,
  lastDocumentUpdatedAt: null,
});
const read = { data: null, loading: false, error: false, retry: vi.fn() };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  sourceVisibility = 'internal';
  defaultId = 'domain:docs';
  fetchMock.mockImplementation((path: string) =>
    Promise.resolve(
      new Response(
        JSON.stringify(
          path === '/api/memory/catalog'
            ? {
                defaultTargetCollectionId: defaultId,
                collections: [
                  collection('domain:docs', '实际文档库', 'internal'),
                  collection('domain:source', '来源资料库', sourceVisibility ?? 'internal'),
                ],
              }
            : path === '/api/memory/library-feed'
              ? {
                  pending: [
                    {
                      id: 'm1',
                      content: '提议',
                      state: '待收录',
                      sourceCollectionId: 'domain:source',
                      sourceVisibility,
                      createdAt: '2026-10-03',
                    },
                  ],
                  processed: [],
                }
              : { status: 'approved' },
        ),
      ),
    ),
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
const approve = () => [...container.querySelectorAll('button')].find((button) => button.textContent === '收录');

it('ordinary sources expose the old docsRoot default and submit that explicit id rather than the source collection', async () => {
  await render();
  expect(container.querySelector('select')?.value).toBe('domain:docs');
  expect(container.textContent).toContain('收录到 实际文档库 · 内部可见');
  await act(async () => approve()?.click());
  const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
  expect(JSON.parse(post?.[1].body)).toEqual({ markerId: 'm1', targetCollectionId: 'domain:docs' });
});

it.each([
  'private',
  'restricted',
])('%s sources require manual selection even when their own library is readable', async (visibility) => {
  sourceVisibility = visibility;
  await render();
  expect(container.querySelector('select')?.value).toBe('');
  expect(approve()?.disabled).toBe(true);
});

it('legacy shared candidates without source sensitivity retain the explicit docsRoot default', async () => {
  sourceVisibility = null;
  await render();
  expect(container.querySelector('select')?.value).toBe('domain:docs');
  expect(approve()?.disabled).toBe(false);
});

it.each([
  null,
  'domain:missing',
])('an absent or unreadable default stays manual instead of guessing a library', async (value) => {
  defaultId = value;
  await render();
  expect(container.querySelector('select')?.value).toBe('');
  expect(approve()?.disabled).toBe(true);
});
