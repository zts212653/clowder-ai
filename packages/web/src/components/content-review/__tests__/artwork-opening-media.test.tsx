import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mediaView } from '@/components/workbench/content-review/__tests__/WorkspaceContentReviewSurface.fixture';
import { ContentReviewSurface } from '@/components/workbench/content-review/ContentReviewSurface';
import { WorkspaceContentReviewSourceState } from '@/components/workbench/content-review/WorkspaceContentReviewSourceState';
import { createFilePreviewSurface } from '@/components/workbench/real-surface-adapters';
import type { FloatingArtwork } from '../ArtworkLightboxScope';
import { ArtworkOpeningPreview } from '../ArtworkOpeningPreview';

vi.mock('@/components/workbench/content-review/WorkspaceContentReviewProjection', () => ({
  WorkspaceContentReviewProjection: () => (
    <img src="http://api.test/owner.jpg" alt="owner" data-testid="workspace-content-review-media" />
  ),
}));

const work: FloatingArtwork = {
  url: 'http://api.test/already-visible.jpg',
  title: '原图',
  alt: '原图',
  mediaType: 'image',
  surface: createFilePreviewSurface({ worktreeId: 'root', path: 'original.jpg' }),
};
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});
const preview = () => host.querySelector('[data-testid="artwork-chat-preview"]');

it.each([
  false,
  true,
])('keeps the cached picture until owner pixels decode, including an ancillary alert (%s)', async (warning) => {
  await act(async () =>
    root.render(
      <ArtworkOpeningPreview work={work}>
        {warning ? <p role="alert">标记草稿尚未保存到浏览器，请保留页面。</p> : null}
        <img
          src="http://api.test/verified-version.jpg"
          alt="owner image"
          data-testid="workspace-content-review-media"
        />
        <button type="button">圈选</button>
      </ArtworkOpeningPreview>,
    ),
  );
  const image = host.querySelector<HTMLImageElement>('img[alt="owner image"]')!;
  let decode!: () => void;
  Object.defineProperties(image, {
    currentSrc: { value: image.src },
    complete: { value: true },
    naturalWidth: { value: 1440 },
    naturalHeight: { value: 900 },
    decode: {
      value: () =>
        new Promise<void>((resolve) => {
          decode = resolve;
        }),
    },
  });
  await act(async () => image.dispatchEvent(new Event('load')));
  expect(preview()).not.toBeNull();
  expect(image.parentElement?.inert).toBe(true);
  await act(async () => decode());
  expect(preview()).toBeNull();
  expect(image.parentElement?.inert).toBe(false);
});

it.each([
  'unavailable',
  'changed',
] as const)('exposes the actual owner source state without an alert role (%s)', async (sourceState) => {
  const render = (refused: boolean) =>
    act(async () =>
      root.render(
        <ArtworkOpeningPreview work={work}>
          <WorkspaceContentReviewSourceState
            view={{ ...mediaView(), sourceState: refused ? sourceState : 'current' }}
            busy={false}
            refreshSource={vi.fn().mockResolvedValue(undefined)}
          />
        </ArtworkOpeningPreview>,
      ),
    );
  await render(false);
  expect(preview()).not.toBeNull();
  await render(true);
  expect(preview()).toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector<HTMLElement>('[aria-hidden="false"]')?.inert).toBe(false);
  expect(host.textContent).toContain(sourceState === 'unavailable' ? '原内容当前不可读取' : '原文件已改动');
});

it('observes an explicit blocked state applied to an existing owner node', async () => {
  const render = (blocked: boolean) =>
    act(async () =>
      root.render(
        <ArtworkOpeningPreview work={work}>
          <p data-content-opening-state={blocked ? 'blocked' : undefined}>原版本当前无法读取</p>
        </ArtworkOpeningPreview>,
      ),
    );
  await render(false);
  const notice = host.querySelector('p');
  expect(preview()).not.toBeNull();
  await render(true);
  expect(host.querySelector('p')).toBe(notice);
  expect(preview()).toBeNull();
  expect(notice?.parentElement?.inert).toBe(false);
});

it.each([
  false,
  true,
])('distinguishes an initial owner read refusal from an ancillary controller error (%s)', async (hasView) => {
  await act(async () =>
    root.render(
      <ArtworkOpeningPreview work={work}>
        <ContentReviewSurface
          path="original.jpg"
          sourceText=""
          sourceTextRevision=""
          onBack={vi.fn()}
          review={{
            view: hasView ? mediaView() : null,
            error: '本次读取失败',
            draft: '',
            target: null,
            activeAnnotationId: null,
            busy: false,
            pending: false,
            setDraft: vi.fn(),
            setTarget: vi.fn(),
            setActiveAnnotationId: vi.fn(),
            submitAnnotation: vi.fn().mockResolvedValue(undefined),
            refreshSource: vi.fn().mockResolvedValue(undefined),
            act: vi.fn().mockResolvedValue(false),
            retryPending: vi.fn().mockResolvedValue(undefined),
          }}
        />
      </ArtworkOpeningPreview>,
    ),
  );
  expect(preview() !== null).toBe(hasView);
  expect(host.querySelector('[role="alert"]')?.textContent).toBe('本次读取失败');
});

