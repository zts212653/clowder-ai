'use client';

import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { LongFormReader } from '@/components/content-overflow';
import type { ChatMessage } from '@/stores/chat-types';
import type { QueueEntry } from '@/stores/chatStore';
import { AvatarImageWithFallback } from './AvatarImageWithFallback';
import { QueueEntryActions } from './QueueEntryActions';
import { RoutingWarningNotice } from './RoutingWarningNotice';

const SOURCE_CATEGORY_LABEL: Record<string, string> = {
  ci: 'CI',
  review: 'Review',
  conflict: 'Conflict',
  issue: 'Issue',
  scheduled: 'Scheduled',
  a2a: 'A2A',
  continuation: 'Continuation',
  freshness: 'Freshness',
};

function exactMessageById(messages: readonly ChatMessage[], messageId: string): ChatMessage | undefined {
  const matches = messages.filter((message) => message.id === messageId);
  return matches.length === 1 ? matches[0] : undefined;
}

/** Queue UI reads delivery directly from the canonical source refs already present in Chat History. */
export function readTargetIdsFromHistory(sourceMessageId: string, messages: readonly ChatMessage[]): string[] {
  const source = exactMessageById(messages, sourceMessageId);
  const refs = source?.lifecycle?.dispatchRefs ?? [];
  return refs.flatMap((ref) => {
    const status = exactMessageById(messages, ref.statusMessageId)?.lifecycle;
    const targetReadSource =
      status?.kind === 'response' &&
      status.targetId === ref.targetId &&
      status.inputMessageIds.includes(sourceMessageId);
    return targetReadSource ? [ref.targetId] : [];
  });
}

function QueueTarget({ catId, label, avatar, read }: { catId: string; label: string; avatar?: string; read: boolean }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap" data-queue-target-row={catId}>
      <AvatarImageWithFallback src={avatar} alt="" className="h-5 w-5 rounded-full object-cover" />
      <span className="text-xs font-medium text-cafe-secondary">{label}</span>
      {read && <span className="text-micro text-cafe-muted">（已读）</span>}
    </span>
  );
}

