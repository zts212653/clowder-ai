'use client';

import { useId, useState } from 'react';
import { AppTooltip } from '@/components/AppTooltip';
import { useMeasuredOverflow } from '@/components/content-overflow/useMeasuredOverflow';
import { ChevronIcon } from '@/components/hub-icons';
import type { CatData } from '@/hooks/useCatData';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { resolveMessageSender } from '@/lib/resolve-sender';
import type { ChatMessage } from '@/stores/chat-types';
import { focusLineageMessage } from '@/utils/focusLineageMessage';

const RECEIPT_ROW_HEIGHT_PX = 28;
const COLLAPSED_VISIBLE_ROWS = 3.5;
const COLLAPSED_FULL_ROWS = Math.floor(COLLAPSED_VISIBLE_ROWS);

export function projectAppendedInputReceipts(
  response: ChatMessage,
  timelineMessages: readonly ChatMessage[],
): readonly ChatMessage[] {
  if (
    response.lifecycle?.kind !== 'response' ||
    response.lifecycle.inputEntryIds.length < 2 ||
    response.lifecycle.inputMessageIds.length < 2
  ) {
    return [];
  }
  const startedAt = response.lifecycle.startedAt;
  const byId = new Map(timelineMessages.map((message) => [message.id, message]));
  return response.lifecycle.inputMessageIds.slice(1).flatMap((messageId) => {
    const source = byId.get(messageId);
    return source && source.timestamp > startedAt ? [source] : [];
  });
}

function formatReceiptTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const part = (value: number) => String(value).padStart(2, '0');
  return `${part(date.getMonth() + 1)}/${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}

interface AppendedInputRowProps {
  source: ChatMessage;
  label: string;
  expanded: boolean;
  onToggle: () => void;
  response: ChatMessage;
  color: string;
}

/** Only the exact delivered source × response can supply a read observation. */
export function appendedInputReadDisplay(source: ChatMessage, response: ChatMessage) {
  const lifecycle = response.lifecycle;
  const refs =
    lifecycle?.kind === 'response'
      ? (source.lifecycle?.dispatchRefs?.filter(
          (ref) => ref.targetId === lifecycle.targetId && ref.statusMessageId === response.id,
        ) ?? [])
      : [];
  const ref = refs.length === 1 ? refs[0] : undefined;
  const receipt = ref?.inputRead;
  const label =
    typeof ref?.dispatchedAt === 'number' && Number.isFinite(ref.dispatchedAt)
      ? `投递于: ${formatReceiptTimestamp(ref.dispatchedAt)}`
      : '已投递';
  if (receipt?.status === 'read')
    return {
      state: 'read',
      label: `读取于: ${formatReceiptTimestamp(receipt.at)}`,
      pulse: false,
    };
  if (!receipt) return { state: 'unavailable', label, pulse: false };
  const running = lifecycle?.kind === 'response' && lifecycle.status === 'processing';
  return {
    state: running ? 'pending' : 'unconfirmed',
    label: running ? label : `${label}（未确认读取）`,
    pulse: running,
  };
}

/**
 * One appended input: a single line that expands in place when it is actually truncated (the F269
 * overflow rule shared with ExpandableProse), and a separate jump back to the original message.
 */
function AppendedInputRow({ source, label, expanded, onToggle, response, color }: AppendedInputRowProps) {
  const contentId = useId();
  const { ref, overflowing } = useMeasuredOverflow<HTMLSpanElement>({ axis: 'inline', active: !expanded });
  const content = source.content.trim() || '（无文字内容）';
  const read = appendedInputReadDisplay(source, response);
  const canToggle = overflowing || expanded;
  return (
    <li
      data-appended-input-id={source.id}
      data-expanded={expanded ? 'true' : 'false'}
      className={expanded ? 'flex min-w-0 items-start gap-1.5 py-1' : 'flex h-7 min-w-0 items-center gap-1.5'}
    >
      <AppTooltip
        label={`${label} · ${read.label}`}
        detail={<span className="block max-h-[45vh] overflow-y-auto">{content}</span>}
        delayMs={1_000}
        multiline
        side="top"
      >
        <button
          type="button"
          aria-label={`${label} · ${read.label} · ${content}`}
          aria-expanded={canToggle ? expanded : undefined}
          aria-controls={canToggle ? contentId : undefined}
          data-append-delivery-state={read.state}
          className={`flex min-w-0 gap-1.5 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-current ${expanded ? 'flex-1 items-start' : 'h-7 items-center'} ${canToggle ? 'cursor-pointer' : 'cursor-default'}`}
          onClick={canToggle ? onToggle : undefined}
        >
          <span
            aria-hidden="true"
            style={{ backgroundColor: color }}
            className={`mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full ${expanded ? 'mt-1.5' : ''} ${read.pulse ? 'animate-pulse motion-reduce:animate-none' : ''}`}
          />
          <span className="shrink-0 font-medium">{label}:</span>
          <span
            id={contentId}
            ref={ref}
            data-overflow-measure="inline"
            className={
              expanded ? 'min-w-0 flex-1 whitespace-pre-wrap break-words' : 'w-72 max-w-[35vw] shrink truncate'
            }
          >
            {content}
          </span>
        </button>
      </AppTooltip>
      <button
        type="button"
        className="shrink-0 font-medium text-[var(--color-cocreator-primary)] hover:underline"
        onClick={() => focusLineageMessage(source.id)}
      >
        跳到原文
      </button>
    </li>
  );
}

interface AppendedInputReceiptsProps {
  response: ChatMessage;
  timelineMessages: readonly ChatMessage[];
  getCatById: (catId: string) => CatData | undefined;
}

export function AppendedInputReceipts({ response, timelineMessages, getCatById }: AppendedInputReceiptsProps) {
  const coCreator = useCoCreatorConfig();
  const [listExpanded, setListExpanded] = useState(false);
  const [expandedRowIds, setExpandedRowIds] = useState<ReadonlySet<string>>(() => new Set());
  const appendedInputs = projectAppendedInputReceipts(response, timelineMessages);
  if (appendedInputs.length === 0) return null;
  const renderedInputs = [...appendedInputs].reverse();
  const canExpand = renderedInputs.length > COLLAPSED_FULL_ROWS;
  const remainingCount = renderedInputs.length - COLLAPSED_FULL_ROWS;
  // An expanded row no longer fits the fixed 3.5-row clamp, so expanding one shows the whole list.
  const collapsed = canExpand && !listExpanded && expandedRowIds.size === 0;
  const toggleRow = (id: string) =>
    setExpandedRowIds((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const toggleList = () => {
    if (collapsed) {
      setListExpanded(true);
      return;
    }
    setListExpanded(false);
    setExpandedRowIds(new Set());
  };
  const collapsedHeight = RECEIPT_ROW_HEIGHT_PX * COLLAPSED_VISIBLE_ROWS;
  const fadeStart = RECEIPT_ROW_HEIGHT_PX * Math.floor(COLLAPSED_VISIBLE_ROWS);

  return (
    <section
      data-testid="appended-input-receipts"
      aria-label="补充消息"
      className="mt-2 border-t border-cafe px-1 pt-2 text-xs text-cafe-secondary"
    >
      <div className="font-semibold text-cafe-muted">补充消息</div>
      <ol
        data-testid="appended-input-list"
        data-collapsed={collapsed ? 'true' : 'false'}
        className="mt-1 overflow-hidden"
        style={
          collapsed
            ? {
                maxHeight: `${collapsedHeight}px`,
                WebkitMaskImage: `linear-gradient(to bottom, black 0, black ${fadeStart}px, transparent ${collapsedHeight}px)`,
                maskImage: `linear-gradient(to bottom, black 0, black ${fadeStart}px, transparent ${collapsedHeight}px)`,
              }
            : undefined
        }
      >
        {renderedInputs.map((source) => {
          const sender = resolveMessageSender(source, getCatById, coCreator);
          return (
            <AppendedInputRow
              key={source.id}
              source={source}
              response={response}
              color={sender.color}
              label={sender.label}
              expanded={expandedRowIds.has(source.id)}
              onToggle={() => toggleRow(source.id)}
            />
          );
        })}
      </ol>
      {canExpand && (
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `展开剩余 ${remainingCount} 条补充消息` : '收起补充消息'}
          className="mt-1 flex w-full items-center justify-center gap-1 font-medium text-cafe-muted hover:text-cafe-secondary"
          onClick={toggleList}
        >
          {!collapsed ? (
            <span aria-hidden="true" className="inline-flex rotate-180">
              <ChevronIcon expanded className="h-4 w-4" />
            </span>
          ) : (
            `展开剩余 ${remainingCount} 条`
          )}
        </button>
      )}
    </section>
  );
}
