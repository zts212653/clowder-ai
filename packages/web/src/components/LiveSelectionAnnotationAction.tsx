'use client';

import { type ReactNode, useEffect, useState } from 'react';
import { SelectionAnnotationAction } from './SelectionAnnotationAction';
import type { FloatingSelectionPosition } from './workspace/selection-action-position';

interface LiveSelectionTarget {
  text: string;
  position: FloatingSelectionPosition;
}

interface LiveSelectionAnnotationActionProps<T extends LiveSelectionTarget> {
  action: T | null;
  resetKey: string | null;
  positionMode: 'fixed' | 'absolute';
  actionTestId: string;
  onSave: (action: T, comment: string) => void;
  onForward?: (action: T, comment: string) => void;
  canForward?: (action: T) => boolean;
  triggerContent?: ReactNode;
  triggerClassName?: string;
}

/**
 * Transfers one clicked live selection into short-lived editor custody. Browser
 * focus may clear the discoverable Selection without revoking this snapshot.
 */
export function LiveSelectionAnnotationAction<T extends LiveSelectionTarget>({
  action,
  resetKey,
  positionMode,
  actionTestId,
  onSave,
  onForward,
  canForward,
  triggerContent,
  triggerClassName,
}: LiveSelectionAnnotationActionProps<T>) {
  const [snapshot, setSnapshot] = useState<T | null>(null);

  useEffect(() => {
    void resetKey;
    setSnapshot(null);
  }, [resetKey]);

  const ownedAction = snapshot ?? action;
  if (!ownedAction) return null;

  return (
    <SelectionAnnotationAction
      selectedText={ownedAction.text}
      position={ownedAction.position}
      positionMode={positionMode}
      actionTestId={actionTestId}
      onOpen={() => setSnapshot(ownedAction)}
      onClose={() => setSnapshot(null)}
      onSave={(comment) => onSave(ownedAction, comment)}
      triggerContent={triggerContent}
      triggerClassName={triggerClassName}
      {...(onForward && (canForward?.(ownedAction) ?? true)
        ? { onForward: (comment: string) => onForward(ownedAction, comment) }
        : {})}
    />
  );
}
