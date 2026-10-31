'use client';

import { useCatData } from '@/hooks/useCatData';
import type { QueueEntry } from '@/stores/chat-types';
import { QueueTargetRetryButton } from './QueueTargetRetryButton';

interface QueueEntryActionsProps {
  entry: QueueEntry;
  onSteer: (entryId: string) => void;
}

export function QueueEntryActions({ entry, onSteer }: QueueEntryActionsProps) {
  const { getCatById } = useCatData({ fetch: false });
  return (
    <>
      {entry.recoveryActions?.flatMap((action) =>
        action.kind === 'retry_target' || action.kind === 'repeat_target'
          ? [
              <QueueTargetRetryButton
                key={action.id}
                entry={entry}
                action={action}
                label={`重试 ${getCatById(action.targetCatId)?.displayName ?? action.targetCatId}`}
              />,
            ]
          : [],
      )}
      <button
        type="button"
        data-testid={`steer-${entry.id}`}
        onClick={() => onSteer(entry.id)}
        className="text-xs px-2.5 py-1 rounded-full border border-cafe text-cafe-secondary hover:bg-cafe-surface transition-colors"
        aria-label="处理这条排队消息"
      >
        处理这条
      </button>
    </>
  );
}
