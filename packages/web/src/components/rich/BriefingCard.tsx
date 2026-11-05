'use client';

import { type CSSProperties, useId, useState } from 'react';
import { z } from 'zod';
import { MarkdownContent } from '@/components/MarkdownContent';
import type { RichBlock } from '@/stores/chat-types';
import { CafeIcon } from './CafeIcons';

const displayMetadata = z.object({
  receiverDisplayName: z.string().trim().optional(),
  receiverCatId: z.string().trim().optional(),
  coverageSummary: z.string().optional(),
  coverageDetails: z.string().optional(),
});

/** A human summary stays visible; raw navigation and runtime details remain inspectable. */
export function BriefingCard({
  block,
  contextBriefing = false,
}: {
  block: RichBlock;
  messageId?: string;
  contextBriefing?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  if (block.kind !== 'card') return null;

  const isContext = contextBriefing || block.meta?.kind === 'context_briefing';
  // Metadata is an untyped persistence boundary; validate its display values once here.
  const metadata = displayMetadata.safeParse(block.meta);
  const { receiverDisplayName, receiverCatId, coverageSummary, coverageDetails } = metadata.success
    ? metadata.data
    : {};
  const receiver = receiverDisplayName || receiverCatId;
  const fields = block.fields ?? [];
  const navigation = fields
    .filter((field) => field.label === '传球' || field.label === '真相源')
    .map((field) => {
      if (field.label === '真相源')
        return { label: field.label, value: field.value.startsWith('未定位') ? '尚未关联到明确依据' : field.value };
      return {
        label: '交接记录',
        value:
          field.value === '直接 @'
            ? '未记录交接来源'
            : field.value.replace(/→\s*你(?=[\s(（]|$)/u, `→ ${receiver || '接收猫'}`),
      };
    });
  const visibleFields = isContext ? (expanded ? navigation : []) : fields;

  return (
    <div className="min-w-0 max-w-full border-l-4 border-l-conn-blue-ring bg-conn-blue-bg rounded-r-lg [overflow-wrap:anywhere]">
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={detailsId}
        className="w-full min-w-0 flex items-start gap-2 px-3 py-2 text-left hover:bg-[var(--_info-50)] transition-colors rounded-r-lg"
        style={{ '--_info-50': 'color-mix(in oklch, var(--semantic-info-surface) 50%, transparent)' } as CSSProperties}
      >
        <CafeIcon name="search" className="w-3.5 h-3.5 mt-0.5 text-conn-blue-text shrink-0" />
        <span className="min-w-0 flex-1 text-sm font-medium text-conn-blue-text">
          {isContext ? '上下文交接' : block.title}
        </span>
        <span className="text-xs text-conn-blue-text shrink-0">{expanded ? '收起详情' : '查看详情'}</span>
      </button>

      {isContext && (
        <div className="min-w-0 px-3 pb-3 text-xs text-cafe-secondary space-y-1">
          <p>本次提供给猫的背景与查阅入口</p>
          <p>接收猫：{receiver || '未记录'}</p>
          {coverageSummary && <p>{coverageSummary}</p>}
        </div>
      )}

      {visibleFields.length > 0 && (
        <dl className="min-w-0 px-3 pb-3 space-y-2 text-xs">
          {visibleFields.map((field, index) => (
            <div key={index} className="min-w-0">
              <dt className="text-conn-blue-text font-medium">{field.label}</dt>
              <dd className="text-cafe-secondary mt-0.5">{field.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {expanded && (
        <div
          id={detailsId}
          className="min-w-0 px-3 pb-3 pt-2 border-t border-conn-blue-ring/50 text-xs text-cafe-secondary"
        >
          {isContext ? (
            <details className="min-w-0">
              <summary className="cursor-pointer text-conn-blue-text font-medium">诊断详情</summary>
              <p className="mt-2">原始交接记录、给猫的检索提示与运行信息，仅供核对和排查。</p>
              <p className="mt-1">上下文模式与 T0/T1/T2 等证据等级计数不表示任务是否完成。</p>
              <p className="mt-2">原始摘要：{block.title}</p>
              {coverageDetails && <p className="mt-2">覆盖详情：{coverageDetails}</p>}
              <dl className="min-w-0 mt-2 space-y-2">
                {fields.map((field, index) => (
                  <div key={index} className="min-w-0">
                    <dt className="font-medium">{field.label}</dt>
                    <dd className="min-w-0 mt-0.5 font-mono">{field.value}</dd>
                  </div>
                ))}
              </dl>
              {block.bodyMarkdown && (
                <div className="min-w-0 mt-3 [&_.markdown-content]:text-xs [&_pre]:whitespace-pre-wrap [&_code]:[overflow-wrap:anywhere] [&_p]:mb-1">
                  <MarkdownContent content={block.bodyMarkdown} className="!text-xs" disableCommandPrefix />
                </div>
              )}
            </details>
          ) : (
            block.bodyMarkdown && (
              <MarkdownContent content={block.bodyMarkdown} className="!text-xs" disableCommandPrefix />
            )
          )}
        </div>
      )}
    </div>
  );
}
