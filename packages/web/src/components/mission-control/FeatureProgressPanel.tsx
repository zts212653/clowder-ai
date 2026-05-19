'use client';

import type { FeatureDocDetail, FeatureDocPhase } from '@cat-cafe/shared';
import { useState } from 'react';

interface FeatureProgressPanelProps {
  detail: FeatureDocDetail;
}

export function FeatureProgressPanel({ detail }: FeatureProgressPanelProps) {
  const [expandedPhase, setExpandedPhase] = useState<string | null>(null);

  if (detail.phases.length === 0) {
    return (
      <p className="text-xs text-[#B5A48E]" data-testid="mc-progress-empty">
        Feature doc 中暂无 Phase 结构
      </p>
    );
  }

  return (
    <div className="space-y-3" data-testid="mc-progress-panel">
      <p className="text-xs font-bold uppercase tracking-wider text-[#9A866F]">Phase 进度</p>
      {detail.phases.map((phase) => (
        <PhaseRow
          key={phase.id}
          phase={phase}
          expanded={expandedPhase === phase.id}
          onToggle={() => setExpandedPhase(expandedPhase === phase.id ? null : phase.id)}
        />
      ))}
      {detail.risks.length > 0 && (
        <div className="mt-2">
          <p className="mb-1 text-xs font-bold uppercase tracking-wider text-[#9A866F]">风险</p>
          <div className="space-y-1">
            {detail.risks.map((r, i) => (
              <div key={`risk-${i}`} className="flex gap-2 text-xs">
                <span className="text-[#B45A5A]">• {r.risk}</span>
                <span className="text-[#9A866F]">→ {r.mitigation}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PhaseRow({ phase, expanded, onToggle }: { phase: FeatureDocPhase; expanded: boolean; onToggle: () => void }) {
  const total = phase.acs.length;
  const done = phase.acs.filter((ac) => ac.done).length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const barColor = pct === 100 ? 'bg-[#7CB87C]' : pct > 0 ? 'bg-[#5B9BD5]' : 'bg-[#C4B5A0]';
  const pctColor = pct === 100 ? 'text-[#7CB87C]' : pct > 0 ? 'text-[#5B9BD5]' : 'text-[#C4B5A0]';

  return (
    <div data-testid={`mc-phase-${phase.id}`}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-2 text-left"
        data-testid={`mc-phase-toggle-${phase.id}`}
      >
        <span className="w-[60px] shrink-0 text-xs font-medium text-[#6E5A46]">Phase {phase.id}</span>
        <div className="h-[6px] flex-1 overflow-hidden rounded-full bg-[#E7DAC7]">
          <div className={`h-full rounded-full ${barColor} transition-all`} style={{ width: `${pct}%` }} />
        </div>
        <span className={`w-[36px] shrink-0 text-right font-mono text-xs font-medium ${pctColor}`}>
          {total > 0 ? `${pct}%` : '—'}
        </span>
        <span className="shrink-0 text-[10px] text-[#C4B5A0]">{expanded ? '▼' : '▸'}</span>
      </button>
      {expanded && total > 0 && (
        <div className="ml-[68px] mt-1 space-y-0.5" data-testid={`mc-phase-acs-${phase.id}`}>
          <p className="mb-1 text-[10px] font-medium text-[#8B7864]">{phase.name}</p>
          {phase.acs.map((ac) => (
            <div key={ac.id} className="flex items-center gap-1.5 text-xs">
              {ac.done ? (
                <svg
                  className="h-3.5 w-3.5 shrink-0 text-[#7CB87C]"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                  <polyline points="22 4 12 14.01 9 11.01" />
                </svg>
              ) : (
                <span className="h-3.5 w-3.5 shrink-0 rounded-full border-[1.5px] border-[#C4B5A0]" />
              )}
              <span className={ac.done ? 'text-[#9A866F] line-through' : 'text-[#4B3A2A]'}>
                {ac.id}: {ac.text}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