it('carries the preview playhead forward but waits for a fresh frame from the verified video', async () => {
  // biome-ignore lint/a11y/useMediaCaption: controlled test video never fetches media.
  await act(async () =>
    root.render(
      <ArtworkOpeningPreview work={{ ...work, mediaType: 'video', url: 'http://api.test/chat.mp4' }}>
        <video src="http://api.test/verified-v1.mp4" data-testid="workspace-content-review-media" />
      </ArtworkOpeningPreview>,
    ),
  );
  const video = host.querySelector<HTMLVideoElement>('[data-testid="workspace-content-review-media"]')!;
  const prior = preview()!.querySelector('video')!;
  let nextFrame!: VideoFrameRequestCallback;
  Object.defineProperties(video, {
    currentSrc: { value: video.src },
    readyState: { value: 4 },
    seeking: { value: false },
    videoWidth: { value: 1920 },
    videoHeight: { value: 1080 },
    duration: { value: 120 },
    requestVideoFrameCallback: {
      value: (callback: VideoFrameRequestCallback) => {
        nextFrame = callback;
        return 1;
      },
    },
    cancelVideoFrameCallback: { value: vi.fn() },
  });
  vi.spyOn(video, 'pause').mockImplementation(() => {});
  vi.spyOn(prior, 'pause').mockImplementation(() => {});
  prior.currentTime = 42;
  await act(async () => video.dispatchEvent(new Event('emptied')));
  await act(async () => video.dispatchEvent(new Event('loadeddata')));
  expect(preview(), 'a loadeddata event alone does not prove a displayed video frame').not.toBeNull();
  await act(async () => nextFrame(0, { mediaTime: 0 } as VideoFrameCallbackMetadata));
  expect(video.currentTime).toBe(42);
  expect(preview(), 'the first frame at zero cannot replace the preview at forty-two seconds').not.toBeNull();
  await act(async () => video.dispatchEvent(new Event('seeking')));
  await act(async () => video.dispatchEvent(new Event('seeked')));
  await act(async () => nextFrame(0, { mediaTime: 42 } as VideoFrameCallbackMetadata));
  expect(preview()).toBeNull();
  expect(host.querySelectorAll('video')).toHaveLength(1);
});

it.each([
  false,
  true,
])('retains the owner resume position unless the preview was explicitly rewound (%s)', async (rewound) => {
  // biome-ignore lint/a11y/useMediaCaption: controlled media readiness; no network.
  await act(async () =>
    root.render(
      <ArtworkOpeningPreview work={{ ...work, mediaType: 'video', url: 'http://api.test/chat.mp4' }}>
        <video src="http://api.test/verified-v1.mp4" data-testid="workspace-content-review-media" />
      </ArtworkOpeningPreview>,
    ),
  );
  const video = host.querySelector<HTMLVideoElement>('[data-testid="workspace-content-review-media"]')!;
  const prior = preview()!.querySelector('video')!;
  let nextFrame!: VideoFrameRequestCallback;
  Object.defineProperties(video, {
    currentSrc: { value: video.src },
    readyState: { value: 4 },
    seeking: { value: false },
    videoWidth: { value: 1920 },
    videoHeight: { value: 1080 },
    duration: { value: 120 },
    requestVideoFrameCallback: {
      value: (callback: VideoFrameRequestCallback) => {
        nextFrame = callback;
        return 1;
      },
    },
    cancelVideoFrameCallback: { value: vi.fn() },
  });
  vi.spyOn(video, 'pause').mockImplementation(() => {});
  vi.spyOn(prior, 'pause').mockImplementation(() => {});
  video.currentTime = 42;
  if (rewound) await act(async () => prior.dispatchEvent(new Event('seeking')));
  await act(async () => video.dispatchEvent(new Event('emptied')));
  await act(async () => video.dispatchEvent(new Event('loadeddata')));
  await act(async () => nextFrame(0, { mediaTime: 42 } as VideoFrameCallbackMetadata));
  expect(video.currentTime, 'an untouched zero-second preview must not erase the original owner resume position').toBe(
    rewound ? 0 : 42,
  );
  if (rewound) {
    expect(preview()).not.toBeNull();
    await act(async () => video.dispatchEvent(new Event('seeking')));
    await act(async () => video.dispatchEvent(new Event('seeked')));
    await act(async () => nextFrame(0, { mediaTime: 0 } as VideoFrameCallbackMetadata));
  }
  expect(preview()).toBeNull();
});
