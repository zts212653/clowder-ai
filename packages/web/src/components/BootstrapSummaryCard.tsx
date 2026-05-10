import type { ProjectSummary } from '@/hooks/useIndexState';
import { HubIcon } from './hub-icons';
import { MemoryIcon } from './icons/MemoryIcon';
import { SOURCE_TYPE_COLORS, SOURCE_TYPE_LABELS } from './memory/EvidenceSearch';

// Fallback labels for projects without evidence store (external projects show provenance tiers)
const TIER_LABELS: Record<string, string> = {
  authoritative: '核心',
  derived: '衍生',
  soft_clue: '线索',
};

const TIER_COLORS: Record<string, string> = {
  authoritative: 'bg-[var(--console-active-bg)] text-cafe-accent',
  derived: 'bg-[var(--color-cafe-accent)]/10 text-[var(--color-cafe-accent)]',
  soft_clue: 'bg-conn-emerald-bg text-conn-emerald-text',
};

interface BootstrapSummaryCardProps {
  summary: ProjectSummary;
  docsIndexed: number;
  durationMs?: number;
  onDismiss?: () => void;
  onSearchKnowledge?: () => void;
  onGoToMemoryHub?: () => void;
}

function CheckCircleIcon({ className = 'w-6 h-6' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <path d="M22 4L12 14.01l-3-3" />
    </svg>
  );
}

function FileTextIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
    </svg>
  );
}

function SearchIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </svg>
  );
}

export function BootstrapSummaryCard({
  summary,
  docsIndexed,
  durationMs,
  onDismiss,
  onSearchKnowledge,
  onGoToMemoryHub,
}: BootstrapSummaryCardProps) {
  const durationSec = durationMs ? Math.round(durationMs / 1000) : null;

  return (
    <div data-testid="bootstrap-summary-card" className="flex justify-center mb-3">
      <div className="max-w-[85%] w-full rounded-lg border border-conn-emerald-ring bg-conn-emerald-bg/50 p-5">
        <div className="flex items-center gap-4 mb-3">
          <div className="w-12 h-12 rounded-full bg-conn-emerald-bg flex items-center justify-center flex-shrink-0">
            <CheckCircleIcon className="w-6 h-6 text-conn-emerald-text" />
          </div>
          <div>
            <p className="text-sm font-medium text-conn-emerald-text">记忆索引构建完成</p>
            <p className="text-xs text-conn-emerald-text mt-0.5">猫猫现在可以搜索这个项目的历史知识了</p>
          </div>
        </div>

        <div className="ml-16 space-y-1.5 text-xs text-cafe-secondary">
          <p className="inline-flex items-center gap-1.5">
            <HubIcon name="folder" className="w-3.5 h-3.5 text-cafe-muted flex-shrink-0" />
            项目 &nbsp;<strong>{summary.projectName}</strong>
          </p>
          <p className="inline-flex items-center gap-1.5">
            <FileTextIcon className="w-3.5 h-3.5 text-cafe-muted flex-shrink-0" />
            已索引 {docsIndexed} 个文档
          </p>
          {durationSec !== null && (
            <p className="inline-flex items-center gap-1.5">
              <HubIcon name="timer" className="w-3.5 h-3.5 text-cafe-muted flex-shrink-0" />
              耗时 {durationSec} 秒
            </p>
          )}
        </div>

        {summary.kindCoverage && Object.keys(summary.kindCoverage).length > 0 ? (
          <div className="ml-16 mt-3">
            <p className="text-[10px] text-cafe-muted mb-1.5">知识覆盖</p>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(summary.kindCoverage).map(([kind, count]) => (
                <span
                  key={kind}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${SOURCE_TYPE_COLORS[kind] ?? 'bg-[var(--console-card-soft-bg)] text-cafe-secondary'}`}
                >
                  {SOURCE_TYPE_LABELS[kind] ?? kind} · {count}
                </span>
              ))}
            </div>
          </div>
        ) : Object.keys(summary.tierCoverage).length > 0 ? (
          <div className="ml-16 mt-3">
            <p className="text-[10px] text-cafe-muted mb-1.5">覆盖分层</p>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(summary.tierCoverage).map(([tier, count]) => (
                <span
                  key={tier}
                  className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${TIER_COLORS[tier] ?? 'bg-[var(--console-card-soft-bg)] text-cafe-secondary'}`}
                >
                  {TIER_LABELS[tier] ?? tier} · {count}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <div className="flex items-center gap-2 ml-16 mt-4">
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              className="px-3 py-1.5 rounded-lg text-xs text-cafe-secondary hover:text-cafe hover:bg-[var(--console-card-soft-bg)] transition-colors"
            >
              关闭
            </button>
          )}
          <button
            type="button"
            disabled={!onSearchKnowledge}
            onClick={onSearchKnowledge}
            className={
              onSearchKnowledge
                ? 'px-3 py-1.5 rounded-lg text-xs text-cafe-secondary hover:text-cafe hover:bg-[var(--console-card-soft-bg)] transition-colors inline-flex items-center gap-1'
                : 'px-3 py-1.5 rounded-lg text-xs text-cafe-muted cursor-not-allowed inline-flex items-center gap-1'
            }
          >
            <SearchIcon className="w-3.5 h-3.5" />
            搜索知识
          </button>
          <button
            type="button"
            disabled={!onGoToMemoryHub}
            onClick={onGoToMemoryHub}
            className={
              onGoToMemoryHub
                ? 'px-3 py-1.5 rounded-lg bg-[var(--color-conn-emerald-text)] hover:opacity-90 text-[var(--cafe-surface)] text-xs font-medium transition-colors inline-flex items-center gap-1'
                : 'px-3 py-1.5 rounded-lg bg-[var(--color-conn-emerald-text)]/50 text-[var(--cafe-surface)]/70 text-xs font-medium cursor-not-allowed inline-flex items-center gap-1'
            }
          >
            <MemoryIcon className="w-3.5 h-3.5" />
            前往记忆中心
          </button>
        </div>
      </div>
    </div>
  );
}
