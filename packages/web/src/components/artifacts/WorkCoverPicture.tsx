'use client';
import { useState } from 'react';
import { COVER_CARD_RATIO, coverFit } from './work-cover-client';

/**
 * One adopted picture inside the 16:10 cover. It fills the card only when at most a tenth is cropped;
 * otherwise the whole picture sits over a blurred, darkened copy of itself so words on it are never cut.
 */
export function WorkCoverPicture({
  src,
  onError,
  onSize,
}: {
  src: string;
  onError?: () => void;
  onSize?: (size: { width: number; height: number }) => void;
}) {
  const [fit, setFit] = useState<{ src: string; value: 'fill' | 'contain' }>();
  const current = fit?.src === src ? fit.value : undefined;
  return (
    <span className="work-cover-picture" data-cover-fit={current ?? 'pending'}>
      {current === 'contain' && (
        // biome-ignore lint/performance/noImgElement: the same authenticated cover bytes as the picture itself.
        <img className="work-cover-picture-backdrop" src={src} alt="" aria-hidden="true" />
      )}
      {/* biome-ignore lint/performance/noImgElement: exact adopted cover revision, with fallback to a real frame. */}
      <img
        className="work-cover-picture-main"
        src={src}
        alt=""
        onLoad={(event) => {
          const image = event.currentTarget;
          const box = image.parentElement?.getBoundingClientRect();
          const card = box && box.width > 0 && box.height > 0 ? box.width / box.height : COVER_CARD_RATIO;
          setFit({ src, value: coverFit(image.naturalWidth, image.naturalHeight, card) });
          onSize?.({ width: image.naturalWidth, height: image.naturalHeight });
        }}
        onError={onError}
      />
    </span>
  );
}
