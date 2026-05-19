'use client';

import type { IntentCard, RiskSignal } from '@cat-cafe/shared';
import { useCallback, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

const RISK_LABELS: Record<RiskSignal, string> = {
  hollow_verbs: '动词空心',
  missing_actors: '角色缺失',
  unknown_data_source: '数据源不明',
  missing_success_signal: '成功信号缺失',
  missing_edge_cases: '边界缺失',
  hidden_dependencies: '依赖隐藏',
  ai_fake_specificity: 'AI 假具体',
  scope_creep: '范围膨胀',
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: '#C05A38',
  high: '#E4A853',
  medium: '#8B8B8B',
};

interface RiskSummary {
  signals: Record<string, number>;
  totalCards: number;
  cardsWithRisks: number;
}

interface RiskPanelProps {
  projectId: string;
  cards: IntentCard[];
}

export function RiskPanel({ projectId, cards }: RiskPanelProps) {
  const [detecting, setDetecting] = useState(false);
  const [summary, setSummary] = useState<RiskSummary | null>(null);
  const [detectedCards, setDetectedCards] = useState<IntentCard[]>([]);

  const runDetection = useCallback(async () => {
    setDetecting(true);
    try {
      // Run detection for all cards in parallel
      await Promise.allSettled(
        cards.map((card) =>
          apiFetch(`/api/external-projects/${projectId}/intent-cards/${card.id}/detect-risks`, {
            method: 'POST',
          }),
        ),
      );
      // Fetch summary
      const summaryRes = await apiFetch(`/api/external-projects/${projectId}/risk-summary`);
      if (summaryRes.ok) {
        const body = (await summaryRes.json()) as RiskSummary;
        setSummary(body);
      }
      // Reload cards to get updated riskSignals
      const cardsRes = await apiFetch(`/api/external-projects/${projectId}/intent-cards`);
      if (cardsRes.ok) {
        const body = (await cardsRes.json()) as { cards: IntentCard[] };
        setDetectedCards(body.cards.filter((c) => c.riskSignals.length > 0));
      }
    } finally {
      setDetecting(false);
    }
  }, [projectId, cards]);

  const signalsByType = new Map<string, IntentCard[]>();
  for (const card of detectedCards) {
    for (const signal of card.riskSignals) {
      const list = signalsByType.get(signal) ?? [];
      list.push(card);
      signalsByType.set(signal, list);
    }
  }

  function severityFor(signal: string): string {
    if (signal === 'scope_creep' || signal === 'hidden_dependencies') return 'critical';
    if (signal === 'hollow_verbs' || signal === 'missing_actors' || signal === 'ai_fake_specificity') return 'high';
    return 'medium';
  }

  return (
    <div className="space-y-4">
      {/* Header + Run button */}
      <div className="flex items-center justify-between rounded-lg border border-[#E7DAC7] bg-[#FFFDF8] px-4 py-3">
        <div>
          <div className="text-sm font-semibold text-[#2B2118]">風險預警</div>
          <div className="text-[10px] text-[#9A866F]">对全部 Intent Cards 运行风险检测</div>
        </div>
        <button
          type="button"
          onClick={() => void runDetection()}
          disabled={detecting || cards.length === 0}
          className="rounded-lg bg-[#8B6F47] px-4 py-1.5 text-xs font-medium text-white hover:bg-[#7A6139] disabled:opacity-40"
        >
          {detecting ? '检测中...' : 'Run Detection'}
        </button>
      </div>

      {/* Summary stats */}
      {summary && (
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-[#E7DAC7] bg-[#FFFDF8] p-3 text-center">
            <div className="text-lg font-bold text-[#2B2118]">{summary.totalCards}</div>
            <div className="text-[10px] font-medium text-[#9A866F]">Total Cards</div>
          </div>
          <div className="rounded-lg border border-[#E7DAC7] bg-[#FFFDF8] p-3 text-center">
            <div className="text-lg font-bold text-[#C05A38]">{summary.cardsWithRisks}</div>
            <div className="text-[10px] font-medium text-[#9A866F]">Cards w/ Risks</div>
          </div>
          <div className="rounded-lg border border-[#E7DAC7] bg-[#FFFDF8] p-3 text-center">
            <div className="text-lg font-bold text-[#2B2118]">
              {Object.values(summary.signals).reduce((a, b) => a + b, 0)}
            </div>
            <div className="text-[10px] font-medium text-[#9A866F]">Total Signals</div>
          </div>
        </div>
      )}

      {/* Cards grouped by signal type */}
      {[...signalsByType.entries()].map(([signal, signalCards]) => {
        const severity = severityFor(signal);
        return (
          <div key={signal} className="rounded-lg border border-[#E7DAC7] bg-[#FFFDF8] p-3">
            <div className="mb-2 flex items-center gap-2">
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
                style={{ backgroundColor: SEVERITY_COLORS[severity] }}
              >
                {severity}
              </span>
              <span className="text-xs font-semibold text-[#2B2118]">
                {RISK_LABELS[signal as RiskSignal] ?? signal.replace(/_/g, ' ')}
              </span>
              <span className="text-[10px] text-[#9A866F]">({signalCards.length})</span>
            </div>
            <div className="space-y-1">
              {signalCards.map((card) => (
                <div key={card.id} className="flex items-center gap-2 rounded bg-[#F4EFE7] px-2 py-1 text-xs">
                  <span className="shrink-0 font-mono text-[10px] text-[#8B6F47]">{card.id.slice(0, 8)}</span>
                  <span className="truncate text-[#2B2118]">{card.goal || '—'}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {/* Empty state */}
      {!summary && !detecting && (
        <div className="rounded-lg border border-dashed border-[#D8C6AD] bg-[#FBF7F0] p-6 text-center text-xs text-[#9A866F]">
          点击 &ldquo;Run Detection&rdquo; 开始风险检测
        </div>
      )}
    </div>
  );
}
