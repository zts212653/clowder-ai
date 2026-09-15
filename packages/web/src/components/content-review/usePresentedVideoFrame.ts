'use client';
import { type RefObject, useCallback, useEffect, useState } from 'react';

type PresentedFrame = { mediaTime: number; observedPlayhead: number };
function matchesPosition(frame: PresentedFrame | null, position: number) {
  return frame?.observedPlayhead === position || frame?.mediaTime === position;
}

/** Seeking is a readiness signal, not a revocation of frame evidence that already belongs to that seek. */
export function usePresentedVideoFrame(videoRef: RefObject<HTMLVideoElement>, src: string | null) {
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
  const seekTo = useCallback(
    (position: number) => {
      const video = videoRef.current;
      if (!video) return;
      video.pause();
      if (video.currentTime === position) return;
      setSeeking(true);
      setFrame((current) => (matchesPosition(current, position) ? current : null));
      video.currentTime = position;
    },
    [videoRef],
  );
  return { frameTime: seeking ? null : (frame?.mediaTime ?? null), onSeeking, onSeeked, seekTo };
}
