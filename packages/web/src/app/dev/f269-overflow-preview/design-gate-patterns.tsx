'use client';

import type { ReactNode } from 'react';
import { CompactLabel, CriticalText, ExpandableProse, LongFormReader } from '@/components/content-overflow';
import {
  LegacyApprovalBaseline,
  LegacyFileBaseline,
  LegacySettingsBaseline,
  LegacyToolResultBaseline,
} from './legacy-baseline';
import { F269_TOOL_RESULT_FIXTURE, FILE_FIXTURE, SETTINGS_META, TOOL_EVENT } from './preview';

const APPROVAL_REASON =
  '这次调度会把现有数据源从本地索引切到云端召回；如果未先完成权限与脱敏检查，历史消息片段可能越过当前项目边界。请确认风险、回滚路径和验证责任人后再批准。';

const READER_SUMMARY = '工具结果包含完整审计记录、路径和尾部结论；列表只保留语义摘要，全文进入稳定阅读面。';
const QUEUE_READER_CONTENT =
  '✅ **CI 通过**\n\n这条排队消息包含完整的检查结果、后续动作和来源信息。密集列表只保留两行摘要，不在原位置铺开全文。\n\n阅读全文后仍可搜索、复制，并在关闭阅读面后回到原来的入口。';

export interface DesignPattern {
  id: 'compact-label' | 'expandable-prose' | 'long-form-reader' | 'critical-text';
  index: string;
  title: string;
  decision: string;
  ledgerRecordId: string;
  current: ReactNode;
  target: ReactNode;
}

function TargetFileCard() {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-cafe px-4 py-3">
      <span aria-hidden="true" className="text-xl">
        📄
      </span>
      <div className="min-w-0 flex-1">
        <CompactLabel label="文件名" value={FILE_FIXTURE.fileName} className="text-sm font-medium text-cafe" />
        <p className="mt-1 text-xs text-cafe-muted">8.0 MB · PDF</p>
      </div>
    </div>
  );
}

function TargetSettingsCard() {
  return (
    <div className="rounded-xl bg-[var(--console-card-bg)] px-4 py-3 shadow-[0_8px_22px_rgba(43,33,26,0.04)]">
      <h3 className="text-compact font-bold text-cafe">Memory semantic recall</h3>
      <ExpandableProse text={SETTINGS_META} lines={2} className="mt-1" />
    </div>
  );
}

function TargetStoryCard() {
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-cafe bg-cafe-surface-elevated p-4">
        <p className="text-xs font-semibold text-cafe-muted">cat_cafe_read_invocation_detail · completed</p>
        <LongFormReader
          title="完整工具结果"
          summary={READER_SUMMARY}
          content={F269_TOOL_RESULT_FIXTURE}
          format="plaintext"
          source={{ label: 'Invocation detail', href: '/workspace/invocations/inv_f269_visual_evidence' }}
          className="mt-2"
        />
      </div>
      <div className="rounded-xl border border-cafe bg-cafe-surface-elevated px-4 py-3">
        <p className="text-micro font-bold uppercase tracking-[0.1em] text-cafe-muted">密集列表模式</p>
        <LongFormReader
          title="排队消息全文"
          summary={QUEUE_READER_CONTENT}
          accessibleSummary="排队消息。完整内容请使用查看全文按钮。"
          content={QUEUE_READER_CONTENT}
          format="markdown"
          density="compact"
          className="mt-1"
        />
      </div>
    </div>
  );
}

function TargetApprovalCard() {
  return (
    <div className="rounded-lg border border-cafe p-3">
      <div className="flex items-center gap-2 text-xs">
        <span className="rounded-md bg-cafe-accent px-2 py-0.5 font-semibold text-[var(--cafe-accent-foreground)]">
          F128
        </span>
        <span className="text-cafe-muted">待审批</span>
      </div>
      <h3 className="mt-2 text-sm font-bold text-cafe">切换 Memory 召回数据源</h3>
      <CriticalText summary="批准前必须确认权限、脱敏与回滚路径。" details={APPROVAL_REASON} className="mt-3" />
      <div className="mt-3 flex gap-2">
        <button type="button" className="rounded-md bg-cafe-accent px-3 py-1.5 text-xs font-semibold text-white">
          批准
        </button>
        <button type="button" className="rounded-md border border-cafe px-3 py-1.5 text-xs font-semibold text-cafe">
          拒绝
        </button>
      </div>
    </div>
  );
}

export const DESIGN_PATTERNS: readonly DesignPattern[] = [
  {
    id: 'compact-label',
    index: '01',
    title: 'Compact Label · 紧凑标识',
    decision: '文件名、路径、ID 保持单行；仅真溢出时提供 focus/hover 全文与复制，不让元数据撑爆列表。',
    ledgerRecordId: 'css:packages/web/src/components/rich/FileBlock.tsx:71',
    current: <LegacyFileBaseline fileName={FILE_FIXTURE.fileName} />,
    target: <TargetFileCard />,
  },
  {
    id: 'expandable-prose',
    index: '02',
    title: 'Expandable Prose · 可展开短正文',
    decision: '描述、理由、摘要默认 2–4 行；只有尺寸实测发生溢出，才出现明确的“展开全文”。',
    ledgerRecordId: 'css:packages/web/src/components/settings/primitives/SettingsRow.tsx:82',
    current: <LegacySettingsBaseline title="Memory semantic recall" meta={SETTINGS_META} />,
    target: <TargetSettingsCard />,
  },
  {
    id: 'long-form-reader',
    index: '03',
    title: 'Long-form Reader · 长文阅读面',
    decision: '日志、Markdown、文章在列表显示语义摘要；密集列表用紧凑入口，全文在独立阅读面搜索、复制并返回原按钮。',
    ledgerRecordId: 'producer:web:story-tool-result',
    current: (
      <LegacyToolResultBaseline toolName={TOOL_EVENT.toolName ?? 'Unknown Tool'} content={F269_TOOL_RESULT_FIXTURE} />
    ),
    target: <TargetStoryCard />,
  },
  {
    id: 'critical-text',
    index: '04',
    title: 'Critical Text · 决策关键文本',
    decision: '错误、审批理由和校验依据不静默裁切；嵌入既有卡片时不再自带第二层面板，只有独立阻塞态才使用 panel。',
    ledgerRecordId: 'css:packages/web/src/components/ApprovalItemCard.tsx:145',
    current: <LegacyApprovalBaseline reason={APPROVAL_REASON} />,
    target: <TargetApprovalCard />,
  },
] as const;
