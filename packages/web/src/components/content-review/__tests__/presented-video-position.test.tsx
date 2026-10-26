import { act, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ArtworkLightboxProvider } from '../ArtworkLightboxScope';
import { usePresentedVideoFrame } from '../usePresentedVideoFrame';

it('retains the same source playhead across presentation remounts, while requiring fresh frame evidence and isolating revisions', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let frameTime: number | null = null;
  function Player({ identity }: { identity: string }) {
    const video = useRef<HTMLVideoElement>(null);
    frameTime = usePresentedVideoFrame(video, '/original-media', identity).frameTime;
    // biome-ignore lint/a11y/useMediaCaption: This metadata-only test player never loads media.
    return <video ref={video} />;
  }
  const render = (key: string, identity = 'review:revision-1:stream-0', threadId = 'original-thread') =>
    act(async () =>
      root.render(
        <ArtworkLightboxProvider threadId={threadId}>
          <Player key={key} identity={identity} />
        </ArtworkLightboxProvider>,
      ),
    );
  try {
    await render('floating');
    const original = host.querySelector('video');
    if (!original) throw new Error('original player missing');
    Object.defineProperty(original, 'readyState', { value: 4 });
    original.currentTime = 82;
    await act(async () => original.dispatchEvent(new Event('timeupdate')));
    await render('work-mode');
    const next = host.querySelector('video');
    if (!next) throw new Error('work-mode player missing');
    const pause = vi.spyOn(next, 'pause').mockImplementation(() => {});
    Object.defineProperty(next, 'readyState', { value: 1 });
    await act(async () => next.dispatchEvent(new Event('loadedmetadata')));
    expect(next).not.toBe(original);
    expect(next.currentTime).toBe(82);
    expect(pause).toHaveBeenCalled();
    expect(frameTime).toBeNull(); // A retained playhead is never a presented-frame receipt.
    await render('new-version', 'review:revision-2:stream-0');
    const replacement = host.querySelector('video');
    if (!replacement) throw new Error('new-version player missing');
    Object.defineProperty(replacement, 'readyState', { value: 1 });
    await act(async () => replacement.dispatchEvent(new Event('loadedmetadata')));
    expect(replacement.currentTime).toBe(0);
    expect(frameTime).toBeNull();

    // A source identity may appear in another Chat, but its old playhead is thread-local.
    await render('other-thread', 'review:revision-1:stream-0', 'thread-b');
    const otherThread = host.querySelector('video');
    if (!otherThread) throw new Error('other thread player missing');
    Object.defineProperty(otherThread, 'readyState', { value: 1 });
    await act(async () => otherThread.dispatchEvent(new Event('loadedmetadata')));
    expect(otherThread.currentTime).toBe(0);
    expect(frameTime).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  }
});

it('lets an explicit place request issued before metadata win over the retained playhead', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  // Like opening a composer chip: the new surface asks for that place's frame while its player is still loading.
  function Player({ place }: { place?: number }) {
    const video = useRef<HTMLVideoElement>(null);
    const { seekTo } = usePresentedVideoFrame(video, '/original-media', 'review:revision-1:stream-0');
    useEffect(() => {
      if (place !== undefined) seekTo(place);
    }, [place, seekTo]);
    // biome-ignore lint/a11y/useMediaCaption: This metadata-only test player never loads media.
    return <video ref={video} />;
  }
  const render = (key: string, place?: number) =>
    act(async () =>
      root.render(
        <ArtworkLightboxProvider threadId="original-thread">
          <Player key={key} place={place} />
        </ArtworkLightboxProvider>,
      ),
    );
  try {
    await render('first');
    const first = host.querySelector('video');
    if (!first) throw new Error('first player missing');
    Object.defineProperty(first, 'readyState', { value: 4 });
    first.currentTime = 82;
    await act(async () => first.dispatchEvent(new Event('timeupdate')));

    await render('place-before-metadata', 6);
    const placed = host.querySelector('video');
    if (!placed) throw new Error('placed player missing');
    vi.spyOn(placed, 'pause').mockImplementation(() => {});
    expect(placed.currentTime).toBe(6);
    Object.defineProperty(placed, 'readyState', { value: 1 });
    await act(async () => placed.dispatchEvent(new Event('loadedmetadata')));
    expect(placed.currentTime).toBe(6);

    // Without an explicit request, a later remount still continues from where the person left off.
    await render('plain-remount');
    const plain = host.querySelector('video');
    if (!plain) throw new Error('plain player missing');
    vi.spyOn(plain, 'pause').mockImplementation(() => {});
    Object.defineProperty(plain, 'readyState', { value: 1 });
    await act(async () => plain.dispatchEvent(new Event('loadedmetadata')));
    expect(plain.currentTime).toBe(6);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  }
});
