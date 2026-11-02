'use client';
import type { ImmutableMedia, MediaContextAttachment } from '@cat-cafe/shared';
import { useEffect, useState } from 'react';
import { readMediaAttachmentOwner } from './media-attachment-owner';
import { tickToBrowserTime } from './review-geometry';

/** Presentation metadata belongs to the exact attachment owner; it is neither a new opinion nor a snapshot store. */
export function useMediaAttachmentPreview(attachment: MediaContextAttachment) {
  const key = JSON.stringify({ ...attachment, selections: [] });
  const [read, setRead] = useState<{ key: string; media: ImmutableMedia }>();
  useEffect(() => {
    const reference = JSON.parse(key) as MediaContextAttachment;
    if (reference.mediaType !== 'video/mp4') return;
    let current = true;
    void readMediaAttachmentOwner(reference).then(
      ({ media }) => {
        if (current) setRead({ key, media });
      },
      () => {
        if (current) setRead(undefined);
      },
    );
    return () => {
      current = false;
    };
    // Comments and selection edits do not change the original owner's clock.
  }, [key]);
  return read?.key === key ? read.media : undefined;
}

export function selectionPreviewSeconds(
  selection: MediaContextAttachment['selections'][number]['selection'],
  media?: ImmutableMedia,
): number | null {
  if (selection.kind !== 'video-range' || media?.kind !== 'video' || selection.streamId !== media.streamId) return null;
  const tick = selection.frameRegion?.tick ?? selection.framePoint?.tick ?? selection.startTick;
  if (
    selection.startTick < media.startTick ||
    selection.endTick > media.startTick + media.durationTicks ||
    tick < selection.startTick ||
    tick > selection.endTick
  )
    return null;
  return tickToBrowserTime(tick, media);
}

export function selectionPreviewTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
