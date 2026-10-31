'use client';
import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { useArtworkVideoPosition } from './ArtworkMediaViewport';

type PresentedFrame = { mediaTime: number; observedPlayhead: number };
function matchesPosition(frame: PresentedFrame | null, position: number) {
  return frame?.observedPlayhead === position || frame?.mediaTime === position;
}

/** Seeking is a readiness signal, not a revocation of frame evidence that already belongs to that seek. */
export function usePresentedVideoFrame(videoRef: RefObject<HTMLVideoElement>, src: string | null, identity?: string) {
  const [frame, setFrame] = useState<PresentedFrame | null>(null);
  const [seeking, setSeeking] = useState(false);
  useEffect(() => {
    setFrame(null);
    setSeeking(false);
    const video = videoRef.current;
    if (!src || !video?.requestVideoFrameCallback) return;
    let callback = 0,
      active = true;
    const capture: VideoFrameRequestCallback = (_now, metadata) => {
      if (!active) return;
      setFrame({ mediaTime: metadata.mediaTime, observedPlayhead: video.currentTime });
      setSeeking(video.seeking);
      callback = video.requestVideoFrameCallback(capture);
    };
    callback = video.requestVideoFrameCallback(capture);
    return () => {
      active = false;
      video.cancelVideoFrameCallback(callback);
    };
  }, [src, videoRef]);

  const onSeeking = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const position = video.currentTime;
    setSeeking(video.seeking);
    // Chrome can deliver the new frame callback before this queued seeking event.
    setFrame((current) => (matchesPosition(current, position) ? current : null));
  }, [videoRef]);
  const onSeeked = useCallback(() => {
    const video = videoRef.current;
    if (video) setSeeking(video.seeking);
  }, [videoRef]);
  const place = useCallback(
    (position: number, options?: { pause?: boolean }) => {
      const video = videoRef.current;
      if (!video) return;
      if (options?.pause !== false) video.pause();
      if (video.currentTime === position) return;
      setSeeking(true);
      setFrame((current) => (matchesPosition(current, position) ? current : null));
      video.currentTime = position;
    },
    [videoRef],
  );
  // A place, chapter or discussion the person asked for outranks where this source was last left.
  const requested = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each loaded source starts without a request.
  useEffect(() => {
    requested.current = false;
  }, [src, identity]);
  const seekTo = useCallback(
    (position: number, options?: { pause?: boolean }) => {
      requested.current = true;
      place(position, options);
    },
    [place],
  );
  useArtworkVideoPosition(videoRef, identity, src, place, requested);
  return { frameTime: seeking ? null : (frame?.mediaTime ?? null), onSeeking, onSeeked, seekTo };
}
