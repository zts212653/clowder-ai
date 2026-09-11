'use client';

import type { QueueEntry } from '@/stores/chat-types';

interface QueueEntryActionsProps {
  entry: QueueEntry;
  onSteer: (entryId: string) => void;
}

export function QueueEntryActions({ entry, onSteer }: QueueEntryActionsProps) {
  return (
    <button
      type="button"
      data-testid={`steer-${entry.id}`}
      onClick={() => onSteer(entry.id)}
      className="text-xs px-2.5 py-1 rounded-full border border-cafe text-cafe-secondary hover:bg-cafe-surface transition-colors"
      aria-label="Steer"
    >
      Steer
    </button>
  );
}
