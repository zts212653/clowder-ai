'use client';

import { useMemo } from 'react';
import { ThreadChatLink } from '@/components/workspace/ThreadChatLink';
import { TrajectoryPanel } from '@/components/workspace/trajectory/TrajectoryPanel';
import { F307OwnerUnavailable } from './F307OwnerUnavailable';
import { resolveAgentRunTarget } from './real-surface-adapters';
import { useWorkspaceSurfaceVisibility } from './WorkspaceSurfaceVisibility';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

export function AgentRunOwnerSurface({ surface }: { surface: WorkspaceSurfaceDescriptor }) {
  const visible = useWorkspaceSurfaceVisibility();
  const { owner, key } = surface.ownerStateRef;
  const resultOwner = surface.resultTargetRef?.owner;
  const resultKey = surface.resultTargetRef?.key;
  // Layout metadata can allocate another descriptor for the same owner. Only a changed
  // invocation/source coordinate constitutes a new selection for the controlled panel.
  const target = useMemo(
    () =>
      resolveAgentRunTarget({
        ownerStateRef: { owner, key },
        ...(resultOwner !== undefined && resultKey !== undefined
          ? { resultTargetRef: { owner: resultOwner, key: resultKey } }
          : {}),
      }),
    [owner, key, resultOwner, resultKey],
  );
  // Keep the restore descriptor, not its transcript reader. Reveal remounts the panel
  // and revalidates canonical permissions before any detail/source actions appear.
  if (!visible) return null;
  if (!target?.threadId)
    return <F307OwnerUnavailable message="Agent Run descriptor 没有合法的 F299 invocation 引用。" />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 justify-end border-b border-cafe-subtle px-3 py-2">
        <ThreadChatLink threadId={target.threadId} />
      </div>
      <div className="min-h-0 flex-1">
        <TrajectoryPanel threadId={target.threadId} targetOverride={target} />
      </div>
    </div>
  );
}
