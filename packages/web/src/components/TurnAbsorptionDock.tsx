'use client';

import type { ChatMessage } from '@/stores/chat-types';
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
  const node = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(sourceMessageId)}"]`);
  if (!node) return;
  const enclosingDetails = node.closest('details');
  if (enclosingDetails) enclosingDetails.open = true;
  node.dataset.lineageFocus = 'true';
  node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  window.setTimeout(() => delete node.dataset.lineageFocus, 3200);
}

interface TurnAbsorptionDockProps {
  projection: TurnAbsorptionProjection;
  messages: readonly ChatMessage[];
  getCatLabel: (catId: string) => string;
}

export function TurnAbsorptionDock({ projection, messages, getCatLabel }: TurnAbsorptionDockProps) {
  const { counts } = projection;
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
          <span>{`${counts.completedWithTurn} 条随本轮完成`}</span>
          <span>{`${counts.actionable} 条仍待处理`}</span>
          <span>{`${counts.withdrawnAfterExposureUnhandled} 条已撤回（曾读取）`}</span>
        </div>
        <ol className="space-y-2">
          {projection.items.map((item) => (
            <li
              key={item.sourceMessageId}
              data-turn-absorption-source={item.sourceMessageId}
              data-turn-absorption-kind={item.kind}
              className="rounded-md bg-cafe-surface/55 px-2 py-1.5"
            >
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium">{KIND_LABEL[item.kind]}</span>
                <span className="text-cafe-muted">{getCatLabel(item.catId)}</span>
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
              {item.recalled && <div className="mt-1 text-micro text-cafe-muted">正文已撤回</div>}
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}
