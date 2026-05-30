'use client';

import { ExpandableText } from './ExpandableText';
import { CommitIcon, DecisionIcon, DiscussionIcon, PhaseIcon } from './icons/EvidenceIcons';

export type EvidenceConfidence = 'high' | 'mid' | 'low';
export type EvidenceSourceType = 'decision' | 'phase' | 'discussion' | 'commit';
export type EvidenceStatus = 'draft' | 'pending' | 'published' | 'archived';

export interface EvidenceResult {
  title: string;
  anchor: string;
  snippet: string;
  confidence: EvidenceConfidence;
  sourceType: EvidenceSourceType;
  status?: EvidenceStatus;
  authority?: string;
}

const SOURCE_CONFIG: Record<
  EvidenceSourceType,
  {
    icon: typeof DecisionIcon;
    label: string;
  }
> = {
  decision: { icon: DecisionIcon, label: '决策' },
  phase: { icon: PhaseIcon, label: '阶段' },
  discussion: { icon: DiscussionIcon, label: '讨论' },
  commit: { icon: CommitIcon, label: '提交' },
};

const STATUS_CONFIG: Record<
  EvidenceStatus,
  {
    label: string;
    className: string;
    badge?: string;
  }
> = {
  draft: {
    label: '草稿',
    className: 'border-dashed opacity-80',
    badge: 'bg-cafe-surface-elevated text-cafe-secondary border-cafe',
  },
  pending: {
    label: '待审',
    className: 'ring-1 ring-semantic-warning/30',
    badge: 'bg-semantic-warning-surface text-semantic-warning border-semantic-warning animate-pulse',
  },
  published: { label: '正式', className: '', badge: '' },
  archived: { label: '归档', className: 'grayscale-[0.5] opacity-60', badge: 'bg-conn-gray-bg text-cafe-secondary' },
};

const CONFIDENCE_STYLES: Record<
  EvidenceConfidence,
  {
    bg: string;
    text: string;
    label: string;
  }
> = {
  high: { bg: 'bg-semantic-success-surface', text: 'text-semantic-success', label: '高置信度' },
  mid: { bg: 'bg-semantic-warning-surface', text: 'text-semantic-warning', label: '中置信度' },
  low: { bg: 'bg-conn-slate-bg', text: 'text-conn-slate-text', label: '低置信度' },
};

export function EvidenceCard({ result }: { result: EvidenceResult }) {
  const source = SOURCE_CONFIG[result.sourceType];
  const conf = CONFIDENCE_STYLES[result.confidence];
  const status = result.status ? STATUS_CONFIG[result.status] : null;
  const Icon = source.icon;

  return (
    <div
      className={`flex gap-2.5 p-3 rounded-xl bg-cafe-surface-sunken/80 border border-[var(--console-border-soft)] hover:border-[var(--console-border-strong)] hover:shadow-sm transition-all duration-200 group relative ${status?.className ?? ''}`}
    >
      {/* Source type icon */}
      <div className="flex-shrink-0 mt-0.5">
        <div className="w-8 h-8 rounded-lg bg-cafe-surface-sunken flex items-center justify-center text-cafe-muted group-hover:scale-110 transition-transform">
          <Icon className="w-4 h-4" />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5 min-w-0">
            <ExpandableText
              text={result.title}
              as="h4"
              clampClass="line-clamp-2"
              className={`text-xs font-bold text-cafe leading-snug ${result.status === 'archived' ? 'line-through decoration-cafe-muted/50' : ''}`}
            />
          </div>
          <div className="flex flex-col items-end gap-1 flex-shrink-0">
            <span
              className={`text-micro font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wider ${conf.bg} ${conf.text}`}
            >
              {conf.label}
            </span>
            {status?.badge && (
              <span className={`text-micro font-black px-1 py-0.25 rounded border ${status.badge}`}>
                {status.label}
              </span>
            )}
          </div>
        </div>

        <ExpandableText
          text={result.snippet}
          as="p"
          clampClass="line-clamp-2"
          className="text-xs text-cafe-muted leading-relaxed mt-1.5"
        />

        <div className="flex items-center gap-2 mt-2 pt-2 border-t border-[var(--console-border-soft)]">
          <span className="text-micro text-cafe-muted font-bold">{source.label}</span>
          {result.authority && (
            <>
              <span className="text-micro text-cafe-muted">·</span>
              <span className="text-micro text-cafe-muted font-mono">{result.authority}</span>
            </>
          )}
          <span className="text-micro text-cafe-muted">·</span>
          <ExpandableText
            text={result.anchor}
            clampClass="truncate"
            className="text-micro text-cafe-muted font-mono opacity-70 italic"
          />
        </div>
      </div>
    </div>
  );
}
