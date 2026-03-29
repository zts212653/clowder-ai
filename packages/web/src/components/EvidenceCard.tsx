'use client';

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
    className: 'ring-1 ring-amber-400/30',
    badge: 'bg-amber-100 text-amber-700 border-amber-200 animate-pulse',
  },
  published: { label: '正式', className: '', badge: '' },
  archived: { label: '归档', className: 'grayscale-[0.5] opacity-60', badge: 'bg-gray-200 text-cafe-secondary' },
};

const CONFIDENCE_STYLES: Record<
  EvidenceConfidence,
  {
    bg: string;
    text: string;
    label: string;
  }
> = {
  high: { bg: 'bg-emerald-900/50', text: 'text-emerald-300', label: '高置信度' },
  mid: { bg: 'bg-amber-900/50', text: 'text-amber-300', label: '中置信度' },
  low: { bg: 'bg-slate-700', text: 'text-slate-400', label: '低置信度' },
};

export function EvidenceCard({ result }: { result: EvidenceResult }) {
  const source = SOURCE_CONFIG[result.sourceType];
  const conf = CONFIDENCE_STYLES[result.confidence];
  const status = result.status ? STATUS_CONFIG[result.status] : null;
  const Icon = source.icon;

  const snippet = result.snippet.length > 160 ? `${result.snippet.slice(0, 160)}...` : result.snippet;

  return (
    <div
      className={`flex gap-2.5 p-3 rounded-xl bg-slate-900/80 border border-slate-700 hover:border-slate-500 hover:shadow-sm transition-all duration-200 group relative ${status?.className ?? ''}`}
    >
      {/* Source type icon */}
      <div className="flex-shrink-0 mt-0.5">
        <div className="w-8 h-8 rounded-lg bg-slate-700 flex items-center justify-center text-slate-300 group-hover:scale-110 transition-transform">
          <Icon className="w-4 h-4" />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col gap-0.5 min-w-0">
            <h4
              className={`text-xs font-bold text-slate-100 leading-snug line-clamp-2 ${result.status === 'archived' ? 'line-through decoration-gray-400/50' : ''}`}
            >
              {result.title}
            </h4>
          </div>
          <div className="flex flex-col items-end gap-1 flex-shrink-0">
            <span
              className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wider ${conf.bg} ${conf.text}`}
            >
              {conf.label}
            </span>
            {status?.badge && (
              <span className={`text-[8px] font-black px-1 py-0.25 rounded border ${status.badge}`}>
                {status.label}
              </span>
            )}
          </div>
        </div>

        <p className="text-[11px] text-slate-400 leading-relaxed mt-1.5 line-clamp-2">{snippet}</p>

        <div className="flex items-center gap-2 mt-2 pt-2 border-t border-slate-700">
          <span className="text-[10px] text-slate-400 font-bold">{source.label}</span>
          <span className="text-[10px] text-cafe-muted">·</span>
          <span className="text-[10px] text-cafe-muted truncate font-mono opacity-70 italic">{result.anchor}</span>
        </div>
      </div>
    </div>
  );
}
