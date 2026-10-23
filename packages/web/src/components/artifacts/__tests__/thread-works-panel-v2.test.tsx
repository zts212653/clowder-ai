import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ArtworkLightboxHost } from '@/components/content-review/ArtworkLightboxHost';
import { ArtworkLightboxProvider } from '@/components/content-review/ArtworkLightboxScope';
import { writeShellLanguage } from '@/components/shell/shell-language';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { useChatStore } from '@/stores/chatStore';
import { ThreadWorksPanelV2 } from '../ThreadWorksPanelV2';

const data = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/components/workbench/F307OwnerSurfaceRenderer', () => ({
  F307OwnerSurfaceRenderer: () => <div>Original publication owner</div>,
}));
vi.mock('@/utils/api-client', () => ({ API_URL: '', apiFetch: data.fetch }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => ({ nickname: '小太阳·砚砚' }) }) }));
const items: ThreadArtifactDTO[] = [
  {
    type: 'file',
    name: 'Delivered.md',
    catId: 'codex61-sol',
    createdAt: 300,
    sourceMessageId: 'published-md',
    publicationItem: { kind: 'rich-file', blockId: 'md' },
    url: '/uploads/delivered.md',
  },
  { type: 'pr', name: 'Exact PR', catId: 'codex61-sol', createdAt: 200, sourceMessageId: null, ref: 'org/repo#10' },
];
let host: HTMLDivElement;
let root: Root;
const open = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  writeShellPresentation('classic');
  writeShellLanguage('en');
  data.fetch.mockReset();
  open.mockReset();
  useChatStore.setState({ currentThreadId: 'work-source', messages: [], threadStates: {} });
  data.fetch.mockImplementation(async () =>
    Response.json({
      threadId: 'work-source',
      artifacts: items,
      workLineage: 'resolved',
      view: 'works',
      complete: true,
      total: 2,
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  writeShellPresentation('classic');
});
it('uses the named source read and opens a complete document DTO with the original list view', async () => {
  await act(async () => root.render(<ThreadWorksPanelV2 threadId="work-source" onSelectArtifact={open} />));
  expect(data.fetch.mock.calls[0][0]).toBe('/api/threads/work-source/artifacts?view=works');
  expect(host.querySelector('h2')?.textContent).toBe('Works');
  expect(host.textContent).toContain('2 works');
  expect(host.textContent).not.toContain('Unknown version');
  const card = host.querySelector<HTMLButtonElement>('[data-testid="workspace-home-artifact-card"]');
  await act(async () => card?.click());
  expect(open).toHaveBeenCalledExactlyOnceWith(items[0], {
    kind: 'artifact-list',
    threadId: 'work-source',
    view: {
      scope: 'thread',
      filter: 'all',
      query: '',
      grouping: 'time',
      catFilter: null,
      collapsed: [],
      viewport: { scrollTop: 0, anchor: { key: expect.any(String), offset: 0 } },
    },
  });
});
it('keeps the same-scope works count while refreshing', async () => {
  await act(async () => root.render(<ThreadWorksPanelV2 threadId="work-source" />));
  data.fetch.mockImplementation(() => new Promise<Response>(() => {}));
  await act(async () => window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated')));
  expect(host.querySelector('.v2-works-count')?.textContent).toContain('2 works');
});
it('incomplete source reads show neither a precise count nor a false empty state', async () => {
  data.fetch.mockImplementation(async () =>
    Response.json({ artifacts: [], workLineage: 'unavailable', view: 'works', complete: false }),
  );
  await act(async () => root.render(<ThreadWorksPanelV2 threadId="work-source" onSelectArtifact={open} />));
  expect(host.textContent).toContain('the count is not confirmed');
  expect(host.textContent).not.toContain('0 works');
  expect(host.textContent).not.toContain('No works match');
});

it('offers only populated work types in one selector and filters the original catalogue', async () => {
  await act(async () => root.render(<ThreadWorksPanelV2 threadId="work-source" onSelectArtifact={open} />));
  const types = host.querySelector<HTMLSelectElement>('select[aria-label="Work type"]');
  expect(types).not.toBeNull();
  expect([...types!.options].map((option) => option.text)).toEqual(['All types', 'Documents · 1', 'Code and PRs · 1']);
  await act(async () => {
    types!.value = 'codepr';
    types!.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(host.querySelectorAll('[data-testid="workspace-home-artifact-card"]')).toHaveLength(1);
  expect(host.textContent).toContain('Exact PR');
  expect(host.textContent).not.toContain('Delivered.md');
});

it('reveals the next original works when the scroll sentinel enters the viewport', async () => {
  let intersect: IntersectionObserverCallback = () => {};
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        intersect = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const many = Array.from({ length: 60 }, (_, index) => ({
    ...items[0],
    name: `Delivered-${index}.md`,
    sourceMessageId: `publication-${index}`,
    createdAt: 1000 - index,
  }));
  data.fetch.mockImplementation(async () =>
    Response.json({
      artifacts: many,
      workLineage: 'resolved',
      view: 'works',
      complete: true,
      total: many.length,
    }),
  );
  await act(async () => root.render(<ThreadWorksPanelV2 threadId="work-source" onSelectArtifact={open} />));
  expect(host.querySelectorAll('[data-work-anchor]')).toHaveLength(24);
  await act(async () => intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  expect(host.querySelectorAll('[data-work-anchor]')).toHaveLength(48);
  await act(async () => intersect([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  expect(host.querySelectorAll('[data-work-anchor]')).toHaveLength(60);
});

it.each([
  'image',
  'file',
] as const)('a published PNG catalogued as %s floats its admitted owner and carries the exact list return into work mode', async (type) => {
  writeShellPresentation('v2');
  useChatStore.setState({ workspaceOpenRequest: null });
  const image: ThreadArtifactDTO = { ...items[0], type, name: 'Original.png', url: '/uploads/original.png' };
  const asset = {
    contentRef: `prepared-media:${'c'.repeat(64)}`,
    ownerRevision: 1,
    blobDigest: `sha256:${'a'.repeat(64)}`,
    mediaType: 'image/png',
    media: { kind: 'image', width: 160, height: 100 },
    sourcePublication: { artifactRef: image.url, sourceRef: 'message:work-source:published-md', revision: '300' },
    ownerReceiptRef: 'receipt',
  };
  data.fetch.mockImplementation(async (url: string) =>
    Response.json(
      url === '/api/content-publications/resolve'
        ? { status: 'resolved', ownerUserId: 'operator', asset }
        : { threadId: 'work-source', artifacts: [image], complete: true, total: 1, view: 'works' },
    ),
  );
  await act(async () =>
    root.render(
      <ArtworkLightboxProvider threadId="work-source">
        <ThreadWorksPanelV2 threadId="work-source" onSelectArtifact={open} />
        <ArtworkLightboxHost />
      </ArtworkLightboxProvider>,
    ),
  );
  const list = host.querySelector<HTMLElement>('.v2-works-scroll')!;
  list.scrollTop = 231;
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="workspace-home-artifact-card"]')?.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Original publication owner');
  expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
  await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="lightbox-open-workspace"]')?.click());
  expect(useChatStore.getState().workspaceOpenRequest).toMatchObject({
    presentation: 'work-mode',
    threadId: 'work-source',
    target: {
      kind: 'publication',
      contentRef: asset.contentRef,
      ownerRevision: 1,
      navigationOrigin: { kind: 'artifact-list', threadId: 'work-source', view: { viewport: { scrollTop: 231 } } },
    },
  });
  expect(open).not.toHaveBeenCalled();
  writeShellPresentation('classic');
});

it('returns the actual Works scroll position with its selected card after remount', async () => {
  await act(async () => root.render(<ThreadWorksPanelV2 threadId="work-source" onSelectArtifact={open} />));
  const list = host.querySelector<HTMLElement>('.v2-works-scroll')!;
  list.scrollTop = 231;
  await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="workspace-home-artifact-card"]')?.click());
  expect(open.mock.calls[0][1].view.viewport).toMatchObject({ scrollTop: 231 });
  const view = open.mock.calls[0][1].view;
  await act(async () =>
    root.render(
      <ThreadWorksPanelV2 key="returned-list" threadId="work-source" initialView={view} onSelectArtifact={open} />,
    ),
  );
  expect(host.querySelector<HTMLElement>('.v2-works-scroll')?.scrollTop).toBe(231);
});

it.each([
  false,
  true,
])('restores a new same-position return on the retained list once: StrictMode %s', async (strict) => {
  const view = {
    scope: 'thread' as const,
    filter: 'all' as const,
    query: '',
    grouping: 'time' as const,
    catFilter: null,
    collapsed: [],
    viewport: { scrollTop: 200 },
  };
  const render = (initialView = view) => {
    const panel = <ThreadWorksPanelV2 threadId="work-source" initialView={initialView} />;
    root.render(strict ? <StrictMode>{panel}</StrictMode> : panel);
  };
  await act(async () => render());
  const list = host.querySelector<HTMLElement>('.v2-works-scroll')!;
  expect(list.scrollTop).toBe(200);
  // The host retains this DOM when the return's serialized view/key is unchanged.
  list.scrollTop = 0;
  const nextReturn = { ...view, viewport: { ...view.viewport } };
  await act(async () => render(nextReturn));
  expect(host.querySelector('.v2-works-scroll')).toBe(list);
  expect(list.scrollTop).toBe(200);
  list.scrollTop = 123;
  await act(async () => render(nextReturn));
  expect(list.scrollTop).toBe(123);
});

it.each([
  false,
  true,
])('settles a returned card after an earlier preview loads, unless the person scrolls: %s', async (interact) => {
  const image = {
    ...items[0],
    type: 'image',
    name: 'Earlier.png',
    sourceMessageId: 'earlier-image',
    url: '/uploads/earlier.png',
  };
  data.fetch.mockImplementation(async () =>
    Response.json({ artifacts: [image, ...items], view: 'works', workLineage: 'resolved', complete: true, total: 3 }),
  );
  await act(async () => root.render(<ThreadWorksPanelV2 threadId="work-source" onSelectArtifact={open} />));
  const key = host.querySelectorAll<HTMLElement>('[data-work-anchor]')[1].dataset.workAnchor!;
  let top = 10;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, this.dataset.workAnchor === key ? top : 0, 100, 100);
  });
  const initialView = {
    scope: 'thread' as const,
    filter: 'all' as const,
    query: '',
    grouping: 'time' as const,
    catFilter: null,
    collapsed: [],
    viewport: { scrollTop: 200, anchor: { key, offset: 10 } },
  };
  await act(async () =>
    root.render(<ThreadWorksPanelV2 key="returned" threadId="work-source" initialView={initialView} />),
  );
  const list = host.querySelector<HTMLElement>('.v2-works-scroll')!;
  expect(list.scrollTop).toBe(200);
  if (interact) list.dispatchEvent(new Event('wheel'));
  top = 60;
  await act(async () => list.querySelector('img')!.dispatchEvent(new Event('load')));
  await vi.waitFor(() => expect(list.scrollTop).toBe(interact ? 200 : 250));
});

it('a mounted Works list rereads delivered materials and owner versions without token polling', async () => {
  await act(async () => root.render(<ThreadWorksPanelV2 threadId="work-source" onSelectArtifact={open} />));
  data.fetch.mockImplementation(async () =>
    Response.json({
      threadId: 'work-source',
      artifacts: [...items, { ...items[0], name: 'Newly delivered.pdf', sourceMessageId: 'new-publication' }],
      workLineage: 'resolved',
      view: 'works',
      complete: true,
      total: 3,
    }),
  );
  await act(async () => window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated')));
  expect(host.textContent).toContain('3 works');
  expect(host.textContent).toContain('Newly delivered.pdf');
  const message = {
    id: 'new-publication',
    type: 'assistant' as const,
    content: 'stream',
    timestamp: 400,
    isStreaming: true,
  };
  await act(async () => useChatStore.setState({ messages: [message], hasActiveInvocation: true }));
  const catalogueReads = () =>
    data.fetch.mock.calls.filter(([path]) => path === '/api/threads/work-source/artifacts?view=works').length;
  const reads = catalogueReads();
  await act(async () => useChatStore.setState({ messages: [{ ...message, content: 'another token' }] }));
  expect(catalogueReads()).toBe(reads);
  await act(async () =>
    useChatStore.setState({ messages: [{ ...message, isStreaming: false }], hasActiveInvocation: false }),
  );
  expect(catalogueReads()).toBe(reads + 1);
  expect(host.textContent).toContain('3 works');
});

it('keeps the pending return when a source refresh replaces previews before they settle', async () => {
  const image = {
    ...items[0],
    type: 'image',
    name: 'Earlier.png',
    sourceMessageId: 'earlier-image',
    url: '/uploads/earlier.png',
  };
  const body = { artifacts: [image, ...items], view: 'works', workLineage: 'resolved', complete: true, total: 3 };
  data.fetch.mockImplementation(async () => Response.json(body));
  await act(async () => root.render(<ThreadWorksPanelV2 threadId="work-source" onSelectArtifact={open} />));
  const key = host.querySelectorAll<HTMLElement>('[data-work-anchor]')[1].dataset.workAnchor!;
  let top = 10;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, this.dataset.workAnchor === key ? top : 0, 100, 100);
  });
  const initialView = {
    scope: 'thread' as const,
    filter: 'all' as const,
    query: '',
    grouping: 'time' as const,
    catFilter: null,
    collapsed: [],
    viewport: { scrollTop: 200, anchor: { key, offset: 10 } },
  };
  await act(async () =>
    root.render(<ThreadWorksPanelV2 key="returned" threadId="work-source" initialView={initialView} />),
  );
  let finish: (response: Response) => void = () => {};
  data.fetch.mockImplementation(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  await act(async () => window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated')));
  expect(host.querySelector('[data-work-anchor]')).toBeNull();
  await act(async () => finish(Response.json(body)));
  top = 60;
  await act(async () => host.querySelector('img')!.dispatchEvent(new Event('load')));
  await vi.waitFor(() => expect(host.querySelector<HTMLElement>('.v2-works-scroll')?.scrollTop).toBe(250));
});

it('standalone global Works opens another conversation artifact through the current host owner', async () => {
  const crossThread = { ...items[0], threadId: 'another-thread', threadTitle: 'Original conversation' };
  data.fetch.mockImplementation(async () =>
    Response.json({ artifacts: [crossThread], workLineage: 'resolved', view: 'works', complete: true, total: 1 }),
  );
  const previous = useChatStore.getState().workspaceOpenRevision;
  await act(async () =>
    root.render(
      <ThreadWorksPanelV2
        threadId="work-source"
        initialView={{ scope: 'global', filter: 'all', query: '', grouping: 'none', catFilter: null, collapsed: [] }}
      />,
    ),
  );
  const card = host.querySelector<HTMLButtonElement>('[data-testid="workspace-home-artifact-card"]');
  expect(card).not.toBeNull();
  await act(async () => card?.click());
  expect(useChatStore.getState().workspaceOpenRevision).toBe(previous + 1);
  expect(useChatStore.getState().workspaceOpenRequest?.threadId).toBe('work-source');
  expect(useChatStore.getState().workspaceOpenRequest?.target).toMatchObject({
    kind: 'artifact',
    artifact: { threadId: 'another-thread' },
  });
});

it('retires an unavailable type filter when the original catalogue refreshes', async () => {
  await act(async () => root.render(<ThreadWorksPanelV2 threadId="work-source" />));
  const types = host.querySelector<HTMLSelectElement>('select[aria-label="Work type"]')!;
  await act(async () => {
    types.value = 'file';
    types.dispatchEvent(new Event('change', { bubbles: true }));
  });
  data.fetch.mockImplementation(async () =>
    Response.json({
      artifacts: [items[1]],
      workLineage: 'resolved',
      view: 'works',
      complete: true,
    }),
  );
  await act(async () => window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated')));
  expect(types.value).toBe('all');
  expect(host.textContent).toContain('Exact PR');
  expect(host.textContent).not.toContain('No works match');
});

it('shows loading rather than a fabricated zero while retrying a failed refresh', async () => {
  await act(async () => root.render(<ThreadWorksPanelV2 threadId="work-source" />));
  expect(host.querySelector('.v2-works-count')?.textContent).toContain('2 works');
  data.fetch.mockResolvedValue(new Response('', { status: 503 }));
  await act(async () => window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated')));
  data.fetch.mockImplementation(() => new Promise<Response>(() => {}));
  await act(async () => window.dispatchEvent(new Event('cat-cafe:entrusted-work-projection-invalidated')));
  expect(host.querySelector('.v2-works-count')?.textContent).not.toContain('0 works');
  expect(host.querySelector('.v2-works-count')?.textContent).toContain('Reading');
});

it('opens a coordinate-backed html_widget inside Works, but keeps an interactive card going back to its message', async () => {
  const widget: ThreadArtifactDTO = {
    type: 'widget',
    name: '同名',
    catId: 'codex61-sol',
    createdAt: 500,
    sourceMessageId: 'msg-html',
    widgetBlockId: 'block-a',
  };
  const interactive: ThreadArtifactDTO = {
    type: 'widget',
    name: '选择方案',
    catId: 'codex61-sol',
    createdAt: 400,
    sourceMessageId: 'msg-choice',
  };
  data.fetch.mockImplementation(async () =>
    Response.json({
      threadId: 'work-source',
      artifacts: [widget, interactive],
      workLineage: 'resolved',
      view: 'works',
      complete: true,
      total: 2,
    }),
  );
  useChatStore.setState({ currentThreadId: 'work-source', rightPanelOpen: true });
  await act(async () => root.render(<ThreadWorksPanelV2 threadId="work-source" onSelectArtifact={open} />));

  const cards = host.querySelectorAll<HTMLButtonElement>('[data-testid="workspace-home-artifact-card"]');
  expect(cards).toHaveLength(2);
  await act(async () => cards[0].click());
  expect(open).toHaveBeenCalledExactlyOnceWith(widget, expect.objectContaining({ kind: 'artifact-list' }));

  await act(async () => cards[1].click());
  expect(open).toHaveBeenCalledTimes(1);
  expect(useChatStore.getState().rightPanelOpen).toBe(false);
});

it('opens homepage Works in all conversations because the landing page has no source conversation', async () => {
  data.fetch.mockImplementation(async () =>
    Response.json({
      artifacts: items.map((item) => ({ ...item, threadId: 'owned', threadTitle: 'Original' })),
      workLineage: 'resolved',
      view: 'works',
      complete: true,
      pageTotal: items.length,
    }),
  );
  await act(async () => root.render(<ThreadWorksPanelV2 threadId="default" />));
  const all = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'All conversations',
  );
  expect(all?.getAttribute('aria-pressed')).toBe('true');
  expect(data.fetch.mock.calls.some(([path]) => path === '/api/artifacts?view=works&read=pages')).toBe(true);
  expect(data.fetch.mock.calls.some(([path]) => path.includes('/threads/default/artifacts'))).toBe(false);
  expect(host.textContent).toContain('Delivered.md');
});
