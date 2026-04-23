'use client';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { QueueEntry } from '@/stores/chatStore';

const SOURCE_CATEGORY_LABEL: Record<string, string> = {
  ci: 'CI',
  review: 'Review',
  conflict: 'Conflict',
  scheduled: 'Scheduled',
  a2a: 'A2A',
};

export interface QueueEntryRowProps {
  entry: QueueEntry;
  index: number;
  isPaused: boolean;
  imageCount: number;
  ownerName: string;
  onRemove: (id: string) => void;
  onSteer: (id: string) => void;
}

export function SortableQueueEntryRow(props: QueueEntryRowProps) {
  const { entry } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: entry.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };

  return (
    <div ref={setNodeRef} style={style}>
      <QueueEntryRow {...props} dragHandleProps={{ ...attributes, ...listeners }} />
    </div>
  );
}

function QueueEntryRow({
  entry,
  index,
  isPaused,
  imageCount,
  ownerName,
  onRemove,
  onSteer,
  dragHandleProps,
}: QueueEntryRowProps & { dragHandleProps?: Record<string, unknown> }) {
  const isAgent = entry.source === 'agent';
  const isUrgent = entry.priority === 'urgent';
  const categoryLabel = entry.sourceCategory ? SOURCE_CATEGORY_LABEL[entry.sourceCategory] : null;

  const sourceLabel = isAgent
    ? `${entry.callerCatId ?? '猫猫'} → ${entry.targetCats[0] ?? '猫猫'}`
    : entry.source === 'connector'
      ? 'Connector'
      : ownerName;

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 border-b last:border-b-0 ${
        isPaused ? 'border-amber-100' : 'border-[#9B7EBD]/10'
      } ${isAgent ? 'bg-[#F3EEFA]' : ''} ${isUrgent ? 'bg-red-50/40' : ''}`}
    >
      {/* Drag handle */}
      <button
        className="p-0.5 text-cafe-muted hover:text-cafe-secondary cursor-grab active:cursor-grabbing shrink-0 touch-none"
        aria-label="Drag to reorder"
        {...dragHandleProps}
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
          <path d="M7 2a2 2 0 10.001 4.001A2 2 0 007 2zm0 6a2 2 0 10.001 4.001A2 2 0 007 8zm0 6a2 2 0 10.001 4.001A2 2 0 007 14zm6-8a2 2 0 10-.001-4.001A2 2 0 0013 6zm0 2a2 2 0 10.001 4.001A2 2 0 0013 8zm0 6a2 2 0 10.001 4.001A2 2 0 0013 14z" />
        </svg>
      </button>

      {/* Number + urgent indicator */}
      <span className="text-xs text-cafe-muted w-5 text-center shrink-0 relative">
        {isUrgent && <span className="absolute -left-1 top-0.5 w-1.5 h-1.5 rounded-full bg-red-500" />}
        {index + 1}
      </span>

      {/* Content preview */}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-cafe-secondary truncate">{entry.content}</p>
        <div className="flex items-center gap-1 mt-0.5">
          {isAgent ? (
            <svg className="w-2.5 h-2.5 text-[#9B7EBD]" viewBox="0 0 24 24" fill="currentColor">
              <path d="M4.5 11.5c-.28 0-.5-.22-.5-.5 0-1.93.76-3.74 2.13-5.1C7.5 4.52 9.31 3.76 11.24 3.76c.28 0 .5.22.5.5s-.22.5-.5.5c-1.66 0-3.22.65-4.4 1.82A6.18 6.18 0 005.02 11c0 .28-.22.5-.5.5zM8.02 20.25a1.25 1.25 0 01-1.18-1.63l1.12-3.36A4.01 4.01 0 014.1 11.5c0-2.2 1.79-3.99 3.99-3.99h7.82c2.2 0 3.99 1.79 3.99 3.99a4.01 4.01 0 01-3.86 3.76l1.12 3.36a1.25 1.25 0 01-1.18 1.63H8.02z" />
            </svg>
          ) : isUrgent ? (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500" />
          ) : (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#9B7EBD]" />
          )}
          <span
            className={`text-xs ${isAgent ? 'text-[#9B7EBD] font-medium' : isUrgent ? 'text-red-600' : 'text-cafe-muted'}`}
          >
            {sourceLabel}
          </span>
          {categoryLabel && (
            <span
              className={`text-[9px] px-1 py-px rounded font-medium ${
                isUrgent ? 'bg-red-100 text-red-600' : 'bg-[#9B7EBD]/15 text-[#9B7EBD]'
              }`}
            >
              {categoryLabel}
            </span>
          )}
          {isAgent && entry.autoExecute && (
            <span className="text-[9px] px-1 py-px rounded bg-[#9B7EBD]/15 text-[#9B7EBD] font-medium">自动</span>
          )}
          {imageCount > 0 && (
            <span className="flex items-center gap-0.5 text-xs text-cafe-muted ml-1">
              <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M4 3a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V5a2 2 0 00-2-2H4zm12 12H4l4-8 3 6 2-4 3 6z"
                  clipRule="evenodd"
                />
              </svg>
              {imageCount}
            </span>
          )}
        </div>
      </div>

      {/* Steer button */}
      <button
        type="button"
        data-testid={`steer-${entry.id}`}
        onClick={() => onSteer(entry.id)}
        className="text-xs px-3 py-1 rounded-full bg-[#9B7EBD] text-white hover:bg-[#8B6FAE] transition-colors shrink-0"
        aria-label="Steer"
      >
        Steer
      </button>

      {/* Remove button */}
      <button
        onClick={() => onRemove(entry.id)}
        className="p-1 text-cafe-muted hover:text-red-500 transition-colors shrink-0"
        title="撤回"
        aria-label="撤回"
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>
    </div>
  );
}
