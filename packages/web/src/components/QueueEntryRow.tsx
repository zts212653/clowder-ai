'use client';

import type { FreshnessCarrierCapability, QueueReminderAttempt } from '@cat-cafe/shared';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { LongFormReader } from '@/components/content-overflow';
import type { QueueEntry } from '@/stores/chatStore';
import {
  authorIntentLabel,
  carrierCapabilityLabel,
  classifyFreshnessCarrierSupport,
  unsupportedCarrierCopy,
} from './message-disposition-presentation';
import { UNSETTLED_SEEN_LABEL } from './queue-receipt-projection';

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

const TARGET_STATE_LABEL = {
  queued: '未读 · 排队中',
  notified: '已提醒 · 尚未读取',
  awakened: '已唤醒，但关联回合已结束；尚未读取消息正文',
  seen: UNSETTLED_SEEN_LABEL,
  failed: '处理失败 · 已回队列',
  steering: 'Steer 中',
  withdrawn: '已撤出待处理 · 历史保留',
  handled: '已处理',
} as const;

const REMINDER_STATE_LABEL = {
  requested: '提醒已请求',
  delivered: '提醒已送达 · 尚未读取',
  seen: '提醒后已读取',
  missed: '提醒未赶上本轮',
} as const;

function queueTargetStateLabel(entry: QueueEntry, catId: string, state: keyof typeof TARGET_STATE_LABEL): string {
  if (state !== 'handled') return TARGET_STATE_LABEL[state];
  const disposition = entry.queueReceipt?.targets.find((target) => target.catId === catId)?.outcome?.disposition;
  if (disposition === 'responded') return '已由回复明确处理';
  if (disposition === 'completed_with_turn') return '已随本轮完成';
  return '已处理 · 无可回溯证据';
}

function latestReminderForTarget(entry: QueueEntry, catId: string) {
  return (entry.queueReceipt?.reminderAttempts ?? []).reduce<QueueReminderAttempt | undefined>(
    (latest, attempt) =>
      attempt.targetCatId === catId && (!latest || attempt.requestedAt > latest.requestedAt) ? attempt : latest,
    undefined,
  );
}

function QueueTargetReceiptStatus({
  entry,
  catId,
  state,
  activeInvocationId,
  activeCarrierCapability,
  onRemind,
  isReminding,
}: {
  entry: QueueEntry;
  catId: string;
  state: keyof typeof TARGET_STATE_LABEL;
  activeInvocationId?: string;
  activeCarrierCapability?: FreshnessCarrierCapability;
  onRemind: (id: string, targetCatId: string) => void;
  isReminding: boolean;
}) {
  const reminderAttempts = entry.queueReceipt?.reminderAttempts ?? [];
  const latestReminder = latestReminderForTarget(entry, catId);
  const alreadyAttemptedInActiveTurn = activeInvocationId
    ? reminderAttempts.some((attempt) => attempt.targetCatId === catId && attempt.invocationId === activeInvocationId)
    : false;
  const canRemind =
    !!activeInvocationId &&
    classifyFreshnessCarrierSupport([activeCarrierCapability]) === 'exact' &&
    (state === 'queued' || state === 'notified') &&
    !alreadyAttemptedInActiveTurn;
  const targetReceipt = entry.queueReceipt?.targets.find((target) => target.catId === catId);
  const intentLabel = authorIntentLabel(targetReceipt?.authorIntent);
  const reminderCapabilityCopy = activeInvocationId
    ? unsupportedCarrierCopy(classifyFreshnessCarrierSupport([activeCarrierCapability]), '提醒')
    : undefined;

  return (
    <span
      className={`inline-flex items-center gap-1 ${
        state === 'seen' || state === 'awakened' ? 'text-conn-amber-text' : ''
      }`}
    >
      <span>{`${catId} · ${queueTargetStateLabel(entry, catId, state)}`}</span>
      {intentLabel && <span data-queue-author-intent>· {intentLabel}</span>}
      {targetReceipt?.authorIntent?.carrierCapability && (
        <span data-queue-carrier-capability>
          · {carrierCapabilityLabel(targetReceipt.authorIntent.carrierCapability)}
        </span>
      )}
      {latestReminder && <span>· {REMINDER_STATE_LABEL[latestReminder.state]}</span>}
      {reminderCapabilityCopy && (state === 'queued' || state === 'notified') && (
        <span className="text-conn-amber-text">· {reminderCapabilityCopy}</span>
      )}
      {canRemind && (
        <button
          type="button"
          data-testid={`remind-${entry.id}-${catId}`}
          disabled={isReminding}
          onClick={() => onRemind(entry.id, catId)}
          className="rounded-full border border-cafe px-1.5 py-px font-medium text-[var(--color-cocreator-primary)] hover:bg-cafe-surface disabled:cursor-wait disabled:opacity-60"
          title="不打断当前工作，在安全断点提醒猫读取这条消息"
        >
          {isReminding ? '请求中…' : '提醒猫'}
        </button>
      )}
    </span>
  );
}

