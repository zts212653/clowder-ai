import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ModificationArtwork } from '../video-project/ModificationArtwork';
import type { ModificationArtworkPair } from '../video-project/modification-inputs';
import { ProjectModificationView } from '../video-project/ProjectModificationView';
import {
  modificationOpinion,
  modificationScreening,
  modificationSnapshot,
  twoArtworkModification,
} from './modification.fixture';

const { request, replies } = vi.hoisted(() => ({ request: vi.fn(), replies: new Map<string, Response>() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: request }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: () => ({ displayName: '小太阳', color: { primary: '#996633' } }) }),
}));
let root: Root, container: HTMLDivElement;
const onJump = vi.fn(),
  onClose = vi.fn();
const createUrl = vi.fn(),
  revokeUrl = vi.fn();
const originalCreate = URL.createObjectURL,
  originalRevoke = URL.revokeObjectURL;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  replies.clear();
  request
    .mockReset()
    .mockImplementation(
      async (path: string) => replies.get(path)?.clone() ?? Response.json({ error: 'not_found' }, { status: 404 }),
    );
  createUrl.mockReset().mockImplementation(() => `blob:artwork-${createUrl.mock.calls.length}`);
  revokeUrl.mockReset();
  URL.createObjectURL = createUrl;
  URL.revokeObjectURL = revokeUrl;
  onJump.mockClear();
  onClose.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
});
function fixtures() {
  const before = modificationSnapshot(1),
    after = modificationSnapshot(2);
  replies.set('/api/video-projects/project-1?ownerRevision=1', Response.json(before));
  replies.set('/api/video-projects/project-1?ownerRevision=2', Response.json(after));
  for (const [id, revision] of [
    ['png-old', 1],
    ['png-new', 2],
  ] as const)
    replies.set(
      `/api/video-projects/project-1/assets/${id}?ownerRevision=${revision}`,
      new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }),
    );
  return { before, after, annotation: modificationOpinion(before, after), screenings: [modificationScreening(after)] };
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
function button(text: string) {
  const value = Array.from(container.querySelectorAll('button')).find((item) => item.textContent === text);
  if (!value) throw new Error(`Missing ${text}`);
  return value;
}
function change(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
function required<T extends Element>(selector: string): T {
  const value = container.querySelector<T>(selector);
  if (!value) throw new Error(`Missing ${selector}`);
  return value;
}
it('renders two exact frozen inputs, shared zoom/scroll and the qualifying C08c jump', async () => {
  const data = fixtures();
  await act(async () =>
    root.render(<ProjectModificationView contentRef="project-1" {...data} onJump={onJump} onClose={onClose} />),
  );
  await settle();
  expect(container.querySelectorAll('section[aria-label$="画稿"] img')).toHaveLength(2);
  expect(request.mock.calls.map(([path]) => path)).toEqual([
    '/api/video-projects/project-1?ownerRevision=2',
    '/api/video-projects/project-1?ownerRevision=1',
    '/api/video-projects/project-1/assets/png-old?ownerRevision=1',
    '/api/video-projects/project-1/assets/png-new?ownerRevision=2',
  ]);
  expect(container.textContent).toContain('原输入 v1');
  expect(container.textContent).toContain('修改输入 v2');
  change(required<HTMLInputElement>('input[aria-label="同步缩放"]'), '2');
  expect(
    Array.from(container.querySelectorAll('section[aria-label$="画稿"] img')).every(
      (image) => image.parentElement?.style.width === '200%',
    ),
  ).toBe(true);
  const old = required<HTMLElement>('section[aria-label="原画稿"]'),
    next = required<HTMLElement>('section[aria-label="修改画稿"]');
  Object.defineProperties(old, {
    scrollWidth: { value: 600 },
    clientWidth: { value: 200 },
    scrollHeight: { value: 1000 },
    clientHeight: { value: 200 },
  });
  Object.defineProperties(next, {
    scrollWidth: { value: 1000 },
    clientWidth: { value: 200 },
    scrollHeight: { value: 600 },
    clientHeight: { value: 200 },
  });
  old.scrollLeft = 100;
  old.scrollTop = 400;
  act(() => old.dispatchEvent(new Event('scroll')));
  expect(next.scrollLeft).toBe(200);
  expect(next.scrollTop).toBe(200);
  act(() => button('在新版中查看 · 0:47.6').click());
  expect(onJump).toHaveBeenCalledWith('rendered-change', 1429 * 512);
  act(() => button('返回审片').click());
  expect(onClose).toHaveBeenCalledOnce();
});
it.each([
  'asset_missing',
  'asset_changed',
])('keeps the real modified image visible while original %s is explicit', async (code) => {
  const data = fixtures();
  replies.set(
    '/api/video-projects/project-1/assets/png-old?ownerRevision=1',
    Response.json({ error: code }, { status: code === 'asset_missing' ? 404 : 409 }),
  );
  await act(async () =>
    root.render(<ProjectModificationView contentRef="project-1" {...data} onJump={onJump} onClose={onClose} />),
  );
  await settle();
  expect(container.querySelectorAll('section[aria-label$="画稿"] img')).toHaveLength(1);
  expect(container.querySelector<HTMLImageElement>('section[aria-label$="画稿"] img')?.alt).toContain('修改画稿');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    code === 'asset_missing' ? '已缺失' : '字节已变化',
  );
  expect(request.mock.calls.filter(([path]) => String(path).includes('/assets/'))).toHaveLength(2);
});
it('shows wrong receipt digest explicitly and retry reads the same exact revision, not head', async () => {
  const data = fixtures();
  const wrong = { ...data.after, blobDigest: `sha256:${'e'.repeat(64)}` };
  replies.set('/api/video-projects/project-1?ownerRevision=2', Response.json(wrong));
  await act(async () =>
    root.render(<ProjectModificationView contentRef="project-1" {...data} onJump={onJump} onClose={onClose} />),
  );
  await settle();
  expect(container.textContent).toContain('摘要不匹配');
  expect(container.querySelector<HTMLImageElement>('section[aria-label$="画稿"] img')).toBeNull();
  expect(container.textContent).not.toContain('在影片中查看');
  replies.set('/api/video-projects/project-1?ownerRevision=2', Response.json(data.after));
  await act(async () => button('重试').click());
  await settle();
  expect(container.querySelectorAll('section[aria-label$="画稿"] img')).toHaveLength(2);
  expect(request.mock.calls.some(([path]) => path === '/api/video-projects/project-1')).toBe(false);
});
it('returns to the original frozen film with its computed appearance and keeps missing new-render status honest', async () => {
  const data = fixtures();
  await act(async () =>
    root.render(
      <ProjectModificationView
        contentRef="project-1"
        {...data}
        screenings={[modificationScreening(data.before, 'original-film')]}
        onJump={onJump}
        onClose={onClose}
      />,
    ),
  );
  await settle();
  expect(container.textContent).toContain('修改尚未生成成片');
  expect(container.textContent).not.toContain('在新版中查看');
  act(() => button('在原片中查看 · 0:47.6').click());
  expect(onJump).toHaveBeenCalledWith('original-film', 1429 * 512);
});
it('changing the selected artwork changes its own verified new-film appearance, instead of borrowing the first pair', async () => {
  const data = fixtures();
  for (const snapshot of [data.before, data.after]) {
    const first = snapshot.document.timeline.segments[1].visuals[0];
    snapshot.document.timeline.segments[1].visuals.push({
      ...first,
      id: 'C08-extra',
      startTick: snapshot.ownerRevision === 1 ? 110 : 120,
    });
  }
  if ('kind' in data.annotation.anchor && data.annotation.anchor.kind === 'video-project')
    data.annotation.anchor.target = { kind: 'artwork', assetVersionRef: 'png-old' };
  replies.set('/api/video-projects/project-1?ownerRevision=1', Response.json(data.before));
  replies.set('/api/video-projects/project-1?ownerRevision=2', Response.json(data.after));
  await act(async () =>
    root.render(<ProjectModificationView contentRef="project-1" {...data} onJump={onJump} onClose={onClose} />),
  );
  await settle();
  const select = required<HTMLSelectElement>('select[aria-label="关联画稿"]');
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, '1');
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await settle();
  act(() => button('在新版中查看 · 0:49.3').click());
  expect(onJump).toHaveBeenCalledWith('rendered-change', 1479 * 512);
});
it('switches between verified and unreadable pair truth while retaining exact original-film navigation', async () => {
  fixtures();
  const { before, after, firstOnly, unknown, annotation } = twoArtworkModification();
  for (const snapshot of [before, after, firstOnly])
    replies.set(`/api/video-projects/project-1?ownerRevision=${snapshot.ownerRevision}`, Response.json(snapshot));
  await act(async () =>
    root.render(
      <ProjectModificationView
        contentRef="project-1"
        annotation={annotation}
        screenings={[
          modificationScreening(before, 'original-film'),
          modificationScreening(firstOnly, 'first-film'),
          modificationScreening(unknown, 'unreadable-film'),
        ]}
        onJump={onJump}
        onClose={onClose}
      />,
    ),
  );
  await settle();
  expect(container.textContent).toContain('在新版中查看 · 0:47.6');
  const select = required<HTMLSelectElement>('select[aria-label="关联画稿"]');
  const choose = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  };
  await choose('1');
  expect(container.textContent).toContain('修改对应的成片暂时无法核验');
  expect(container.textContent).not.toContain('修改尚未生成成片');
  act(() => button('在原片中查看 · 0:48.9').click());
  expect(onJump).toHaveBeenLastCalledWith('original-film', 1469 * 512);
  await choose('0');
  expect(container.textContent).toContain('在新版中查看 · 0:47.6');
  expect(container.textContent).not.toContain('暂时无法核验');
});
it('explains unrendered timing changes without displaying an identical image pair', async () => {
  const data = fixtures();
  data.after.document.timeline.segments[1].visuals[0].assetVersionRef = 'png-old';
  data.after.document.timeline.segments[1].visuals[0].startTick = 80;
  replies.set('/api/video-projects/project-1?ownerRevision=2', Response.json(data.after));
  await act(async () =>
    root.render(
      <ProjectModificationView
        contentRef="project-1"
        annotation={data.annotation}
        screenings={[]}
        onJump={onJump}
        onClose={onClose}
      />,
    ),
  );
  await settle();
  expect(container.querySelector<HTMLImageElement>('section[aria-label$="画稿"] img')).toBeNull();
  expect(container.textContent).toContain('修改输入 v2');
  expect(container.textContent).toContain('没有可并排的不同画稿');
  expect(container.textContent).toContain('出现时间由 47.633 秒 改为 47.967 秒');
  expect(container.textContent).toContain('修改尚未生成成片');
});
it('makes genuine orientation changes fit their rotated bounds and revokes retired image URLs', async () => {
  const { before, after } = fixtures();
  const pair: ModificationArtworkPair = {
    id: 'rotation',
    label: 'C08c',
    before: { ownerRevision: 1, version: before.document.assets[0].versions[0] },
    after: { ownerRevision: 2, version: { ...after.document.assets[0].versions[1], rotation: 90 } },
  };
  await act(async () => root.render(<ModificationArtwork contentRef="project-1" pair={pair} />));
  await settle();
  const old = required<HTMLImageElement>('section[aria-label="原画稿"] img'),
    next = required<HTMLImageElement>('section[aria-label="修改画稿"] img');
  expect(old.parentElement?.style.aspectRatio).toBe('1920 / 1080');
  expect(next.parentElement?.style.aspectRatio).toBe('1080 / 1920');
  expect(next.style.transform).toContain('rotate(90deg)');
  await act(async () => root.render(<p>closed</p>));
  expect(revokeUrl.mock.calls.map(([url]) => url).sort()).toEqual(
    createUrl.mock.results.map((item) => item.value).sort(),
  );
});
