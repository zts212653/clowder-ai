'use client';

import { useId } from 'react';
import { CafeIcon } from './CafeIcons';

export type ReportingModeEditValue = 'none' | 'final-only' | 'state-transitions' | 'blocking-ack';

interface EditFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  multiline?: boolean;
}

export function EditField({ label, value, onChange, multiline }: EditFieldProps) {
  const inputId = useId();
  return (
    <label className="block" htmlFor={inputId}>
      <span className="text-cafe-muted">{label}:</span>{' '}
      {multiline ? (
        <textarea
          id={inputId}
          className="mt-0.5 w-full rounded border border-[var(--console-border-soft)] bg-cafe-surface-canvas p-1 font-mono text-xs"
          rows={2}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          id={inputId}
          type="text"
          className="mt-0.5 w-full rounded border border-[var(--console-border-soft)] bg-cafe-surface-canvas p-1 font-mono text-xs"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}

const REPORTING_MODE_OPTIONS: Array<{ value: ReportingModeEditValue; label: string }> = [
  { value: 'final-only', label: '做完回报一次（默认）' },
  { value: 'none', label: '下游自治，不强制回报' },
  { value: 'state-transitions', label: '阶段边界回报' },
  { value: 'blocking-ack', label: '阻塞点等源 thread ack' },
];

export function formatReportingMode(value: ReportingModeEditValue): string {
  if (value === 'none') return 'autonomous（下游自治，无强制回报）';
  if (value === 'state-transitions') return 'state-transitions（每阶段边界回报）';
  if (value === 'blocking-ack') return 'blocking-ack（遇阻塞点等 ack）';
  return 'final-only（默认 · 完成时回报一次）';
}

export function ReportingModeEdit({
  value,
  onChange,
}: {
  value: ReportingModeEditValue;
  onChange: (v: ReportingModeEditValue) => void;
}) {
  return (
    <label className="block">
      <span className="text-cafe-muted">回报模式:</span>{' '}
      <select
        aria-label="回报模式"
        className="mt-0.5 w-full rounded border border-[var(--console-border-soft)] bg-cafe-surface-canvas p-1 text-xs"
        value={value}
        onChange={(e) => onChange(e.target.value as ReportingModeEditValue)}
      >
        {REPORTING_MODE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ProjectPathEdit({
  value,
  onChange,
  existingProjects,
  defaultParent,
}: {
  value: string;
  onChange: (v: string) => void;
  existingProjects: string[];
  defaultParent: boolean;
}) {
  const selectValue = existingProjects.includes(value) ? value : '';
  return (
    <div className="space-y-1">
      {defaultParent && (
        <div className="rounded border border-[var(--semantic-warning)] bg-[var(--semantic-warning-surface)] px-2 py-1 text-xs text-cafe-secondary">
          这个子 thread 会进入未分类。请选择项目，或留空表示明确保留未分类。
        </div>
      )}
      {existingProjects.length > 0 && (
        <label className="block">
          <span className="text-cafe-muted">从已有项目选择:</span>{' '}
          <select
            aria-label="从已有项目选择"
            className="mt-0.5 w-full rounded border border-[var(--console-border-soft)] bg-cafe-surface-canvas p-1 font-mono text-xs"
            value={selectValue}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">手动输入 / 保留未分类</option>
            {existingProjects.map((project) => (
              <option key={project} value={project}>
                {project}
              </option>
            ))}
          </select>
        </label>
      )}
      <EditField
        label={defaultParent ? '项目归属 (绝对路径，留空=保留未分类)' : '项目归属 (绝对路径，留空=默认)'}
        value={value}
        onChange={onChange}
      />
    </div>
  );
}

// F225 猫猫化: 提议卡片标题图标 + 旧 📥 前缀剥离（从 ProposalCard.tsx 提取以守 350 行硬限）。
const LEGACY_PROPOSAL_TITLE_EMOJI = String.fromCodePoint(0x1f4e5);

/** 剥离后端旧卡片 title 的 📥 前缀（新格式无 📥，原样返回）；用于 ProposalCard 标题显示。 */
export function displayProposalTitle(title: string): string {
  return title.startsWith(LEGACY_PROPOSAL_TITLE_EMOJI)
    ? title.slice(LEGACY_PROPOSAL_TITLE_EMOJI.length).trimStart()
    : title;
}

/** 提议卡片标题图标：圆形蓝框 + inbox SVG（对齐 F225 交接卡的 icon 容器）。 */
export function ProposalCardIcon() {
  return (
    <span
      data-testid="proposal-card-icon"
      className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-conn-blue-ring bg-conn-blue-bg text-conn-blue-text"
    >
      <CafeIcon name="inbox" className="h-3 w-3" />
    </span>
  );
}
