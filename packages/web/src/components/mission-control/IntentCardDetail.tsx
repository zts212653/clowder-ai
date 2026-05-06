'use client';

import type { IntentCard, RiskSignal, SizeBand } from '@cat-cafe/shared';
import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { BucketBadge, SourceBadge } from './TriageBadge';

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

interface IntentCardDetailProps {
  card: IntentCard;
  onTriaged: (card: IntentCard) => void;
}

export function IntentCardDetail({ card, onTriaged }: IntentCardDetailProps) {
  const [clarity, setClarity] = useState<number>(card.triage?.clarity ?? 2);
  const [groundedness, setGroundedness] = useState<number>(card.triage?.groundedness ?? 2);
  const [necessity, setNecessity] = useState<number>(card.triage?.necessity ?? 2);
  const [coupling, setCoupling] = useState<number>(card.triage?.coupling ?? 2);
  const [sizeBand, setSizeBand] = useState<SizeBand>(card.triage?.sizeBand ?? 'M');
  const [submitting, setSubmitting] = useState(false);

  const handleTriage = async () => {
    setSubmitting(true);
    try {
      const res = await apiFetch(`/api/external-projects/${card.projectId}/intent-cards/${card.id}/triage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clarity, groundedness, necessity, coupling, sizeBand }),
      });
      if (res.ok) {
        const body = (await res.json()) as { card: IntentCard };
        onTriaged(body.card);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 text-xs">
      {/* Header */}
      <div className="flex items-center gap-2">
        <SourceBadge tag={card.sourceTag} />
        {card.triage && <BucketBadge bucket={card.triage.bucket} />}
        <span className="text-[10px] text-cafe-muted">{card.id}</span>
      </div>

      {/* Core slots */}
      <div className="space-y-2 rounded-lg bg-[var(--console-field-bg)] p-3">
        <SlotRow label="Actor" value={card.actor} />
        <SlotRow label="Context" value={card.contextTrigger} />
        <SlotRow label="Goal" value={card.goal} />
        <SlotRow label="Object State" value={card.objectState} />
        <SlotRow label="Success Signal" value={card.successSignal} />
        <SlotRow label="Non-goal" value={card.nonGoal} />
      </div>

      {/* Original text */}
      {card.originalText && (
        <div className="rounded-lg bg-[var(--console-field-bg)] p-3">
          <div className="mb-1 text-[10px] font-semibold uppercase text-cafe-muted">甲方原文</div>
          <div className="text-cafe">{card.originalText}</div>
        </div>
      )}

      {/* Risk signals */}
      {card.riskSignals.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] font-semibold uppercase text-cafe-muted">Risk Signals</div>
          <div className="flex flex-wrap gap-1">
            {card.riskSignals.map((signal) => (
              <span key={signal} className="rounded-full bg-conn-red-bg px-2 py-0.5 text-[10px] text-conn-red-text">
                {RISK_LABELS[signal]}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Triage form */}
      <div className="space-y-2 rounded-lg bg-[var(--console-field-bg)] p-3">
        <div className="text-[10px] font-semibold uppercase text-cafe-muted">Triage 评估</div>
        <ScoreSlider label="Clarity" value={clarity} onChange={setClarity} />
        <ScoreSlider label="Groundedness" value={groundedness} onChange={setGroundedness} />
        <ScoreSlider label="Necessity" value={necessity} onChange={setNecessity} />
        <ScoreSlider label="Coupling" value={coupling} onChange={setCoupling} />
        <div className="flex items-center gap-2">
          <span className="w-24 text-cafe-secondary">Size Band</span>
          <div className="flex gap-1">
            {(['S', 'M', 'L', 'XL'] as SizeBand[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSizeBand(s)}
                className={`rounded px-2 py-0.5 text-[10px] font-medium ${
                  sizeBand === s
                    ? 'bg-[var(--cafe-accent)] text-[var(--cafe-surface)]'
                    : 'bg-[var(--console-pill-bg)] text-cafe-secondary'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          onClick={() => void handleTriage()}
          disabled={submitting}
          className="mt-2 w-full rounded-lg bg-[var(--cafe-accent)] py-1.5 text-xs font-medium text-[var(--cafe-surface)] hover:bg-[var(--cafe-accent-hover,#7A6139)] disabled:opacity-40"
        >
          {submitting ? '评估中...' : '提交 Triage'}
        </button>
      </div>

      {/* Metadata */}
      <div className="space-y-1 text-cafe-muted">
        <div>Source: {card.sourceDetail || '—'}</div>
        <div>Decision Owner: {card.decisionOwner || '—'}</div>
        <div>Confidence: {card.confidence}/3</div>
      </div>
    </div>
  );
}

function SlotRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <span className="w-24 shrink-0 font-medium text-cafe-muted">{label}</span>
      <span className="text-cafe">{value || '—'}</span>
    </div>
  );
}

function ScoreSlider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-24 text-cafe-secondary">{label}</span>
      <div className="flex gap-1">
        {[1, 2, 3].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            className={`h-6 w-6 rounded text-[10px] font-medium ${
              value === n
                ? 'bg-[var(--cafe-accent)] text-[var(--cafe-surface)]'
                : 'bg-[var(--console-pill-bg)] text-cafe-secondary'
            }`}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}