export interface QueueEntryRowProps {
  entry: QueueEntry;
  index: number;
  imageCount: number;
  ownerName: string;
  ownerAvatar?: string;
  readTargetIds: readonly string[];
  resolveCatName: (catId: string) => string;
  resolveCatAvatar: (catId: string) => string | undefined;
  onRemove: (id: string) => void;
  onRecallEdit: (id: string) => void;
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
  imageCount,
  ownerName,
  ownerAvatar,
  readTargetIds,
  resolveCatName,
  resolveCatAvatar,
  onRemove,
  onRecallEdit,
  onSteer,
  dragHandleProps,
}: QueueEntryRowProps & { dragHandleProps?: Record<string, unknown> }) {
  const isAgent = entry.from.kind === 'agent';
  const canRecallEdit = entry.from.kind === 'user' && Boolean(entry.messageId);
  const isUrgent = entry.priority === 'urgent';
  const categoryLabel = entry.sourceCategory ? SOURCE_CATEGORY_LABEL[entry.sourceCategory] : null;
  const rowToneClass = isAgent ? 'bg-[var(--color-cocreator-surface)]' : '';

  const readTargets = new Set(readTargetIds);
  const targetIds = [...new Set([...entry.targetCats, ...readTargets])];
  const sourceLabel =
    entry.from.kind === 'agent'
      ? resolveCatName(entry.from.catId)
      : entry.from.kind === 'external'
        ? (entry.from.sender?.name ?? 'Connector')
        : entry.from.kind === 'plugin'
          ? 'Plugin'
          : entry.from.kind === 'system'
            ? entry.from.service
            : ownerName;
  const sourceAvatar =
    entry.from.kind === 'agent'
      ? resolveCatAvatar(entry.from.catId)
      : entry.from.kind === 'user'
        ? ownerAvatar
        : undefined;

  return (
    <div className={`flex items-start gap-2 px-3 py-2 rounded-lg ${rowToneClass}`}>
      <button
        className="p-0.5 mt-1 text-cafe-muted hover:text-cafe-secondary cursor-grab active:cursor-grabbing shrink-0 touch-none"
        aria-label="Drag to reorder"
        {...dragHandleProps}
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path d="M7 2a2 2 0 10.001 4.001A2 2 0 007 2zm0 6a2 2 0 10.001 4.001A2 2 0 007 8zm0 6a2 2 0 10.001 4.001A2 2 0 007 14zm6-8a2 2 0 10-.001-4.001A2 2 0 0013 6zm0 2a2 2 0 10.001 4.001A2 2 0 0013 8zm0 6a2 2 0 10.001 4.001A2 2 0 0013 14z" />
        </svg>
      </button>

      <span className="text-xs text-cafe-muted w-5 text-center shrink-0 relative mt-1">
        {isUrgent && <span className="absolute -left-1 top-0.5 w-1.5 h-1.5 rounded-full bg-conn-red-text" />}
        {index + 1}
      </span>

      <div className="flex-1 min-w-0">
        <LongFormReader
          title={`排队消息 · ${sourceLabel}`}
          summary={entry.content}
          accessibleSummary={`排队消息，来源 ${sourceLabel}。完整内容请使用查看全文按钮。`}
          content={entry.content}
          format="markdown"
          density="compact"
        />
        <RoutingWarningNotice warnings={entry.routingWarnings} />
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1" data-testid={`queue-route-${entry.id}`}>
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <AvatarImageWithFallback src={sourceAvatar} alt="" className="h-5 w-5 rounded-full object-cover" />
            <span
              className={`text-xs ${isAgent ? 'text-[var(--color-cocreator-primary)] font-medium' : isUrgent ? 'text-conn-red-text' : 'text-cafe-muted'}`}
            >
              {sourceLabel}
            </span>
          </span>
          <span className="text-xs text-cafe-muted" aria-hidden="true">
            →
          </span>
          {targetIds.length > 0 ? (
            <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
              {targetIds.map((catId) => {
                return (
                  <QueueTarget
                    key={catId}
                    catId={catId}
                    label={resolveCatName(catId)}
                    avatar={resolveCatAvatar(catId)}
                    read={readTargets.has(catId)}
                  />
                );
              })}
            </span>
          ) : (
            <span className="text-xs text-cafe-muted">待选择成员</span>
          )}
          {categoryLabel && isAgent && (
            <span
              className="text-micro rounded px-1 py-px font-medium text-[var(--color-cocreator-primary)]"
              style={{ backgroundColor: 'color-mix(in oklch, var(--color-cocreator-primary) 15%, transparent)' }}
            >
              {categoryLabel}
            </span>
          )}
          {isAgent && entry.autoExecute && (
            <span
              className="text-micro px-1 py-px rounded text-[var(--color-cocreator-primary)] font-medium"
              style={{ backgroundColor: 'color-mix(in oklch, var(--color-cocreator-primary) 15%, transparent)' }}
            >
              自动
            </span>
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

      <div className="flex items-center gap-1 shrink-0 mt-1">
        <QueueEntryActions entry={entry} onSteer={onSteer} />
        {canRecallEdit && (
          <button
            type="button"
            onClick={() => onRecallEdit(entry.id)}
            className="p-1 text-cafe-muted hover:text-cafe-primary hover:bg-cafe-surface rounded-full transition-colors"
            title="撤回并重新编辑"
            aria-label="撤回并重新编辑"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <title>撤回并重新编辑</title>
              <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
            </svg>
          </button>
        )}
        <button
          type="button"
          onClick={() => onRemove(entry.id)}
          className="p-1 text-cafe-muted hover:text-conn-red-text transition-colors"
          title="停止后续处理（保留原消息）"
          aria-label="停止后续处理"
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
    </div>
  );
}
