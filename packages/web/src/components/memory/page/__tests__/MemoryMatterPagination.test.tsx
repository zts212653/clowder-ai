import type { MatterCatalog, MatterPage, MemoryMatter } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { notifyMatterMemoryChanged } from '@/hooks/matter-memory-events';
import { MemoryMatterDetail } from '../MemoryMatterDetail';
import { MemoryMatters } from '../MemoryMatters';
import { deferred, type Reply, response } from './recall-page-fixture';

const request = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: request }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => undefined }) }));
vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>,
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

function matter(id: string, revision = 1): MemoryMatter {
  return { matterId: id, title: id, description: '', revision, status: 'active', createdAt: 1, updatedAt: 1 };
}
function catalog(id: string, nextCursor?: string): MatterCatalog {
  return { items: [{ ...matter(id), entryCount: 1 }], ...(nextCursor ? { nextCursor } : {}) };
}
function detail(id: string, quote: string, nextCursor?: string): MatterPage {
  return {
    matter: matter(id),
    entries: [
      {
        entryId: quote,
        status: 'active',
        sourceStatus: 'current',
        quote,
        attribution: 'author',
        source: {
          threadId: 'source',
          messageId: quote,
          segment: 'body',
          start: 0,
          end: quote.length,
          sourceRevision: 'r1',
          author: { kind: 'user', userId: 'owner' },
          timestamp: 1,
        },
      },
    ],
    ...(nextCursor ? { nextCursor } : {}),
  };
}
function button(label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((node) => node.textContent === label);
  expect(found, `button ${label}`).toBeDefined();
  return found as HTMLButtonElement;
}
async function click(label: string) {
  await act(async () => button(label).click());
}

it('marks a current-page interpretation unverified after source change and clears the notice on a verified refresh', async () => {
  let revised = false;
  request.mockImplementation((_path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      revised = true;
      return Promise.resolve(response({ outcome: 'applied', matter: { ...matter('matter-a'), revision: 2 } }));
    }
    return Promise.resolve(
      response({
        ...detail('matter-a', 'Original source'),
        matter: {
          ...matter('matter-a', revised ? 2 : 1),
          description: revised ? 'Rechecked interpretation' : 'Old interpretation',
        },
        ...(revised ? {} : { summaryStatus: 'sources_changed' }),
      }),
    );
  });
  await act(async () => root.render(<MemoryMatterDetail matterId="matter-a" />));
  expect(host.textContent).toContain('来源已更正，猫的归纳尚未复核');
  await click('编辑说明');
  await act(async () =>
    host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
  );
  expect(host.textContent).toContain('Rechecked interpretation');
  expect(host.textContent).not.toContain('归纳尚未复核');
});

for (const outcome of ['late_success', 'late_error'] as const) {
  for (const change of ['query', 'mutation_refresh'] as const) {
    it(`catalog discards ${outcome} after ${change} without replacing the current cursor`, async () => {
      const old = deferred<Reply>();
      let current = false;
      request.mockImplementation((path: string) => {
        const cursor = new URL(path, 'http://example.test').searchParams.get('cursor');
        if (cursor === 'old-cursor') return old.promise;
        if (cursor === 'new-cursor') return Promise.resolve(response(catalog('Current next page')));
        return Promise.resolve(
          response(current ? catalog('Current first page', 'new-cursor') : catalog('Old first page', 'old-cursor')),
        );
      });
      await act(async () => root.render(<MemoryMatters />));
      await click('加载更多');
      current = true;
      await act(async () => {
        if (change === 'query') {
          const input = host.querySelector('input');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'Current');
          input?.dispatchEvent(new Event('input', { bubbles: true }));
        } else notifyMatterMemoryChanged();
      });
      expect(host.textContent).toContain('Current first page');
      await act(async () =>
        old.resolve(response(catalog('Obsolete tail', 'obsolete-cursor'), outcome === 'late_success')),
      );
      expect(host.textContent).not.toContain('Obsolete tail');
      expect(host.textContent).not.toContain('重试加载');
      await click('加载更多');
      expect(host.textContent).toContain('Current next page');
      expect(request.mock.calls.at(-1)?.[0]).toContain('cursor=new-cursor');
      expect([...host.querySelectorAll('button')].some((node) => node.textContent === '加载更多')).toBe(false);
    });
  }
  it(`matter detail discards ${outcome} after a saved edit refreshes the first page`, async () => {
    const old = deferred<Reply>();
    let current = false;
    request.mockImplementation((path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        current = true;
        return Promise.resolve(response({ outcome: 'applied', matter: { ...matter('matter-a'), revision: 2 } }));
      }
      const cursor = new URL(path, 'http://example.test').searchParams.get('cursor');
      if (cursor === 'old-cursor') return old.promise;
      if (cursor === 'new-cursor') return Promise.resolve(response(detail('current', 'Current next source')));
      return Promise.resolve(
        response(
          current
            ? detail('current', 'Current first source', 'new-cursor')
            : detail('matter-a', 'Old first source', 'old-cursor'),
        ),
      );
    });
    await act(async () => root.render(<MemoryMatterDetail matterId="matter-a" />));
    await click('加载更多');
    await click('编辑说明');
    await act(async () =>
      host.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
    expect(host.textContent).toContain('Current first source');
    await act(async () =>
      old.resolve(response(detail('matter-a', 'Obsolete source text', 'obsolete-cursor'), outcome === 'late_success')),
    );
    expect(host.textContent).not.toContain('Obsolete source text');
    expect(host.textContent).not.toContain('页面已变化，重新读取');
    await click('加载更多');
    expect(host.textContent).toContain('Current next source');
    expect(request.mock.calls.at(-1)?.[0]).toContain('cursor=new-cursor');
  });
}

it('allows the new query to paginate while the old request is pending and preserves its loading state', async () => {
  const old = deferred<Reply>();
  const currentPage = deferred<Reply>();
  let current = false;
  request.mockImplementation((path: string) => {
    const cursor = new URL(path, 'http://example.test').searchParams.get('cursor');
    if (cursor === 'old-cursor') return old.promise;
    if (cursor === 'new-cursor') return currentPage.promise;
    return Promise.resolve(
      response(current ? catalog('Current first page', 'new-cursor') : catalog('Old first page', 'old-cursor')),
    );
  });
  await act(async () => root.render(<MemoryMatters />));
  await click('加载更多');
  current = true;
  await act(async () => notifyMatterMemoryChanged());
  await click('加载更多');
  await act(async () => old.resolve(response(catalog('Obsolete tail', 'obsolete-cursor'))));
  expect(host.textContent).not.toContain('Obsolete tail');
  expect(button('正在读取…').disabled).toBe(true);
  await act(async () => currentPage.resolve(response(catalog('Current next page'))));
  expect(host.textContent).toContain('Current next page');
  expect(host.textContent).not.toContain('正在读取…');
});
