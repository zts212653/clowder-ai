'use client';

import type { ChatMessage } from '@/stores/chat-types';
import { revealFoldedSourceAnchor } from '@/utils/folded-source-navigation';
import { resolveMessageElements } from '@/utils/scrollToMessage';
import { CollapsibleMarkdown } from './CollapsibleMarkdown';
import { ContentBlocks } from './ContentBlocks';
import { focusInvocationLineage } from './MessageReceiptDock';
import type { TurnAbsorptionItem, TurnAbsorptionProjection } from './turn-absorption-summary';

const KIND_LABEL: Record<TurnAbsorptionItem['kind'], string> = {
  responded: '明确回应',
  completed_with_turn: '随本轮完成',
  actionable: '仍待处理',
  withdrawn_after_exposure: '已撤回（曾读取）',
};

function focusSourceMessage(sourceMessageId: string): void {
  if (typeof document === 'undefined') return;
  const node = resolveMessageElements([sourceMessageId])[0];
  if (!node) return;
  revealFoldedSourceAnchor(node);
  const enclosingDetails = node.closest('details');
  if (enclosingDetails) enclosingDetails.open = true;
  node.dataset.lineageFocus = 'true';
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  window.setTimeout(() => delete node.dataset.lineageFocus, 3200);
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function handlerStatus(item: TurnAbsorptionItem, getCatLabel: (catId: string) => string): string {
  const verb =
    item.kind === 'actionable' || (item.kind === 'completed_with_turn' && item.receiptScope === 'cross_thread_delivery')
      ? '读取'
      : item.kind === 'withdrawn_after_exposure'
        ? '记录'
        : '处理';
  return `由 ${getCatLabel(item.handlerCatId)}${verb}`;
}

function outcomeStatus(item: TurnAbsorptionItem): string {
  const terminalMark = item.kind === 'responded' || item.kind === 'completed_with_turn' ? '✓ ' : '';
  const timestamp = typeof item.outcomeAt === 'number' ? ` · ${formatClock(item.outcomeAt)}` : '';
  const label =
    item.kind === 'completed_with_turn' && item.receiptScope === 'cross_thread_delivery'
      ? '正文已由本轮消费'
      : KIND_LABEL[item.kind];
  return `${terminalMark}${label}${timestamp}`;
}

interface TurnAbsorptionDockProps {
  projection: TurnAbsorptionProjection;
  messages: readonly ChatMessage[];
  getCatLabel: (catId: string) => string;
  sourceAuthorLabel: string;
}

export function TurnAbsorptionDock({ projection, messages, getCatLabel, sourceAuthorLabel }: TurnAbsorptionDockProps) {
  const { counts } = projection;
  const crossThreadConsumed = projection.items.filter(
    (item) => item.kind === 'completed_with_turn' && item.receiptScope === 'cross_thread_delivery',
  ).length;
  const sameThreadCompletedWithTurn = counts.completedWithTurn - crossThreadConsumed;
  return (
    <details
      open={projection.defaultExpanded}
      data-testid="turn-absorption-dock"
      data-turn-absorption-invocation={projection.invocationId}
      className="mt-3 border-t border-cafe pt-2 text-xs text-cafe-secondary"
    >
      <summary className="cursor-pointer select-none font-medium text-cafe-muted">
        {`本轮处理了 ${counts.handled}/${counts.total} 条补充`}
      </summary>
      <div className="mt-1.5 ml-1 border-l-2 border-cafe pl-3">
        <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-micro text-cafe-muted">
          <span>{`${counts.responded} 条明确回应`}</span>
          {sameThreadCompletedWithTurn > 0 && <span>{`${sameThreadCompletedWithTurn} 条随本轮完成`}</span>}
          {crossThreadConsumed > 0 && <span>{`${crossThreadConsumed} 条跨线程正文已消费`}</span>}
          <span>{`${counts.actionable} 条仍待处理`}</span>
          <span>{`${counts.withdrawnAfterExposureUnhandled} 条已撤回（曾读取）`}</span>
        </div>
        <ol className="space-y-2">
          {projection.items.map((item) => (
            <li
              key={item.sourceMessageId}
              data-turn-absorption-source={item.sourceMessageId}
              data-turn-absorption-kind={item.kind}
              data-turn-absorption-scope={item.receiptScope}
              className="rounded-md bg-cafe-surface/55 px-2 py-1.5"
            >
              <div className="flex flex-wrap items-center gap-x-1 text-cafe-secondary" data-source-author>
                <span className="font-semibold">{sourceAuthorLabel}</span>
                <span className="text-cafe-muted">· {formatClock(item.sourceTimestamp)}</span>
              </div>
              {item.bodyProjectedHere && item.contentBlocks?.length ? (
                <div className="mt-1.5">
                  <ContentBlocks blocks={item.contentBlocks} />
                </div>
              ) : item.bodyProjectedHere && item.content.trim() ? (
                <CollapsibleMarkdown
                  content={item.content}
                  className="mt-1.5"
                  disclosureKey={`turn-absorption:${projection.invocationId}:${item.sourceMessageId}`}
                />
              ) : null}
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-cafe-muted">
                <span className="font-medium" data-turn-absorption-status>
                  {outcomeStatus(item)}
                </span>
                <span>{handlerStatus(item, getCatLabel)}</span>
                <button
                  type="button"
                  className="font-medium text-[var(--color-cocreator-primary)] hover:underline"
                  onClick={() => focusSourceMessage(item.sourceMessageId)}
                >
                  定位原消息 ↑
                </button>
                <button
                  type="button"
                  className="font-medium text-[var(--color-cocreator-primary)] hover:underline"
                  onClick={() => focusInvocationLineage(messages, item.invocationId)}
                >
                  本轮链路 ↑
                </button>
              </div>
              {item.recalled && <div className="mt-1 text-micro text-cafe-muted">正文已撤回</div>}
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}
