'use client';

import { createContext, type ReactNode, type RefObject, useContext, useEffect, useMemo } from 'react';

type Position = { seconds: number; paused: boolean };
const Context = createContext<Map<string, Position> | null>(null);

/** Thread-local viewport continuity only. A position is neither a media grant nor presented-frame evidence. */
export function ArtworkMediaViewportProvider({ children, scopeKey }: { children: ReactNode; scopeKey: number }) {
  // Retire the old visit's map without remounting the Chat below it. Old player
  // cleanup may still write its captured map; it cannot populate the new one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: this map belongs to one presentation visit.
  const positions = useMemo(() => new Map<string, Position>(), [scopeKey]);
  return <Context.Provider value={positions}>{children}</Context.Provider>;
}

export function useArtworkVideoPosition(
  videoRef: RefObject<HTMLVideoElement>,
  identity: string | undefined,
  src: string | null,
  seekTo: (seconds: number) => void,
  /** Set once someone asks this player for a specific place; the retained playhead then stays unused. */
  requested?: RefObject<boolean>,
) {
  const positions = useContext(Context);
  useEffect(() => {
    const video = videoRef.current;
    if (!positions || !identity || !src || !video) return;
    const saved = positions.get(identity);
    let restored = false;
    const restore = () => {
      if (restored || video.readyState < 1) return;
      restored = true;
      if (!saved || requested?.current) return;
      // The original seek owner revokes stale frame readiness; the new player must present its own frame.
      seekTo(saved.seconds);
      if (!saved.paused) void video.play().catch(() => {});
    };
    const remember = () => {
      if (video.readyState >= 1 && Number.isFinite(video.currentTime))
        positions.set(identity, { seconds: video.currentTime, paused: video.paused });
    };
    video.addEventListener('loadedmetadata', restore);
    for (const event of ['timeupdate', 'seeked', 'play', 'pause']) video.addEventListener(event, remember);
    restore();
    return () => {
      remember();
      video.removeEventListener('loadedmetadata', restore);
      for (const event of ['timeupdate', 'seeked', 'play', 'pause']) video.removeEventListener(event, remember);
    };
  }, [positions, identity, src, videoRef, seekTo, requested]);
}
