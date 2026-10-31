import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { syncContextAttachmentDraftToStorage } from '../../thread-drafts';
import { VideoProjectScreeningPlayer } from '../video-project/VideoProjectScreeningPlayer';
import { WorkspaceSurfaceVisibilityProvider } from '../WorkspaceSurfaceVisibility';
import { comparisonShot, comparisonSide } from './compare-screening.fixture';

const threadId = 'player-cancel-fixture';
const network = vi.fn();
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let video: HTMLVideoElement;
let playhead = 2;
let nextId = 0;
let callbacks = new Map<number, VideoFrameRequestCallback>();
let frameDescriptor: PropertyDescriptor | undefined;
let cancelDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  network.mockReset();
  vi.stubGlobal('fetch', network);
  callbacks = new Map();
  nextId = 0;
  playhead = 2;
  useChatStore.setState({ currentThreadId: threadId, messages: [], pendingChatInsert: null });
  syncContextAttachmentDraftToStorage(threadId, []);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  frameDescriptor = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'requestVideoFrameCallback');
  cancelDescriptor = Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'cancelVideoFrameCallback');
  Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
    configurable: true,
    value(callback: VideoFrameRequestCallback) {
      callbacks.set(++nextId, callback);
      return nextId;
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
  expect(network).not.toHaveBeenCalled();
  expect(useChatStore.getState().messages).toEqual([]);
  await act(async () => root.unmount());
  container.remove();
  useChatStore.setState({ pendingChatInsert: null });
  syncContextAttachmentDraftToStorage(threadId, []);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (frameDescriptor) Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', frameDescriptor);
  else Reflect.deleteProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback');
  if (cancelDescriptor) Object.defineProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback', cancelDescriptor);
  else Reflect.deleteProperty(HTMLVideoElement.prototype, 'cancelVideoFrameCallback');
});

function button(text: string) {
  const found = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(text));
  if (!found) throw new Error(`Missing ${text}`);
  return found;
}

async function click(text: string) {
  await act(async () => button(text).click());
}

async function present(mediaTime: number) {
  const entry = callbacks.entries().next().value;
  if (!entry) throw new Error('Missing decoded-frame callback');
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

async function renderPlayer() {
  const side = comparisonSide('old', [comparisonShot('shot-1', 0, 100), comparisonShot('shot-2', 100, 100)]);
  side.screening.media.media.timebase = { numerator: 1, denominator: 24000 };
  side.screening.media.media.durationTicks = 480000;
  side.screening.media.media.frameRate = { numerator: 30, denominator: 1 };
  side.screening.mapping.segments[0].mediaEndPts = 480000;
  await act(async () =>
    root.render(
      <WorkspaceSurfaceVisibilityProvider visible>
        <VideoProjectScreeningPlayer {...side} />
      </WorkspaceSurfaceVisibilityProvider>,
    ),
  );
  const element = container.querySelector('video');
  if (!element) throw new Error('Missing video');
  video = element;
  Object.defineProperties(video, {
    currentTime: { configurable: true, get: () => playhead },
    seeking: { configurable: true, get: () => false },
    readyState: { configurable: true, get: () => 4 },
  });
}

it('discarding a mark also discards its old range start before the next mark', async () => {
  await renderPlayer();
  await present(2);
  await click('标记问题');
  await click('设为范围起点');
  await click('取消');

  playhead = 12;
  await present(12);
  await click('标记问题');
  await click('记到原输入框');
  const attachment = useChatStore.getState().pendingChatInsert?.contextAttachments?.[0];
  expect(attachment).toMatchObject({
    kind: 'project-screening',
    selections: [{ mediaRange: { startPts: 288000 } }],
  });
});

// Keep the same decoded frame: changing PTS would clear the region independently and mask the cancel bug.
it('cancels a visible region and never queues that invisible old frame box when reopened', async () => {
  await renderPlayer();
  await present(2);
  await click('标记问题');
  const field = container.querySelector<HTMLElement>('fieldset');
  if (!field) throw new Error('Missing region selector');
  field.setPointerCapture = vi.fn();
  video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
  await act(async () => {
    field.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 80 }));
    field.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 200, clientY: 160 }));
    field.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 200, clientY: 160 }));
  });
  expect(field.parentElement?.querySelector('.border-2')).not.toBeNull();
  const original = {
    threadId,
    text: '原文字',
    contextAttachments: [
      { v: 1 as const, id: 'original-context', kind: 'thread' as const, threadId: 'context-thread', title: '原上下文' },
    ],
  };
  useChatStore.getState().setPendingChatInsert(original);
  await click('取消');
  expect(container.querySelector('fieldset')).toBeNull();
  expect(useChatStore.getState().pendingChatInsert).toEqual(original);
  expect(useChatStore.getState().messages).toEqual([]);
  await click('标记问题');
  expect(container.querySelector('fieldset')?.parentElement?.querySelector('.border-2')).toBeNull();
  await click('记到原输入框');
  const attachments = useChatStore.getState().pendingChatInsert?.contextAttachments;
  expect(attachments?.[0]).toEqual(original.contextAttachments[0]);
  expect(attachments?.[1]).toMatchObject({
    kind: 'project-screening',
    selections: [{ mediaRange: { startPts: 48000 } }],
  });
  const attachment = attachments?.[1];
  if (attachment?.kind !== 'project-screening') throw new Error('Missing screening chip');
  expect(attachment.selections[0].displayRegion).toBeUndefined();
  expect(attachment.selections[0].canvasRegion).toBeUndefined();
});

it.each(['这个镜头', '全片'])('cancel discards the %s target choice and reopens as a fresh moment', async (mode) => {
  await renderPlayer();
  await present(2);
  await click('标记问题');
  await click(mode);
  await click('取消');
  expect(useChatStore.getState().pendingChatInsert).toBeNull();
  await click('标记问题');
  expect(button('这一刻').getAttribute('aria-pressed')).toBe('true');
  await click('记到原输入框');
  const attachment = useChatStore.getState().pendingChatInsert?.contextAttachments?.[0];
  expect(attachment).toMatchObject({ kind: 'project-screening', selections: [{ target: { kind: 'moment' } }] });
});

it('clearing a selected region removes its visible box and its queued evidence together', async () => {
  await renderPlayer();
  await present(2);
  await click('标记问题');
  const field = container.querySelector<HTMLElement>('fieldset');
  if (!field) throw new Error('Missing region selector');
  field.setPointerCapture = vi.fn();
  video.getBoundingClientRect = () => new DOMRect(0, 0, 640, 360);
  await act(async () => {
    field.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 80 }));
    field.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 200, clientY: 160 }));
    field.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 200, clientY: 160 }));
  });
  expect(field.parentElement?.querySelector('.border-2')).not.toBeNull();
  await click('清除范围／框');
  expect(field.parentElement?.querySelector('.border-2')).toBeNull();
  await click('记到原输入框');
  const attachment = useChatStore.getState().pendingChatInsert?.contextAttachments?.[0];
  if (attachment?.kind !== 'project-screening') throw new Error('Missing screening chip');
  expect(attachment.selections[0].displayRegion).toBeUndefined();
});
