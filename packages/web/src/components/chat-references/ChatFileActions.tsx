'use client';
import type { ChatFileReference } from '@cat-cafe/shared';
import { type RefObject, useRef } from 'react';
import { FileActions } from '../content-review/FileActions';
import { useActionSurfaceRef } from '../message-v2/message-action-ownership';

/** A path label projects the same server-authorized file operations as the reader. */
export function ChatFileActions({
  target,
  inline = false,
  hideTrigger = false,
  anchorRef,
}: {
  target: ChatFileReference;
  inline?: boolean;
  hideTrigger?: boolean;
  anchorRef?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const owned = useActionSurfaceRef<HTMLSpanElement>(undefined, undefined, ref);
  return (
    <span ref={owned} className="relative inline-flex text-xs">
      <FileActions
        source={{ kind: 'workspace', worktreeId: target.worktreeId, path: target.path }}
        filename={target.absolutePath.split('/').filter(Boolean).at(-1) ?? '/'}
        openOnHover
        contextRef={anchorRef ?? ref}
        hideTrigger={hideTrigger && !inline}
      />
    </span>
  );
}
