import { afterEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { useMemoryExploreBindings } from '../useMemoryExploreBindings';
import { act, cleanup, renderHook, waitFor } from './hook-host';
import { projectOwner } from './owner-console';
import { memoryInput } from './owner-fixtures';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
afterEach(async () => {
  await cleanup();
  vi.clearAllMocks();
});
it('pushes documents on library entry and appends each kind at the next offset only when load more is requested', async () => {
  const offsets: number[] = [],
    ui = { ...memoryInput(), view: 'library' },
    id = 'project:docs';
  vi.mocked(apiFetch).mockImplementation(async (path) => {
    const url = new URL(String(path), 'https://api.test');
    if (url.pathname === '/api/memory/catalog')
      return Response.json({
        collections: [
          {
            id,
            name: 'Documents',
            kind: 'project',
            visibility: 'internal',
            status: 'active',
            readStatus: 'ready',
            docCount: 25,
          },
        ],
        defaultTargetCollectionId: id,
      });
    if (url.pathname === '/api/memory/library-feed') return Response.json({ pending: [], processed: [] });
    if (url.pathname === '/api/services') return Response.json({ services: [] });
    if (url.pathname.endsWith('/documents')) {
      const offset = Number(url.searchParams.get('offset'));
      offsets.push(offset);
      return Response.json({
        collectionId: id,
        groups: [
          {
            kind: 'note',
            count: 25,
            hasMore: offset === 0,
            documents: Array.from({ length: offset === 0 ? 20 : 5 }, (_, i) => ({
              anchor: `note-${offset + i}`,
              title: `Note ${offset + i}`,
              updatedAt: 'now',
              status: 'active',
            })),
          },
        ],
      });
    }
    return Response.json({ error: 'unavailable' }, { status: 503 });
  });
  const hook = renderHook(() => useMemoryExploreBindings(ui, () => true));
  await waitFor(() => expect(hook.result.current.data.documents[id]?.loading).toBe(false));
  expect(ui.docLimits).toEqual({ [id]: 20 });
  const view = () => projectOwner('memoryExplore', hook.result.current, ui).library.colls[0].documents;
  expect(view()).toMatchObject({
    id: 'mem-docs-' + id,
    hasMore: true,
    load: '',
    groups: [{ count: 25, items: expect.any(Array) }],
  });
  expect(view().groups[0].items).toHaveLength(20);
  for (let i = 0; i < 10; i++) view();
  expect(offsets).toEqual([0]);
  await act(() => hook.result.current.action('libraryDocumentsMore', { id }));
  expect(view().groups[0].items).toHaveLength(25);
  expect(view().hasMore).toBe(false);
  expect(view().groups[0].items[20]).toMatchObject({ anchor: 'note-20', collection: id });
  expect(offsets).toEqual([0, 20]);
});
