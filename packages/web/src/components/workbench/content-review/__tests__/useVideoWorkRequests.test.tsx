import type { ArtifactReviewAnchor, ImmutableMedia } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useVideoWorkRequests } from '../useVideoWorkRequests';

const media = {
  kind: 'video',
  width: 100,
  height: 100,
  codedWidth: 100,
  codedHeight: 100,
  rotation: 0,
  pixelAspectRatio: { numerator: 1, denominator: 1 },
  streamId: 'actual',
  streamIndex: 0,
  timebase: { numerator: 1, denominator: 15360 },
  startTick: 0,
  durationTicks: 1536000,
  containerStartSeconds: 0,
} satisfies ImmutableMedia;

it('accepted marks await a decoded frame once, while hiding or revoked selection cancels that pending intent', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const element = document.createElement('div'),
    root = createRoot(element);
  const selected = vi.fn(),
    seconds = vi.fn(),
    mode = vi.fn(),
    seekTo = vi.fn(),
    pause = vi.fn();
  const video = { current: { pause } as unknown as HTMLVideoElement };
  function Probe({
    request,
    frameTime,
    visible = true,
    selectable = true,
  }: {
    request: number;
    frameTime: number | null;
    visible?: boolean;
    selectable?: boolean;
  }) {
    const queued = useVideoWorkRequests({
      video,
      media,
      frameTime,
      visible,
      selectable,
      markRequest: request,
      playbackHidden: false,
      onSelect: selected,
      setMode: mode,
      setSeconds: seconds,
      seekTo,
    });
    return <output>{queued ? 'queued' : 'idle'}</output>;
  }
  const render = async (request: number, frameTime: number | null, visible = true, selectable = true) => {
    await act(async () => root.render(<Probe {...{ request, frameTime, visible, selectable }} />));
  };
  try {
    await render(0, null);
    await render(1, null);
    expect(element.textContent).toBe('queued');
    expect(selected).not.toHaveBeenCalled();
    await render(1, 2);
    expect(selected).toHaveBeenCalledExactlyOnceWith({
      kind: 'video-range',
      streamId: 'actual',
      startTick: 30720,
      endTick: 30721,
    });
    await render(1, 3);
    expect(selected).toHaveBeenCalledTimes(1);
    await render(2, null);
    await render(2, null, false);
    await render(2, 5);
    expect(selected).toHaveBeenCalledTimes(1);
    await render(3, null);
    await render(3, null, true, false);
    await render(3, 8);
    expect(selected).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
});

it('a paragraph request uses its frozen range without a decoder frame and cannot revive after refusal or remount', async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement('div')),
    select = vi.fn(),
    pause = vi.fn();
  const anchor: ArtifactReviewAnchor = {
    kind: 'video-range',
    streamId: media.streamId,
    startTick: 15360,
    endTick: 30720,
    storyEvidence: { metadataRevision: 3, paragraphId: 'line-1', quote: '  原文\n第二行' },
  };
  const video = { current: { pause } as unknown as HTMLVideoElement };
  function Probe({
    id,
    visible = true,
    selectable = true,
    hidden = false,
  }: {
    id?: number;
    visible?: boolean;
    selectable?: boolean;
    hidden?: boolean;
  }) {
    useVideoWorkRequests({
      video,
      media,
      frameTime: null,
      visible,
      selectable,
      playbackHidden: hidden,
      selectionRequest: id === undefined ? undefined : { id, anchor },
      onSelect: select,
      setMode: vi.fn(),
      setSeconds: vi.fn(),
      seekTo: vi.fn(),
    });
    return null;
  }
  const render = async (props: Parameters<typeof Probe>[0]) => {
    await act(async () => root.render(<Probe {...props} />));
  };
  try {
    await render({});
    await render({ id: 1 });
    expect(select).toHaveBeenCalledExactlyOnceWith(anchor);
    await render({ id: 1 });
    await render({ id: 2, visible: false });
    await render({ id: 2 });
    await render({ id: 3, selectable: false });
    await render({ id: 3 });
    await render({ id: 4, hidden: true });
    await render({ id: 4 });
    expect(select).toHaveBeenCalledTimes(1);
    await act(async () => root.render(null));
    await render({ id: 4 });
    expect(select).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
});
