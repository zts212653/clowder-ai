import { FEATURE_DEMOS, type ThreadArtifactDTO } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkCoverLayer } from '../WorkCoverLayer';
import { WorkGalleryCard } from '../WorkGalleryCard';
import { COVER_CARD_RATIO, coverFit, WORK_COVER_CHANGED_EVENT } from '../work-cover-client';

const fetcher = vi.fn();
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://localhost:3102',
  apiFetch: (...args: unknown[]) => fetcher(...args),
}));
vi.mock('@/hooks/useThreadArtifacts', () => ({
  useThreadArtifacts: () => ({
    artifacts: [],
    loading: false,
    error: false,
    refetch: vi.fn(),
    works: [],
    total: 0,
    complete: true,
  }),
}));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (select: (state: { currentThreadId: string }) => unknown) => select({ currentThreadId: 'thread-film' }),
}));

const reference = { contentRef: `work:${'c'.repeat(64)}`, ownerRevision: 1, currentOwnerRevision: 1 };
const film: ThreadArtifactDTO = {
  type: 'video',
  name: '寄自猫猫星球',
  url: `/api/content-publications/${encodeURIComponent(reference.contentRef)}/media/1`,
  catId: 'opus55',
  createdAt: 1,
  sourceMessageId: null,
  work: reference,
};
const coverUrl = `/api/works/cover/image?contentRef=${encodeURIComponent(reference.contentRef)}&ownerRevision=1&coverRevision=1`;
const description = (blobDigest = `sha256:${'d'.repeat(64)}`) => ({
  asset: {
    contentRef: reference.contentRef,
    ownerRevision: 1,
    mediaType: 'video/mp4',
    blobDigest,
    media: { kind: 'video', durationTicks: 56 * 90000, timebase: { numerator: 1, denominator: 90000 } },
  },
  currentOwnerRevision: 1,
});
const adopted = {
  reference: { contentRef: reference.contentRef, ownerRevision: 1 },
  coverRevision: 1,
  state: 'image',
  image: {
    name: '封面 B 横版',
    mediaType: 'image/png',
    sha256: `sha256:${'e'.repeat(64)}`,
    origin: {
      kind: 'work-asset',
      reference: { contentRef: reference.contentRef, ownerRevision: 1 },
      metadataRevision: 1,
      assetId: 'cover-b',
      assetName: '封面 B 横版',
      assetKind: 'cover',
    },
    url: coverUrl,
  },
  basis: { kind: 'chosen' },
};
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

function route(cover: unknown, digest?: string, extra: Record<string, unknown> = {}) {
  fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith('/api/works/cover/candidates')) return extra.candidates ?? ok({ candidates: [] });
    if (url === '/api/works/cover' && init?.method === 'POST') return (extra.save as () => unknown)();
    if (url.startsWith('/api/works/cover')) return ok(cover);
    if (url.startsWith('/api/content-publications/')) return ok(description(digest));
    throw new Error(`unexpected ${url}`);
  });
}

async function render() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      <>
        <WorkGalleryCard artifact={film} metadata="宪宪 · 第 1 版" onSelect={vi.fn()} />
        <WorkCoverLayer />
      </>,
    ),
  );
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return { host, root };
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.dispatchEvent(new Event(WORK_COVER_CHANGED_EVENT));
});
afterEach(() => {
  vi.restoreAllMocks();
  fetcher.mockReset();
  document.body.innerHTML = '';
});

describe('cover fit', () => {
  it('fills only when the actual picture loses at most a tenth', () => {
    expect(coverFit(1920, 1080)).toBe('fill');
    expect(coverFit(1440, 1000)).toBe('fill');
    expect(coverFit(1950, 1000)).toBe('contain');
    expect(coverFit(900, 1200)).toBe('contain');
    expect(coverFit(1000, 1000)).toBe('contain');
    expect(COVER_CARD_RATIO).toBe(1.6);
  });
});

