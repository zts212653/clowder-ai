import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MarkdownContent } from '@/components/MarkdownContent';
import { apiFetch } from '@/utils/api-client';
import { ChatReference } from '../ChatReference';
import { ChatReferenceGroup } from '../ChatReferenceGroup';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'http://localhost:3102' }));
vi.mock('@/components/content-review/useChatArtworkLightbox', () => ({
  useChatArtworkLightbox: () => ({ enlarge: vi.fn(), lightbox: null }),
}));

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(apiFetch).mockImplementation(async (_url, options) => {
    const { groups } = JSON.parse(String(options?.body));
    return Response.json({
      groups: groups.map((group: { threadId: string; references: string[] }) => ({
        threadId: group.threadId,
        results: group.references.map((reference) => ({ reference, target: null })),
      })),
    });
  });
});
afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await vi.advanceTimersByTimeAsync(100);
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
const paint = async (milliseconds = 20) => {
  await act(async () => vi.advanceTimersByTimeAsync(milliseconds));
};

function trackIntersections(roots: (Element | Document | null)[] = []) {
  const intersections = new Map<Element, (visible: boolean) => void>();
  class Observer implements IntersectionObserver {
    readonly root: Element | Document | null;
    readonly rootMargin = '';
    readonly thresholds = [0];
    private readonly targets = new Set<Element>();
    constructor(
      private readonly callback: IntersectionObserverCallback,
      options: IntersectionObserverInit = {},
    ) {
      this.root = options.root ?? null;
      roots.push(this.root);
    }
    observe(target: Element) {
      this.targets.add(target);
      intersections.set(target, (visible) => {
        this.callback([{ target, isIntersecting: visible } as IntersectionObserverEntry], this);
      });
    }
    unobserve(target: Element) {
      this.targets.delete(target);
      intersections.delete(target);
    }
    disconnect() {
      for (const target of this.targets) intersections.delete(target);
      this.targets.clear();
    }
    takeRecords(): IntersectionObserverEntry[] {
      return [];
    }
  }
  vi.stubGlobal('IntersectionObserver', Observer);
  return intersections;
}

it('shares observation within each chat scroll root and releases roots independently', async () => {
  const roots: (Element | Document | null)[] = [];
  const intersections = trackIntersections(roots);
  const render = (ids: string[]) =>
    root.render(
      ids.map((id) => (
        <div key={id} data-chat-container={id}>
          <MarkdownContent referenceThreadId={`root_${id}`} content={`Read docs/${id}.md .`} />
        </div>
      )),
    );
  await act(async () => render(['first', 'second']));
  expect(roots).toEqual([...container.querySelectorAll('[data-chat-container]')]);
  const second = container.querySelector('[data-chat-container=second]');
  await act(async () => render(['second']));
  expect([...intersections.keys()].every((target) => second?.contains(target))).toBe(true);
  await act(async () => {
    for (const enter of intersections.values()) enter(true);
  });
  await paint();
  expect(JSON.parse(String(vi.mocked(apiFetch).mock.calls[0][1]?.body)).groups).toEqual([
    { threadId: 'root_second', references: ['docs/second.md'] },
  ]);
});

it.each([
  'standalone',
  'mixed',
])('reads only the %s paragraph entering the viewport, not offscreen history', async (kind) => {
  const intersections = trackIntersections();
  await act(async () => {
    root.render(
      Array.from({ length: 192 }, (_, index) => `docs/${index}.md`).map((reference) => (
        <ChatReferenceGroup
          key={reference}
          threadId={`thread_offscreen_${kind}`}
          candidates={kind === 'standalone' ? [reference] : []}
          grid={false}
        >
          <ChatReference threadId={`thread_offscreen_${kind}`} reference={reference}>
            {reference}
          </ChatReference>
        </ChatReferenceGroup>
      )),
    );
  });
  await paint();
  expect(apiFetch).not.toHaveBeenCalled();
  const first = container.querySelector('p');
  if (!first) throw new Error('Expected the mounted reference paragraph');
  expect(intersections.has(first)).toBe(true);
  await act(async () => intersections.get(first)?.(true));
  await paint();
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(vi.mocked(apiFetch).mock.calls[0][1]?.body)).groups).toEqual([
    { threadId: `thread_offscreen_${kind}`, references: ['docs/0.md'] },
  ]);
  await act(async () => intersections.get(first)?.(false));
  await paint(31_000);
  window.dispatchEvent(new Event('focus'));
  await paint();
  expect(apiFetch).toHaveBeenCalledTimes(1);
  await act(async () => intersections.get(first)?.(true));
  await paint();
  expect(apiFetch).toHaveBeenCalledTimes(2);
});

it('also defers heading, tight-list and table references in an offscreen Markdown message', async () => {
  const intersections = trackIntersections();
  await act(async () => {
    root.render(
      <MarkdownContent
        referenceThreadId="thread_block_demand"
        content={'# docs/heading.md\n\n- docs/list.md\n\n| File |\n| --- |\n| docs/cell.md |'}
      />,
    );
  });
  await paint();
  expect(apiFetch).not.toHaveBeenCalled();
  const markdown = container.querySelector('.markdown-content');
  if (!markdown) throw new Error('Expected the mounted Markdown message');
  expect(intersections.has(markdown)).toBe(true);
  await act(async () => intersections.get(markdown)?.(true));
  await paint();
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(vi.mocked(apiFetch).mock.calls[0][1]?.body)).groups).toEqual([
    { threadId: 'thread_block_demand', references: ['docs/heading.md', 'docs/list.md', 'docs/cell.md'] },
  ]);
});

it('keeps an unchanged null lookup subscribed across a streaming render, while focus still revalidates', async () => {
  const render = () =>
    root.render(
      <ChatReferenceGroup threadId="thread_stable_subscription" candidates={['owner/repo']} grid={false}>
        <ChatReference threadId="thread_stable_subscription" reference="owner/repo">
          owner/repo
        </ChatReference>
      </ChatReferenceGroup>,
    );
  await act(async () => render());
  await paint();
  expect(apiFetch).toHaveBeenCalledTimes(1);
  await paint(5001);
  await act(async () => render());
  await paint();
  expect(apiFetch).toHaveBeenCalledTimes(1);
  window.dispatchEvent(new Event('focus'));
  await paint();
  expect(apiFetch).toHaveBeenCalledTimes(2);
});
