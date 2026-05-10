'use client';

import type { IntentCard, RiskSignal, SourceTag } from '@cat-cafe/shared';
import { useState } from 'react';
import { apiFetch } from '@/utils/api-client';

const RISK_SIGNALS: { value: RiskSignal; label: string }[] = [
  { value: 'hollow_verbs', label: '动词空心' },
  { value: 'missing_actors', label: '角色缺失' },
  { value: 'unknown_data_source', label: '数据源不明' },
  { value: 'missing_success_signal', label: '成功信号缺失' },
  { value: 'missing_edge_cases', label: '边界缺失' },
  { value: 'hidden_dependencies', label: '依赖隐藏' },
  { value: 'ai_fake_specificity', label: 'AI 假具体' },
  { value: 'scope_creep', label: '范围膨胀' },
];

interface CreateIntentCardFormProps {
  projectId: string;
  onCreated: (card: IntentCard) => void;
  onCancel: () => void;
}

export function CreateIntentCardForm({ projectId, onCreated, onCancel }: CreateIntentCardFormProps) {
  const [originalText, setOriginalText] = useState('');
  const [actor, setActor] = useState('');
  const [contextTrigger, setContextTrigger] = useState('');
  const [goal, setGoal] = useState('');
  const [objectState, setObjectState] = useState('');
  const [successSignal, setSuccessSignal] = useState('');
  const [nonGoal, setNonGoal] = useState('');
  const [sourceTag, setSourceTag] = useState<SourceTag>('A');
  const [sourceDetail, setSourceDetail] = useState('');
  const [decisionOwner, setDecisionOwner] = useState('');
  const [confidence, setConfidence] = useState<number>(2);
  const [riskSignals, setRiskSignals] = useState<RiskSignal[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleRisk = (signal: RiskSignal) => {
    setRiskSignals((prev) => (prev.includes(signal) ? prev.filter((s) => s !== signal) : [...prev, signal]));
  };

  const handleSubmit = async () => {
    if (!originalText.trim()) {
      setError('甲方原文不能为空');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/external-projects/${projectId}/intent-cards`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originalText,
          actor,
          contextTrigger,
          goal,
          objectState,
          successSignal,
          nonGoal,
          sourceTag,
          sourceDetail,
          decisionOwner,
          confidence,
          riskSignals,
        }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        throw new Error(body.error ?? `创建失败: ${res.status}`);
      }
      const body = (await res.json()) as { card: IntentCard };
      onCreated(body.card);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl bg-[var(--console-card-bg)] p-4 shadow-[0_12px_30px_rgba(43,33,26,0.08)]">
      <h3 className="text-sm font-bold text-cafe">新建 Intent Card</h3>

      {/* Original text */}
      <label className="block">
        <span className="text-xs font-medium text-cafe-secondary">甲方原文 *</span>
        <textarea
          value={originalText}
          onChange={(e) => setOriginalText(e.target.value)}
          rows={3}
          placeholder="粘贴 PRD 原文片段..."
          className="console-form-input mt-1 w-full text-xs"
        />
      </label>

      {/* Core slots */}
      <div className="grid grid-cols-2 gap-2">
        {[
          { label: 'Actor', value: actor, set: setActor, ph: '谁在操作？' },
          { label: 'Goal', value: goal, set: setGoal, ph: '想达成什么？' },
          { label: 'Context Trigger', value: contextTrigger, set: setContextTrigger, ph: '什么时候触发？' },
          { label: 'Object State', value: objectState, set: setObjectState, ph: '状态变化' },
          { label: 'Success Signal', value: successSignal, set: setSuccessSignal, ph: '怎么算成功？' },
          { label: 'Non-goal', value: nonGoal, set: setNonGoal, ph: '明确不做的' },
        ].map((f) => (
          <label key={f.label} className="block">
            <span className="text-[10px] font-medium text-cafe-muted">{f.label}</span>
            <input
              type="text"
              value={f.value}
              onChange={(e) => f.set(e.target.value)}
              placeholder={f.ph}
              className="console-form-input mt-0.5 w-full text-xs"
            />
          </label>
        ))}
      </div>

      {/* Source tag + metadata */}
      <div className="flex gap-2">
        <label className="block flex-1">
          <span className="text-[10px] font-medium text-cafe-muted">Source Tag</span>
          <select
            value={sourceTag}
            onChange={(e) => setSourceTag(e.target.value as SourceTag)}
            className="console-form-input mt-0.5 w-full text-xs"
          >
            <option value="Q">Q — 客户口述</option>
            <option value="O">O — 现场观察</option>
            <option value="D">D — 现有文档</option>
            <option value="R">R — 法规合同</option>
            <option value="A">A — AI 推断</option>
          </select>
        </label>
        <label className="block flex-1">
          <span className="text-[10px] font-medium text-cafe-muted">Confidence</span>
          <select
            value={confidence}
            onChange={(e) => setConfidence(Number(e.target.value))}
            className="console-form-input mt-0.5 w-full text-xs"
          >
            <option value={1}>1 — 低</option>
            <option value={2}>2 — 中</option>
            <option value={3}>3 — 高</option>
          </select>
        </label>
      </div>

      {/* Source detail + Decision owner */}
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-[10px] font-medium text-cafe-muted">Source Detail</span>
          <input
            type="text"
            value={sourceDetail}
            onChange={(e) => setSourceDetail(e.target.value)}
            placeholder="PRD section 3.2"
            className="console-form-input mt-0.5 w-full text-xs"
          />
        </label>
        <label className="block">
          <span className="text-[10px] font-medium text-cafe-muted">Decision Owner</span>
          <input
            type="text"
            value={decisionOwner}
            onChange={(e) => setDecisionOwner(e.target.value)}
            placeholder="Product Owner"
            className="console-form-input mt-0.5 w-full text-xs"
          />
        </label>
      </div>

      {/* Risk signals */}
      <div>
        <span className="text-[10px] font-medium text-cafe-muted">Risk Signals</span>
        <div className="mt-1 flex flex-wrap gap-1">
          {RISK_SIGNALS.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => toggleRisk(s.value)}
              className={`rounded-full px-2 py-0.5 text-[10px] ${
                riskSignals.includes(s.value)
                  ? 'bg-conn-red-bg text-conn-red-text'
                  : 'bg-[var(--console-pill-bg)] text-cafe-secondary'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-conn-red-ring bg-conn-red-bg px-3 py-1.5 text-xs text-conn-red-text">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="console-button-secondary">
          取消
        </button>
        <button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={submitting}
          className="console-button-primary disabled:opacity-40"
        >
          {submitting ? '创建中...' : '创建'}
        </button>
      </div>
    </div>
  );
}