describe('adopted cover on an ordinary video work', () => {
  it('shows the adopted picture with the film duration and never reads the video', async () => {
    const create = vi.spyOn(document, 'createElement');
    route(adopted);
    const { host, root } = await render();
    try {
      // Fails if the card goes back to matching FEATURE_DEMOS by digest: this work is not a demo.
      expect(host.querySelector('.work-cover-picture-main')?.getAttribute('src')).toBe(
        `http://localhost:3102${coverUrl}`,
      );
      expect(create.mock.calls.filter(([tag]) => tag === 'video')).toHaveLength(0);
      expect(host.textContent).toContain('0:56');
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('a cleared or unreadable choice shows a real frame instead of any other picture', async () => {
    const demo = FEATURE_DEMOS['conversation-proposals-v1'];
    if (!demo?.sha256) throw new Error('Published demo fixture missing');
    for (const cover of [
      { ...adopted, coverRevision: 2, state: 'frame', image: undefined, basis: { kind: 'cleared' } },
      { ...adopted, state: 'unavailable' },
    ]) {
      route(cover, `sha256:${demo.sha256}`);
      const { host, root } = await render();
      try {
        expect(host.querySelector('.work-cover-picture-main')).toBeNull();
      } finally {
        await act(async () => root.unmount());
      }
      window.dispatchEvent(new Event(WORK_COVER_CHANGED_EVENT));
    }
  });
});

describe('cover entry in the shared card menu', () => {
  async function openMenu(host: HTMLElement) {
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
    if (!trigger) throw new Error('card menu missing');
    await act(async () => trigger.click());
    return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  }

  it('picks a picture, keeps it after a failure, then saves once and offers undo', async () => {
    let attempts = 0;
    const posts: unknown[] = [];
    const candidate = {
      key: 'asset:1:cover-b',
      name: '封面 B 横版',
      mediaType: 'image/png',
      sha256: `sha256:${'e'.repeat(64)}`,
      previewUrl: '/api/works/x/video-assets/1/1/cover-b?threadId=t',
      source: 'work-asset',
      ownerRevision: 1,
      pick: { kind: 'work-asset', ownerRevision: 1, metadataRevision: 1, assetId: 'cover-b' },
    };
    route({ reference: adopted.reference, coverRevision: 0, state: 'none' }, undefined, {
      candidates: ok({ candidates: [candidate] }),
      save: () => {
        attempts++;
        if (attempts === 1) return { ok: false, status: 503, json: async () => ({}) };
        return ok({ status: 'saved', record: { coverRevision: 1 }, cover: adopted });
      },
    });
    fetcher.mockName('api');
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') posts.push(JSON.parse(String(init.body)));
      return original(url, init);
    });
    const { host, root } = await render();
    try {
      const items = await openMenu(host);
      const set = items.find((item) => item.textContent?.includes('设置封面…'));
      expect(set).toBeDefined();
      expect(items.some((item) => item.textContent?.includes('清除封面'))).toBe(false);
      await act(async () => set!.click());
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog?.textContent).toContain('给《寄自猫猫星球》第 1 版选封面');
      expect(dialog?.textContent).toContain('视频本身不动，也不会多出一版');
      const thumb = document.querySelector<HTMLButtonElement>('.work-cover-thumb');
      await act(async () => thumb!.click());
      expect(document.querySelector('[data-testid="work-cover-preview-card"]')).not.toBeNull();
      const confirm = () => [...document.querySelectorAll<HTMLButtonElement>('.work-cover-button-primary')][0]!;
      await act(async () => confirm().click());
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('封面没换成');
      expect(document.querySelector('.work-cover-thumb[aria-checked="true"]')).not.toBeNull();
      await act(async () => confirm().click());
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(posts).toHaveLength(2);
      const [first, second] = posts as { command: { operationId: string; expectedCoverRevision: number } }[];
      expect(second!.command.operationId).toBe(first!.command.operationId);
      expect(second!.command.expectedCoverRevision).toBe(0);
      expect(document.activeElement).toBe(host.querySelector('.work-gallery-open'));
      const notice = document.querySelector('.work-cover-notice');
      expect(notice?.textContent).toContain('第 1 版的封面已换');
      const undo = notice?.querySelector('button');
      await act(async () => undo!.click());
      const undoPost = posts[2] as { command: { choice: unknown; expectedCoverRevision: number } };
      expect(undoPost.command.choice).toEqual({ mode: 'frame' });
      expect(undoPost.command.expectedCoverRevision).toBe(1);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it('offers change and clear for an adopted cover and the unreadable wording when lost', async () => {
    route(adopted);
    let rendered = await render();
    let items = await openMenu(rendered.host);
    expect(items.map((item) => item.textContent)).toEqual(expect.arrayContaining(['更换封面…', '清除封面']));
    await act(async () => rendered.root.unmount());
    window.dispatchEvent(new Event(WORK_COVER_CHANGED_EVENT));
    route({ ...adopted, state: 'unavailable' });
    rendered = await render();
    items = await openMenu(rendered.host);
    expect(items.some((item) => item.textContent === '封面图读不到了 · 更换封面…')).toBe(true);
    await act(async () => rendered.root.unmount());
  });
});
