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
  contextDisplay: z
    .object({
      threadId: z.string(),
      handoff: z.object({ from: z.string(), time: z.string(), excerpt: z.string(), warning: z.boolean() }).optional(),
      sources: z.array(z.object({ type: z.string(), label: z.string(), ref: z.string() })),
      coverage: z.string(),
      detailsMarkdown: z.string(),
    })
    .optional(),
});

/** Keep the receipt visible; one disclosure reveals sources and diagnostics. */
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
  const fields = block.fields ?? [];
  const isContext = contextBriefing || block.meta?.kind === 'context_briefing';
  // Other briefing producers retain their original title, fields and body behavior.
  if (!isContext)
    return (
      <div className="min-w-0 max-w-full border-l-4 border-l-conn-blue-ring bg-conn-blue-bg rounded-r-lg [overflow-wrap:anywhere]">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-controls={detailsId}
          className="w-full min-w-0 flex items-start gap-2 px-3 py-2 text-left hover:bg-[var(--_info-50)] transition-colors rounded-r-lg"
          style={
            { '--_info-50': 'color-mix(in oklch, var(--semantic-info-surface) 50%, transparent)' } as CSSProperties
          }
        >
          <CafeIcon name="search" className="w-3.5 h-3.5 mt-0.5 text-conn-blue-text shrink-0" />
          <span className="min-w-0 flex-1 text-sm font-medium text-conn-blue-text">{block.title}</span>
          <span className="text-xs text-conn-blue-text shrink-0">{expanded ? '收起详情' : '查看详情'}</span>
        </button>
        {fields.length > 0 && (
          <dl className="min-w-0 px-3 pb-3 space-y-2 text-xs">
            {fields.map((field, index) => (
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
            {block.bodyMarkdown && (
              <MarkdownContent content={block.bodyMarkdown} className="!text-xs" disableCommandPrefix />
            )}
          </div>
        )}
      </div>
    );

  // Validate once at the persistence boundary. Old cards keep their complete raw content.
  const parsed = displayMetadata.safeParse(block.meta);
  const metadata = parsed.success ? parsed.data : {};
  const receiver = metadata.receiverDisplayName || metadata.receiverCatId;
  const display = metadata.contextDisplay;
  const handoff = display?.handoff;
  const source = display?.sources[0];
  const oldSource = fields.find((field) => field.label === '真相源')?.value;
  const excerpt = handoff?.excerpt.trim() ?? '';
  const sentence = excerpt.match(/^[^\n。！？]+[。！？]?/u)?.[0] ?? '';
  const readableExcerpt = sentence && !/(?:cat_cafe_|thread_owned_|threadId\s*[=:])/u.test(sentence);
  const sourceSummary = display ? source?.label : oldSource && !oldSource.startsWith('未定位') ? oldSource : '';
  const summary = readableExcerpt
    ? `${sentence.slice(0, 120)}${sentence.length > 120 ? '…' : ''}`
    : sourceSummary
      ? `依据：${sourceSummary}`
      : '未记录可用摘要；真相源尚未关联。';
  const coverage = display ? display.coverage : metadata.coverageSummary;
  const warning = handoff?.warning || fields.some((field) => field.label === '传球' && field.value.includes('⚠'));
  const navigation = fields.filter((field) => field.label === '传球' || field.label === '真相源');
  const diagnostics = fields.filter((field) => field.label !== '传球' && field.label !== '真相源');

  return (
    <div
      data-context-receipt
      className="min-w-0 max-w-full rounded-xl border border-l-[3px] p-3 sm:px-4 text-cafe-primary [overflow-wrap:anywhere]"
      style={{
        borderColor: 'color-mix(in oklab, var(--semantic-info) 22%, var(--cafe-border))',
        borderLeftColor: 'var(--semantic-info)',
        backgroundColor: 'color-mix(in oklab, var(--semantic-info) 5%, var(--bg-app))',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        aria-controls={detailsId}
        className="flex w-full min-w-0 items-center gap-2 text-left rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-500)]"
      >
        <CafeIcon name="search" className="w-4 h-4 shrink-0 text-[var(--semantic-info)]" />
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5">
          <span className="text-[11px] text-cafe-secondary">上下文交接 ·</span>
          <span className="text-sm font-medium">{receiver ? `给 ${receiver}` : '接收猫：未记录'}</span>
        </span>
        <span className="shrink-0 text-xs text-cafe-secondary">
          {expanded ? '收起' : '详情'} {expanded ? '⌃' : '⌄'}
        </span>
      </button>
      <p className="mt-2 text-[13px] leading-relaxed">{expanded && excerpt ? excerpt : summary}</p>
      <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-cafe-secondary">
        {handoff ? (
          <span>
            {handoff.from} · {handoff.time} 交接
          </span>
        ) : (
          <span>{display ? '交接来源未记录' : '旧卡交接记录见详情'}</span>
        )}
        {warning && (
          <span className="inline-flex items-center gap-1 text-cafe-primary">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--semantic-warning)]" />
            之前有“别动”指令
          </span>
        )}
      </p>
      {expanded && (
        <div id={detailsId} className="mt-3 border-t border-cafe-border pt-3 text-xs">
          <section aria-label="交接与依据" className="min-w-0">
            <h3 className="mb-2 text-[11px] font-medium text-cafe-secondary">交接与依据</h3>
            <dl className="space-y-2">
              {display ? (
                <>
                  <div className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2">
                    <dt className="text-cafe-secondary">交接</dt>
                    <dd>
                      {handoff ? `${handoff.from} → ${receiver || '接收猫未记录'} · ${handoff.time}` : '未记录交接来源'}
                    </dd>
                  </div>
                  {display.sources.length > 0 ? (
                    display.sources.map((item, index) => (
                      <div key={index} className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2">
                        <dt className="text-cafe-secondary">{index === 0 ? '真相源' : '依据'}</dt>
                        <dd className="min-w-0">
                          <span>{item.label}</span>
                          <span className="ml-1 text-cafe-secondary">[{item.type}]</span>
                          <span className="mt-0.5 block font-mono text-cafe-secondary">{item.ref}</span>
                        </dd>
                      </div>
                    ))
                  ) : (
                    <div className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2">
                      <dt className="text-cafe-secondary">真相源</dt>
                      <dd>尚未关联到明确依据</dd>
                    </div>
                  )}
                </>
              ) : (
                navigation.map((field, index) => (
                  <div key={index} className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2">
                    <dt className="text-cafe-secondary">{field.label}</dt>
                    <dd className="min-w-0">{field.value}</dd>
                  </div>
                ))
              )}
              <div className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2">
                <dt className="text-cafe-secondary">覆盖</dt>
                <dd>{coverage || '未记录'}</dd>
              </div>
            </dl>
            {display?.detailsMarkdown && (
              <div className="mt-3 min-w-0 [&_pre]:!whitespace-pre-wrap [&_pre]:max-w-full [&_code]:[overflow-wrap:anywhere]">
                <MarkdownContent content={display.detailsMarkdown} className="!text-xs" disableCommandPrefix />
              </div>
            )}
          </section>
          <section aria-label="诊断" className="mt-3 min-w-0 border-t border-cafe-border pt-3">
            <h3 className="mb-2 flex justify-between text-[11px] text-cafe-secondary">
              <span>诊断</span>
              <span>仅供核对</span>
            </h3>
            <dl className="space-y-2">
              {diagnostics.map((field, index) => (
                <div key={index} className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2">
                  <dt className="text-cafe-secondary">{field.label}</dt>
                  <dd className="min-w-0 font-mono">{field.value}</dd>
                </div>
              ))}
              {display && (
                <div className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2">
                  <dt className="text-cafe-secondary">会话</dt>
                  <dd className="min-w-0 font-mono">{display.threadId}</dd>
                </div>
              )}
            </dl>
            {fields.some((field) => field.label === '上下文' || field.label === '呈现') && (
              <p className="mt-2 text-cafe-secondary">
                cold 是上下文模式原码，不等于没有历史；T0/T1/T2 是证据来源等级，不表示任务完成。
              </p>
            )}
            {!display && (
              <div className="mt-3 min-w-0 [&_pre]:!whitespace-pre-wrap [&_pre]:max-w-full [&_code]:[overflow-wrap:anywhere]">
                <p className="mb-2">原始标题：{block.title}</p>
                {metadata.coverageDetails && <p className="mb-2">覆盖记录：{metadata.coverageDetails}</p>}
                {block.bodyMarkdown && (
                  <MarkdownContent content={block.bodyMarkdown} className="!text-xs" disableCommandPrefix />
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
