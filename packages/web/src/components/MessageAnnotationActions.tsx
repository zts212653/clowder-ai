'use client';

import type { QuoteContextAttachment } from '@cat-cafe/shared';
import { useState } from 'react';
import type { ContextAnnotationMarker } from './context-annotation-markers';
import { SelectionAnnotationAction } from './SelectionAnnotationAction';

/** Visible markers locate drafts; opening one acquires the editor independently of scrolling. */
export function MessageAnnotationActions({
  markers,
  onSave,
  onDelete,
}: {
  markers: readonly ContextAnnotationMarker[];
  onSave: (attachment: QuoteContextAttachment, comment: string) => void | boolean;
  onDelete: (attachment: QuoteContextAttachment) => void;
}) {
  const [opened, setOpened] = useState<ContextAnnotationMarker | null>(null);
  const surfaces = markers.map((marker) => (opened && marker.attachment.id === opened.attachment.id ? opened : marker));
  if (opened && !markers.some((marker) => marker.attachment.id === opened.attachment.id)) surfaces.push(opened);

  return surfaces.map((marker) => (
    <SelectionAnnotationAction
      key={marker.attachment.id}
      selectedText={marker.attachment.text}
      initialComment={marker.attachment.comment}
      position={marker.position}
      positionMode="fixed"
      actionTestId={`context-annotation-marker-${marker.attachment.id}`}
      triggerContent={marker.number}
      triggerClassName="fixed z-40 grid h-7 w-7 place-items-center rounded-full border-2 border-[var(--cafe-surface)] bg-cafe-accent text-xs font-bold text-[var(--cafe-surface)] shadow-lg transition-transform hover:scale-110"
      onOpen={() => setOpened(marker)}
      onClose={() => setOpened((current) => (current?.attachment.id === marker.attachment.id ? null : current))}
      onSave={(comment) => onSave(marker.attachment, comment)}
      onDelete={() => onDelete(marker.attachment)}
    />
  ));
}
