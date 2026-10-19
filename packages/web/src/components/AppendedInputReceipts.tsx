'use client';

import { useId, useState } from 'react';
import { AppTooltip } from '@/components/AppTooltip';
import { useMeasuredOverflow } from '@/components/content-overflow/useMeasuredOverflow';
import { ChevronIcon } from '@/components/hub-icons';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { useMessageNavigation } from '@/components/thread-chat/MessageNavigationContext';
import type { CatData } from '@/hooks/useCatData';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import {
  dispatchReadSummary,
  dispatchReadText,
  dispatchReceiptDisplay,
  dispatchReceiptLabel,
} from '@/lib/dispatch-receipt-display';
import { messageSenderThemeColor, resolveMessageSender } from '@/lib/resolve-sender';
import type { ChatMessage } from '@/stores/chat-types';
import styles from './AppendedInputReceipts.module.css';

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
  return dispatchReceiptDisplay(
    ref,
    lifecycle?.kind === 'response' && lifecycle.status === 'processing',
    source.lifecycle,
  );
}

/**
 * One appended input: a single line that expands in place when it is actually truncated (the F269
 * overflow rule shared with ExpandableProse), and a separate jump back to the original message.
 */
function AppendedInputRow({ source, label, expanded, onToggle, response, color }: AppendedInputRowProps) {
  const navigateToMessage = useMessageNavigation();
  const contentId = useId();
  const { ref, overflowing } = useMeasuredOverflow<HTMLSpanElement>({ axis: 'inline', active: !expanded });
  const content = source.content.trim() || '（无文字内容）';
  const read = appendedInputReadDisplay(source, response);
  const receiptLabel = dispatchReceiptLabel(read, label, 'appended_source');
  const canToggle = overflowing || expanded;
  return (
    <li data-appended-input-id={source.id} data-expanded={expanded ? 'true' : 'false'} className={styles.row}>
      <AppTooltip
        label={receiptLabel}
        detail={<span className="block max-h-[45vh] overflow-y-auto">{content}</span>}
        delayMs={1_000}
        multiline
        side="top"
      >
        <button
          type="button"
          aria-label={`${receiptLabel} · ${content}`}
          aria-expanded={canToggle ? expanded : undefined}
          aria-controls={canToggle ? contentId : undefined}
          data-append-delivery-state={read.state}
          className={`flex min-w-0 flex-1 gap-1.5 rounded text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-current ${expanded ? 'items-start' : 'h-7 items-center'} ${canToggle ? 'cursor-pointer' : 'cursor-default'}`}
          onClick={canToggle ? onToggle : undefined}
        >
          <span
            aria-hidden="true"
            style={{ backgroundColor: color }}
            className={`mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full ${expanded ? 'mt-1.5' : ''}`}
          />
          <span className="max-w-16 shrink-0 truncate font-medium sm:max-w-none">{label}:</span>
          <span
            id={contentId}
            ref={ref}
            data-overflow-measure="inline"
            className={expanded ? 'min-w-0 flex-1 whitespace-pre-wrap break-words' : 'min-w-0 flex-1 truncate'}
          >
            {content}
          </span>
        </button>
      </AppTooltip>
      <span
        data-append-read-status={read.state}
        className={`w-32 shrink-0 text-right text-label tabular-nums sm:w-36 ${read.state === 'unconfirmed' || read.state === 'unconfirmed_delivery' || read.state === 'unknown' ? 'text-conn-amber-text' : 'text-cafe-muted'}`}
      >
        {read.state === 'read' ? (
          <span aria-hidden="true" className="text-semantic-success">
            ✓{' '}
          </span>
        ) : read.state === 'pending' ? (
          <span aria-hidden="true">· </span>
        ) : null}
        {dispatchReadText(read, true)}
      </span>
      <button
        type="button"
        className="shrink-0 font-medium text-[var(--color-cocreator-primary)] hover:underline"
        onClick={() => navigateToMessage(source.id)}
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
  const classic = useShellPresentation() === 'classic';
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
  const collapsedHeight = `calc(var(--receipt-row-height) * ${COLLAPSED_VISIBLE_ROWS})`;
  const fadeStart = `calc(var(--receipt-row-height) * ${Math.floor(COLLAPSED_VISIBLE_ROWS)})`;

  return (
    <section
      data-testid="appended-input-receipts"
      aria-label="补充消息"
      className={`${styles.root} mt-2 border-t border-cafe px-1 pt-2 text-xs text-cafe-secondary`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-cafe-muted">
        <span className="font-semibold">补充消息 · {appendedInputs.length} 条</span>
        <span className="text-label">
          {dispatchReadSummary(appendedInputs.map((source) => appendedInputReadDisplay(source, response)))}
        </span>
      </div>
      <ol
        data-testid="appended-input-list"
        data-collapsed={collapsed ? 'true' : 'false'}
        className={`${styles.list} mt-1 overflow-hidden`}
        style={
          collapsed
            ? {
                maxHeight: collapsedHeight,
                WebkitMaskImage: `linear-gradient(to bottom, black 0, black ${fadeStart}, transparent ${collapsedHeight})`,
                maskImage: `linear-gradient(to bottom, black 0, black ${fadeStart}, transparent ${collapsedHeight})`,
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
              color={classic ? messageSenderThemeColor(source, sender, getCatById) : sender.color}
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
