import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { syncContextAttachmentDraftToStorage } from '../../thread-drafts';
import { VideoProjectScreeningPlayer } from '../video-project/VideoProjectScreeningPlayer';
import { WorkspaceSurfaceVisibilityProvider } from '../WorkspaceSurfaceVisibility';
import { comparisonShot, comparisonSide } from './compare-screening.fixture';

// Generic node consumer fixtures; browser decoding and movie provenance are verified separately.
const threadId = 'thread-player-fixture';
function fixture(fps?: number) {
  const side = comparisonSide('old', [comparisonShot('shot-1', 0, 100), comparisonShot('shot-2', 100, 100)]);
  side.screening.media.media.timebase = { numerator: 1, denominator: 24000 };
  side.screening.media.media.durationTicks = 480000;
  if (fps) side.screening.media.media.frameRate = { numerator: fps, denominator: 1 };
  side.screening.mapping.segments[0].mediaEndPts = 480000;
  return side;
}
let root: ReturnType<typeof createRoot>, container: HTMLDivElement, video: HTMLVideoElement;
let playhead: number, seeking: boolean, callbackId: number;
let callbacks: Map<number, VideoFrameRequestCallback>;
let frameDescriptor: PropertyDescriptor | undefined, cancelDescriptor: PropertyDescriptor | undefined;
let side: ReturnType<typeof fixture>;
const assigned = vi.fn(),
  fetchSpy = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetchSpy);
  callbacks = new Map();
  callbackId = 0;
  playhead = 2;
  seeking = false;
  assigned.mockClear();
  fetchSpy.mockClear();
  side = fixture(30);
  useChatStore.setState({ currentThreadId: threadId, messages: [], pendingChatInsert: null });
  syncContextAttachmentDraftToStorage(threadId, []);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  frameDescriptor = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'requestVideoFrameCallback');
  cancelDescriptor = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'cancelVideoFrameCallback');
  Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
    configurable: true,
    value(callback: VideoFrameRequestCallback) {
      callbacks.set(++callbackId, callback);
      return callbackId;
    },
  });
  Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', {
    configurable: true,
    value(id: number) {
      callbacks.delete(id);
    },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useChatStore.setState({ pendingChatInsert: null });
  syncContextAttachmentDraftToStorage(threadId, []);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [key, descriptor] of [
    ['requestVideoFrameCallback', frameDescriptor],
    ['cancelVideoFrameCallback', cancelDescriptor],
  ] as const) {
    if (descriptor) Object.defineProperty(HTMLVideoElement.prototype, key, descriptor);
    else Reflect.deleteProperty(HTMLVideoElement.prototype, key);
  }
});
async function render(visible = true, markRequest?: number) {
  await act(async () =>
    root.render(
      <WorkspaceSurfaceVisibilityProvider visible={visible}>
        <VideoProjectScreeningPlayer {...side} markRequest={markRequest} />
      </WorkspaceSurfaceVisibilityProvider>,
    ),
  );
  const element = container.querySelector('video');
  if (!element) throw new Error('Native screening video was not rendered');
  video = element;
  Object.defineProperties(video, {
    currentTime: {
      configurable: true,
      get: () => playhead,
      set: (value: number) => {
        assigned(value);
        playhead = value;
        seeking = true;
      },
    },
    seeking: { configurable: true, get: () => seeking },
    readyState: { configurable: true, get: () => (seeking ? 1 : 4) },
  });
}
function button(text: string) {
  const element = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(text));
  if (!element) throw new Error(`Missing screening button: ${text}`);
  return element;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function present(mediaTime: number) {
  const entry = callbacks.entries().next().value;
  if (!entry) throw new Error('No pending native decoded-frame callback');
  const [id, callback] = entry;
  callbacks.delete(id);
  await act(async () =>
    callback(0, {
      mediaTime,
      presentedFrames: id,
      width: 1280,
      height: 720,
      presentationTime: 0,
      expectedDisplayTime: 0,
    }),
  );
}
async function seekEvent(type: 'seeking' | 'seeked') {
  seeking = type === 'seeking';
  await act(async () => video.dispatchEvent(new Event(type)));
}
it('does not seek back to an old mark when refreshed metadata preserves the same frozen film', async () => {
  await render();
  const focus = { pts: 48000, requestId: 1 };
  await act(async () =>
    root.render(
      <WorkspaceSurfaceVisibilityProvider visible>
        <VideoProjectScreeningPlayer {...side} focus={focus} />
      </WorkspaceSurfaceVisibilityProvider>,
    ),
  );
  await seekEvent('seeked');
  playhead = 8;
  await present(8);
  assigned.mockClear();
  side = structuredClone(side);
  await act(async () =>
    root.render(
      <WorkspaceSurfaceVisibilityProvider visible>
        <VideoProjectScreeningPlayer {...side} focus={{ ...focus }} />
      </WorkspaceSurfaceVisibilityProvider>,
    ),
  );
  expect(assigned).not.toHaveBeenCalled();
  expect(playhead).toBe(8);
});
it('does not mark the previous decoded frame after a shot seek until the new frame arrives', async () => {
  await render();
  await present(2);
  await click('标记问题');
  expect(button('记到原输入框').disabled).toBe(false);
  await click('shot-2');
  expect(assigned).toHaveBeenLastCalledWith(10);
  await seekEvent('seeking');
  await seekEvent('seeked');
  expect(button('记到原输入框').disabled).toBe(true);
  await click('记到原输入框');
  expect(useChatStore.getState().pendingChatInsert).toBeNull();
  await present(10);
  expect(button('记到原输入框').disabled).toBe(false);
});
it('queues the actual frame and frozen screening into the original composer without sending or importing', async () => {
  useChatStore.getState().setPendingChatInsert({ threadId, text: '原来的意见', imageUrls: ['/uploads/fixture.png'] });
  await render();
  await present(2);
  await click('标记问题');
  await click('记到原输入框');
  const queued = useChatStore.getState().pendingChatInsert;
  expect(queued).toMatchObject({
    threadId,
    text: '原来的意见',
    imageUrls: ['/uploads/fixture.png'],
    contextAttachments: [
      {
        kind: 'project-screening',
        screeningId: 'old',
        contentRef: side.input.contentRef,
        input: side.screening.input,
        media: { contentRef: 'media:old', ownerRevision: 1, blobDigest: side.screening.media.blobDigest },
        selections: [
          {
            mediaRange: { startPts: 48000, endPts: 48800 },
            target: { kind: 'moment', tick: 20, endTick: 21, timebase: { numerator: 1, denominator: 10 } },
          },
        ],
      },
    ],
  });
  expect(container.textContent).toContain('当前尚未记入问题');
  expect(useChatStore.getState().messages).toEqual([]);
  expect(fetchSpy).not.toHaveBeenCalled();
});
it('keeps a matching decoded frame when Chrome queues seeking after its presentation', async () => {
  await render();
  await present(2);
  await click('标记问题');
  await click('shot-2');
  await present(10);
  await seekEvent('seeking');
  await seekEvent('seeked');
  expect(button('记到原输入框').disabled).toBe(false);
});
it.each(['input', 'textarea', 'contenteditable', 'textbox'])('does not steal M typed in %s', async (kind) => {
  await render();
  const editor = document.createElement(kind === 'input' || kind === 'textarea' ? kind : 'div');
  if (kind === 'contenteditable') editor.setAttribute('contenteditable', 'true');
  if (kind === 'textbox') editor.setAttribute('role', 'textbox');
  container.append(editor);
  const event = new KeyboardEvent('keydown', { key: 'm', bubbles: true, cancelable: true });
  await act(async () => editor.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
  expect(container.textContent).not.toContain('记到原输入框');
  expect(useChatStore.getState().pendingChatInsert).toBeNull();
});
it('M opens a mark only for the visible Workspace and does not automatically queue or send it', async () => {
  await render(false);
  const hidden = new KeyboardEvent('keydown', { key: 'M', cancelable: true });
  await act(async () => window.dispatchEvent(hidden));
  expect(hidden.defaultPrevented).toBe(false);
  expect(container.textContent).not.toContain('记到原输入框');
  await render(true);
  await present(2);
  const visible = new KeyboardEvent('keydown', { key: 'M', cancelable: true });
  await act(async () => window.dispatchEvent(visible));
  expect(visible.defaultPrevented).toBe(true);
  expect(button('记到原输入框').disabled).toBe(false);
  expect(useChatStore.getState().pendingChatInsert).toBeNull();
  expect(fetchSpy).not.toHaveBeenCalled();
});
it('leaves embedded M handling to the shared surface and accepts only its explicit request', async () => {
  await render(true, 0);
  await present(2);
  const event = new KeyboardEvent('keydown', { key: 'M', cancelable: true });
  await act(async () => window.dispatchEvent(event));
  expect(event.defaultPrevented).toBe(false);
  expect(container.textContent).not.toContain('记到原输入框');
  await render(true, 1);
  expect(button('记到原输入框').disabled).toBe(false);
  expect(useChatStore.getState().pendingChatInsert).toBeNull();
});
it.each([30, 24])('steps using verified %i fps, not the project clock', async (fps) => {
  side = fixture(fps);
  await render();
  await present(2);
  await click('下一帧');
  expect(assigned.mock.lastCall?.[0]).toBeCloseTo(2 + 1.5 / fps, 12);
  expect(button('上一帧').disabled).toBe(true);
  await seekEvent('seeked');
  await present(2 + 1 / fps);
  await click('上一帧');
  expect(assigned.mock.lastCall?.[0]).toBeCloseTo(2 + 0.5 / fps, 12);
});
function ep0Clock(startTick = 0, durationTicks = 7555584) {
  side.screening.media.media.timebase = { numerator: 1, denominator: 15360 };
  side.screening.media.media.startTick = startTick;
  side.screening.media.media.durationTicks = durationTicks;
  side.screening.mapping.segments[0].mediaStartPts = startTick;
  side.screening.mapping.segments[0].mediaEndPts = startTick + 307200;
}
it.each([
  [47.633333, '下一帧', 1430],
  [47.633334, '下一帧', 1430],
  [47.633333, '上一帧', 1428],
  [47.633334, '上一帧', 1428],
  [47.666666, '上一帧', 1429],
  [47.666667, '上一帧', 1429],
] as const)('steps from rounded metadata %f using integer PTS for %s', async (metadata, control, targetFrame) => {
  ep0Clock();
  playhead = metadata;
  await render();
  await present(metadata);
  await click(control);
  const seconds = assigned.mock.lastCall?.[0];
  expect(seconds).toBeCloseTo((targetFrame * 512 + 256) / 15360, 12);
  // Chromium may truncate a seek to microseconds. The target remains inside the intended frame.
  const microsecondSeek = Math.floor(Number(seconds) * 1000000) / 1000000;
  expect(Math.floor((microsecondSeek * 15360) / 512)).toBe(targetFrame);
});
it.each([
  [0, '上一帧'],
  [491.866667, '下一帧'],
] as const)('does not pretend a neighbor exists at stream boundary %f for %s', async (metadata, control) => {
  ep0Clock();
  playhead = metadata;
  await render();
  await present(metadata);
  expect(button(control).disabled).toBe(true);
  await click(control);
  expect(assigned).not.toHaveBeenCalled();
});
it('steps relative to the verified stream start instead of a zero-origin frame grid', async () => {
  ep0Clock(16000);
  playhead = 1.375;
  await render();
  await present(1.375); // startPTS16000 + encoded frame10 *512.
  await click('下一帧');
  expect(assigned.mock.lastCall?.[0]).toBeCloseTo((16000 + 11 * 512 + 256) / 15360, 12);
});
it('disables both neighbors for a one-frame verified stream', async () => {
  ep0Clock(16000, 512);
  playhead = 1.041667;
  await render();
  await present(1.041667);
  expect(button('上一帧').disabled).toBe(true);
  expect(button('下一帧').disabled).toBe(true);
});
it('does not claim frame stepping when the imported media has no verified fixed frame rate', async () => {
  side = fixture();
  await render();
  await present(2);
  expect(button('上一帧').disabled).toBe(true);
  expect(button('上一帧').title).toContain('尚无可验证的固定帧率');
  expect(button('下一帧').disabled).toBe(true);
  await click('下一帧');
  expect(assigned).not.toHaveBeenCalled();
});
it('loops the captured original shot even after a decoded frame crosses into the next shot', async () => {
  await render();
  await present(2);
  await click('循环镜头');
  playhead = 12;
  await present(12);
  await act(async () => video.dispatchEvent(new Event('timeupdate')));
  expect(assigned).toHaveBeenLastCalledWith(0);
});
it('invalidates the old decoded frame immediately when the loop seeks back before native seeking is queued', async () => {
  await render();
  await present(2);
  await click('标记问题');
  await click('循环镜头');
  playhead = 12;
  await present(12);
  await act(async () => video.dispatchEvent(new Event('timeupdate')));
  expect(playhead).toBe(0);
  expect(button('记到原输入框').disabled).toBe(true);
  await seekEvent('seeked');
  await present(0);
  expect(button('记到原输入框').disabled).toBe(false);
});