export interface QueueEntryRowProps {
  entry: QueueEntry;
  index: number;
  isPaused: boolean;
  imageCount: number;
  ownerName: string;
  resolveCatName: (catId: string) => string;
  onRemove: (id: string) => void;
  onRecallEdit: (id: string) => void;
  onSteer: (id: string) => void;
  onRemind: (id: string, targetCatId: string) => void;
  activeInvocationIdByCatId: Readonly<Record<string, string>>;
  activeCarrierCapabilityByCatId: Readonly<Record<string, FreshnessCarrierCapability | undefined>>;
  remindingTargetKeys: ReadonlySet<string>;
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
  resolveCatName,
  onRemove,
  onRecallEdit,
  onSteer,
  onRemind,
  activeInvocationIdByCatId,
  activeCarrierCapabilityByCatId,
  remindingTargetKeys,
  dragHandleProps,
}: QueueEntryRowProps & { dragHandleProps?: Record<string, unknown> }) {
  const isAgent = entry.source === 'agent';
  const canRecallEdit = entry.source === 'user';
  const isUrgent = entry.priority === 'urgent';
  const categoryLabel = entry.sourceCategory ? SOURCE_CATEGORY_LABEL[entry.sourceCategory] : null;
  const rowToneClass = isPaused ? 'bg-conn-amber-bg/60' : isAgent ? 'bg-[var(--color-cocreator-surface)]' : '';

  const targetLabel = entry.targetCats[0] ? resolveCatName(entry.targetCats[0]) : '猫猫';
  const sourceLabel =
    isAgent && entry.sourceCategory === 'freshness'
      ? `Freshness → ${targetLabel}`
      : isAgent
        ? `${entry.callerCatId ? resolveCatName(entry.callerCatId) : '猫猫'} → ${targetLabel}`
        : entry.source === 'connector'
          ? 'Connector'
          : ownerName;

  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg ${rowToneClass}`}>
      {/* Drag handle */}
      <button
        className="p-0.5 text-cafe-muted hover:text-cafe-secondary cursor-grab active:cursor-grabbing shrink-0 touch-none"
        aria-label="Drag to reorder"
        {...dragHandleProps}
      >
        <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path d="M7 2a2 2 0 10.001 4.001A2 2 0 007 2zm0 6a2 2 0 10.001 4.001A2 2 0 007 8zm0 6a2 2 0 10.001 4.001A2 2 0 007 14zm6-8a2 2 0 10-.001-4.001A2 2 0 0013 6zm0 2a2 2 0 10.001 4.001A2 2 0 0013 8zm0 6a2 2 0 10.001 4.001A2 2 0 0013 14z" />
        </svg>
      </button>

      {/* Number + urgent indicator */}
      <span className="text-xs text-cafe-muted w-5 text-center shrink-0 relative">
        {isUrgent && <span className="absolute -left-1 top-0.5 w-1.5 h-1.5 rounded-full bg-conn-red-text" />}
        {index + 1}
      </span>

      {/* Content preview */}
      <div className="flex-1 min-w-0">
        <LongFormReader
          title={`排队消息 · ${sourceLabel}`}
          summary={entry.content}
          accessibleSummary={`排队消息，来源 ${sourceLabel}。完整内容请使用查看全文按钮。`}
          content={entry.content}
          format="markdown"
          density="compact"
        />
        <div className="flex items-center gap-1 mt-0.5">
          {isAgent ? (
            <svg className="w-2.5 h-2.5 text-[var(--color-cocreator-primary)]" viewBox="0 0 24 24" fill="currentColor">
              <path d="M4.5 11.5c-.28 0-.5-.22-.5-.5 0-1.93.76-3.74 2.13-5.1C7.5 4.52 9.31 3.76 11.24 3.76c.28 0 .5.22.5.5s-.22.5-.5.5c-1.66 0-3.22.65-4.4 1.82A6.18 6.18 0 005.02 11c0 .28-.22.5-.5.5zM8.02 20.25a1.25 1.25 0 01-1.18-1.63l1.12-3.36A4.01 4.01 0 014.1 11.5c0-2.2 1.79-3.99 3.99-3.99h7.82c2.2 0 3.99 1.79 3.99 3.99a4.01 4.01 0 01-3.86 3.76l1.12 3.36a1.25 1.25 0 01-1.18 1.63H8.02z" />
            </svg>
          ) : isUrgent ? (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-conn-red-text" />
          ) : (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-cocreator-primary)]" />
          )}
          <span
            className={`text-xs ${isAgent ? 'text-[var(--color-cocreator-primary)] font-medium' : isUrgent ? 'text-conn-red-text' : 'text-cafe-muted'}`}
          >
            {sourceLabel}
          </span>
          {categoryLabel && (
            <span
              className={`text-micro px-1 py-px rounded font-medium ${
                isUrgent ? 'bg-conn-red-bg text-conn-red-text' : 'text-[var(--color-cocreator-primary)]'
              }`}
              style={
                isUrgent
                  ? undefined
                  : { backgroundColor: 'color-mix(in oklch, var(--color-cocreator-primary) 15%, transparent)' }
              }
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
        {entry.targetStates && Object.keys(entry.targetStates).length > 0 && (
          <div className="flex flex-wrap gap-x-2 gap-y-0.5 mt-1 text-micro text-cafe-muted">
            {Object.entries(entry.targetStates).map(([catId, state]) => {
              const remindKey = `${entry.id}:${catId}`;
              return (
                <QueueTargetReceiptStatus
                  key={catId}
                  entry={entry}
                  catId={catId}
                  state={state}
                  activeInvocationId={activeInvocationIdByCatId[catId]}
                  activeCarrierCapability={activeCarrierCapabilityByCatId[catId]}
                  onRemind={onRemind}
                  isReminding={remindingTargetKeys.has(remindKey)}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Steer button */}
      <button
        type="button"
        data-testid={`steer-${entry.id}`}
        onClick={() => onSteer(entry.id)}
        className="text-xs px-3 py-1 rounded-full bg-[var(--color-cocreator-primary)] text-[var(--cafe-surface)] hover:opacity-90 transition-colors shrink-0"
        aria-label="Steer"
      >
        Steer
      </button>

      {canRecallEdit && (
        <button
          type="button"
          onClick={() => onRecallEdit(entry.id)}
          className="p-1 text-cafe-muted hover:text-cafe-primary hover:bg-cafe-surface rounded-full transition-colors shrink-0"
          title="撤回编辑"
          aria-label="撤回编辑"
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <title>撤回编辑</title>
            <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
          </svg>
        </button>
      )}

      {/* Remove button */}
      <button
        type="button"
        onClick={() => onRemove(entry.id)}
        className="p-1 text-cafe-muted hover:text-conn-red-text transition-colors shrink-0"
        title="撤出待处理（保留原消息）"
        aria-label="撤出待处理"
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
