import type { MatterWriteSnapshot, RichCardBlock } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryGroupCard } from '../MemoryGroupCard';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: request }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => undefined }) }));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>,
}));
let host: HTMLDivElement;
let root: Root;
const snapshot: MatterWriteSnapshot = {
  operation: 'append',
  matter: { matterId: 'same-page', title: 'Original title', revision: 4 },
  recordedAt: 1000,
  entries: [
    {
      entryId: 'added',
      status: 'active',
      sourceStatus: 'thread_only',
      summary: 'This exact addition',
      summaryAuthor: { kind: 'agent', catId: 'codex-astra' },
      source: { kind: 'thread', threadId: 'source', origin: 'explicit' },
      attribution: 'author',
    },
  ],
};
const block: RichCardBlock = {
  kind: 'card',
  v: 1,
  id: 'two-writes',
  title: 'Memory submissions',
  meta: {
    kind: 'memory_group',
    memoryGroup: {
      v: 1,
      groupId: 'two-writes',
      rows: [
        {
          itemId: 'append',
          target: 'matter',
          statusCode: 200,
          status: 'applied',
          resultRef: 'same-page',
          matterWriteRef: { actorKey: 'cat:codex-astra', requestId: 'append', operation: 'append', revision: 4 },
        },
        {
          itemId: 'edit',
          target: 'matter',
          statusCode: 200,
          status: 'applied',
          resultRef: 'same-page',
          matterWriteRef: { actorKey: 'cat:codex-astra', requestId: 'edit', operation: 'edit', revision: 5 },
        },
      ],
    },
  },
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  request.mockImplementation(async (path: string) => {
    if (path.includes('/write-receipt?')) {
      const ref = new URL(path, 'http://test').searchParams.get('requestId');
      return Response.json(
        ref === 'append'
          ? snapshot
          : {
              ...snapshot,
              operation: 'edit',
              matter: { ...snapshot.matter, title: 'Later title', revision: 5 },
              entries: [],
              descriptionChange: { before: 'Earlier five items', after: 'Earlier five items\nThe later sixth item' },
            },
      );
    }
    return Response.json({
      matter: {
        matterId: 'same-page',
        title: 'Later title',
        description: 'Earlier five items\nThe later sixth item',
        revision: 5,
        status: 'active',
      },
      entries: [],
    });
  });
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});
const render = () =>
  act(async () =>
    root.render(
      <MemoryGroupCard
        block={block}
        coordinate={{ threadId: 'here', messageId: 'card' }}
        renderOriginal={() => null}
      />,
    ),
  );

it('distinguishes append and description edit and renders each fixed write instead of the latest whole page', async () => {
  await render();
  const first = host.querySelector('[data-memory-group-row="append"]');
  const second = host.querySelector('[data-memory-group-row="edit"]');
  expect(first?.textContent).toContain('追加');
  expect(first?.textContent).toContain('第 4 版');
  expect(first?.textContent).toContain('This exact addition');
  expect(first?.textContent).not.toContain('sixth');
  expect(first?.textContent).not.toContain('Later title');
  expect(second?.textContent).toContain('修改说明');
  expect(second?.textContent).toContain('第 5 版');
  expect(second?.textContent).toContain('The later sixth item');
  expect(second?.textContent).not.toContain('Earlier five items');
  expect(request.mock.calls.some(([path]) => !String(path).includes('/write-receipt?'))).toBe(false);
});

it('does not keep frozen write text visible after a permission failure on refresh', async () => {
  await render();
  expect(host.textContent).toContain('This exact addition');
  request.mockResolvedValue(Response.json({ error: 'not_available' }, { status: 404 }));
  await act(async () => [...host.querySelectorAll('button')].find((node) => node.textContent === '重新读取')?.click());
  expect(host.querySelector('[data-memory-group-row="append"]')?.textContent).not.toContain('This exact addition');
});
